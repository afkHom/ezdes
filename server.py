"""EZDES server.

Serves the web app from ./web and, when a data folder is configured, lets the page list and
download workbooks from that one folder. Nothing outside the folder is reachable: the browser
never sends a filesystem path, only the name of a file the server itself listed.

Configuration (environment variable or command-line flag):
  EZDES_DATA_DIR / --data-dir   folder holding the workbooks (optional)
  EZDES_HOST     / --host       default 127.0.0.1; use 0.0.0.0 to serve the LAN (Docker does)
  EZDES_PORT     / --port       default 8765
  EZDES_OPEN_BROWSER / --no-browser
  EZDES_ALLOWED_HOSTS / --allowed-hosts
                 extra host names the page may be opened under (comma-separated), e.g.
                 planner.company.lan. localhost, IP addresses, single-word names and *.local
                 names are always allowed. Anything else is refused, which stops DNS-rebinding
                 attacks: a web page on another site cannot reach this server through its own name.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import shutil
import webbrowser
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

WEB_ROOT = Path(__file__).resolve().parent / "web"
WORKBOOK_EXTENSIONS = {".xlsx", ".xlsm", ".xls", ".csv"}
MAX_WORKBOOK_BYTES = 50 * 1024 * 1024
REQUEST_TIMEOUT_SECONDS = 30

# The page needs nothing from other sites and never needs to be framed.
SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; "
        "form-action 'self'; frame-ancestors 'none'"
    ),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
}


def list_workbooks(data_dir: Path) -> list[dict]:
    """Workbooks directly inside data_dir, newest first.

    Skips Excel's "~$name.xlsx" lock files and other hidden files: while someone has a workbook
    open, its lock file is the newest .xlsx in the folder and is not a readable workbook.
    """
    files = []
    for entry in os.scandir(data_dir):
        if entry.name.startswith(("~$", ".")):
            continue
        # Links are never followed: a link dropped into a shared folder could otherwise point at
        # any file the server can read.
        if entry.is_symlink() or getattr(entry, "is_junction", lambda: False)() or not entry.is_file(follow_symlinks=False):
            continue
        if Path(entry.name).suffix.lower() not in WORKBOOK_EXTENSIONS:
            continue
        stat = entry.stat()
        files.append({"name": entry.name, "size": stat.st_size, "modified": stat.st_mtime})
    files.sort(key=lambda f: f["modified"], reverse=True)
    return files


def resolve_workbook(data_dir: Path, name: str) -> Path | None:
    """Returns the workbook path only if `name` is one of the files list_workbooks would return."""
    if not name or name != Path(name).name:
        return None
    if name not in {f["name"] for f in list_workbooks(data_dir)}:
        return None
    target = data_dir / name
    # Belt and braces: the real location must still be directly inside the data folder.
    if Path(os.path.realpath(target)).parent != Path(os.path.realpath(data_dir)):
        return None
    return target


def host_allowed(host_header: str | None, extra: frozenset[str] = frozenset()) -> bool:
    """True when the Host header names this machine in a way an outside site can't control."""
    if not host_header:
        return False
    host = host_header.strip().lower()
    if host.startswith("["):  # [::1]:8765
        host = host[1:host.find("]")] if "]" in host else host[1:]
    elif host.count(":") == 1:  # name:8765 (a bare IPv6 address has several colons)
        host = host.split(":", 1)[0]
    host = host.rstrip(".")
    if not host:
        return False
    if host in extra:
        return True
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        pass
    return host == "localhost" or host.endswith((".localhost", ".local")) or "." not in host


