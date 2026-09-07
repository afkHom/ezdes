from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import os
import webbrowser

ROOT = Path(__file__).resolve().parent
EXTENSIONS = {'.xlsx', '.xls', '.csv'}
PORT = int(os.getenv('EZDES_PORT', '8765'))
HOST = os.getenv('EZDES_HOST', '0.0.0.0')

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        request = urlparse(self.path)
        if request.path != '/latest':
            return super().do_GET()
        folder = Path(parse_qs(request.query).get('directory', [''])[0])
        if not folder.is_dir():
            return self.send_error(HTTPStatus.BAD_REQUEST, 'Choose a valid folder path.')
        try:
            latest = max((item for item in folder.iterdir() if item.is_file() and item.suffix.lower() in EXTENSIONS), key=lambda item: item.stat().st_mtime)
            data = latest.read_bytes()
        except ValueError:
            return self.send_error(HTTPStatus.NOT_FOUND, 'No Excel files were found in that folder.')
        except OSError as error:
            return self.send_error(HTTPStatus.FORBIDDEN, str(error))
        self.send_response(HTTPStatus.OK)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('X-EZDES-Filename', latest.name)
        self.send_header('X-EZDES-Modified', str(int(latest.stat().st_mtime * 1000)))
        self.end_headers()
        self.wfile.write(data)

server = ThreadingHTTPServer((HOST, PORT), Handler)
url = f'http://localhost:{PORT}/copper-speed-organizer.html'
print(f'EZDES is running at {url}')
if os.getenv('EZDES_OPEN_BROWSER', '1') == '1':
    webbrowser.open(url)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()