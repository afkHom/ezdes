import http.client
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.data = root / "data"
        cls.data.mkdir()
        (root / "secret.csv").write_text("outside the data folder")

        now = time.time()
        for name, age in [("old.csv", 300), ("new plan é.xlsx", 100), ("notes.txt", 0), ("~$new plan é.xlsx", 0)]:
            path = cls.data / name
            path.write_bytes(name.encode())
            os.utime(path, (now - age, now - age))

        cls.httpd = server.make_server("127.0.0.1", 0, cls.data)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def get(self, path):
        try:
            with urllib.request.urlopen(self.base + path) as r:
                return r.status, r.read(), r.headers
        except urllib.error.HTTPError as e:
            return e.code, e.read(), e.headers

    def test_lists_workbooks_newest_first_without_lock_files(self):
        status, body, _ = self.get("/api/files")
        self.assertEqual(status, 200)
        names = [f["name"] for f in json.loads(body)["files"]]
        self.assertEqual(names, ["new plan é.xlsx", "old.csv"])

    def test_downloads_listed_workbook(self):
        status, body, headers = self.get("/api/files/" + urllib.request.quote("new plan é.xlsx"))
        self.assertEqual(status, 200)
        self.assertEqual(body, "new plan é.xlsx".encode())
        self.assertIn("filename*=UTF-8''", headers["Content-Disposition"])

    def test_rejects_paths_outside_data_folder(self):
        for name in ["../secret.csv", "..%2Fsecret.csv", "%2E%2E%2Fsecret.csv", "notes.txt", "~$new plan é.xlsx"]:
            status, _, _ = self.get("/api/files/" + urllib.request.quote(name, safe="%"))
            self.assertEqual(status, 404, name)

    def test_serves_app_but_not_server_source(self):
        self.assertEqual(self.get("/")[0], 200)
        self.assertEqual(self.get("/engine.js")[0], 200)
        self.assertEqual(self.get("/server.py")[0], 404)
        self.assertEqual(self.get("/../server.py")[0], 404)

    def test_health(self):
        self.assertEqual(self.get("/api/health")[0], 200)

    def request_with_host(self, path, host):
        conn = http.client.HTTPConnection("127.0.0.1", self.httpd.server_address[1], timeout=5)
        try:
            conn.putrequest("GET", path, skip_host=True)
            conn.putheader("Host", host)
            conn.endheaders()
            response = conn.getresponse()
            return response.status, response.read()
        finally:
            conn.close()

    def test_refuses_foreign_host_names(self):
        # A DNS-rebinding page arrives with the attacker's own host name.
        for host in ["evil.example.com", "evil.example.com:8765", "attacker.net."]:
            self.assertEqual(self.request_with_host("/api/files", host)[0], 403, host)
            self.assertEqual(self.request_with_host("/", host)[0], 403, host)
        for host in ["localhost:8765", "127.0.0.1", "[::1]:8765", "192.168.1.20:8765", "zima.local", "zima", "fe80::1"]:
            self.assertEqual(self.request_with_host("/api/health", host)[0], 200, host)

    def test_extra_allowed_hosts(self):
        self.assertTrue(server.host_allowed("planner.company.lan:8765", server.parse_hosts("planner.company.lan, other.lan")))
        self.assertFalse(server.host_allowed("planner.company.lan", frozenset()))
        self.assertFalse(server.host_allowed(None))
        self.assertFalse(server.host_allowed(""))

    def test_security_headers_and_no_folder_listing(self):
        status, _, headers = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
        self.assertEqual(headers["X-Frame-Options"], "DENY")
        self.assertEqual(self.get("/vendor/")[0], 404)

    def test_workbook_download_is_not_cached(self):
        _, _, headers = self.get("/api/files/" + urllib.request.quote("new plan é.xlsx"))
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_symlinks_in_data_folder_are_ignored(self):
        link = self.data / "linked.csv"
        try:
            os.symlink(Path(self.tmp.name) / "secret.csv", link)
        except (OSError, NotImplementedError) as error:
            self.skipTest(f"cannot create symlinks here: {error}")
        try:
            names = [f["name"] for f in json.loads(self.get("/api/files")[1])["files"]]
            self.assertNotIn("linked.csv", names)
            self.assertEqual(self.get("/api/files/linked.csv")[0], 404)
        finally:
            link.unlink()

    def test_files_api_absent_without_data_dir(self):
        httpd = server.make_server("127.0.0.1", 0, None)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            url = f"http://127.0.0.1:{httpd.server_address[1]}/api/files"
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(url)
            self.assertEqual(ctx.exception.code, 404)
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main()