class Handler(SimpleHTTPRequestHandler):
    # A client that opens a connection and goes quiet is dropped instead of holding a thread forever.
    timeout = REQUEST_TIMEOUT_SECONDS

    def __init__(self, *args, data_dir: Path | None, allowed_hosts: frozenset[str] = frozenset(), **kwargs):
        self.data_dir = data_dir
        self.allowed_hosts = allowed_hosts
        self.cache_control = "no-cache"
        super().__init__(*args, directory=str(WEB_ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", self.cache_control)
        for name, value in SECURITY_HEADERS.items():
            self.send_header(name, value)
        super().end_headers()

    def list_directory(self, path):
        # No folder listings: only the app's own files are served.
        self.send_error(HTTPStatus.NOT_FOUND)
        return None

    def check_host(self) -> bool:
        if host_allowed(self.headers.get("Host"), self.allowed_hosts):
            return True
        self.send_json(HTTPStatus.FORBIDDEN, {
            "error": "This host name is not allowed. Add it to EZDES_ALLOWED_HOSTS (or --allowed-hosts) on the server.",
        })
        return False

    def do_HEAD(self):
        if not self.check_host():
            return None
        if urlparse(self.path).path.startswith("/api/"):
            return self.send_json(HTTPStatus.METHOD_NOT_ALLOWED, {"error": "Use GET."})
        return super().do_HEAD()

    def send_json(self, status: HTTPStatus, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.check_host():
            return None
        path = urlparse(self.path).path
        if path == "/api/health":
            return self.send_json(HTTPStatus.OK, {"ok": True})
        if path == "/api/files" or path.startswith("/api/files/"):
            if self.data_dir is None:
                return self.send_json(HTTPStatus.NOT_FOUND, {"error": "No data folder is configured."})
            if path == "/api/files":
                return self.list_files()
            return self.send_workbook(unquote(path[len("/api/files/"):]))
        if path.startswith("/api/"):
            return self.send_json(HTTPStatus.NOT_FOUND, {"error": "Unknown endpoint."})
        return super().do_GET()

    def list_files(self):
        try:
            files = list_workbooks(self.data_dir)
        except OSError as error:
            return self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": f"Cannot read data folder: {error.strerror}"})
        return self.send_json(HTTPStatus.OK, {"files": files})

    def send_workbook(self, name: str):
        try:
            target = resolve_workbook(self.data_dir, name)
            if target is None:
                return self.send_json(HTTPStatus.NOT_FOUND, {"error": "That workbook is not in the data folder."})
            handle = open(target, "rb")
        except OSError as error:
            return self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": f"Cannot read workbook: {error.strerror}"})
        with handle:
            size = os.fstat(handle.fileno()).st_size
            if size > MAX_WORKBOOK_BYTES:
                return self.send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "Workbook is larger than 50 MB."})
            # Order data shouldn't linger in the browser cache of a shared PC.
            self.cache_control = "no-store"
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(name)}")
            self.end_headers()
            # Streamed in chunks, so a few large downloads at once can't exhaust memory.
            shutil.copyfileobj(handle, self.wfile, 64 * 1024)


def parse_hosts(value: str | None) -> frozenset[str]:
    return frozenset(h.strip().lower().rstrip(".") for h in (value or "").split(",") if h.strip())


def make_server(host: str, port: int, data_dir: Path | None, allowed_hosts: frozenset[str] = frozenset()) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), partial(Handler, data_dir=data_dir, allowed_hosts=allowed_hosts))
    server.daemon_threads = True
    return server


def parse_args(argv=None):
    env = os.environ
    parser = argparse.ArgumentParser(description="Run the EZDES production planner.")
    parser.add_argument("--host", default=env.get("EZDES_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(env.get("EZDES_PORT", "8765")))
    parser.add_argument("--data-dir", default=env.get("EZDES_DATA_DIR") or None)
    parser.add_argument("--no-browser", action="store_true", default=env.get("EZDES_OPEN_BROWSER", "1") == "0")
    parser.add_argument("--allowed-hosts", default=env.get("EZDES_ALLOWED_HOSTS", ""))
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    data_dir = Path(args.data_dir).resolve() if args.data_dir else None
    if data_dir is not None and not data_dir.is_dir():
        raise SystemExit(f"EZDES_DATA_DIR is not a folder: {data_dir}")

    server = make_server(args.host, args.port, data_dir, parse_hosts(args.allowed_hosts))
    url = f"http://localhost:{server.server_address[1]}/"
    print(f"EZDES running at {url}")
    print(f"Data folder: {data_dir or 'not configured (file upload only)'}")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
