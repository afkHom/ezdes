from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from datetime import datetime, timezone
import json
import os
import threading
import uuid
import webbrowser

ROOT = Path(__file__).resolve().parent
EXTENSIONS = {'.xlsx', '.xls', '.csv'}
PORT = int(os.getenv('EZDES_PORT', '8765'))
HOST = os.getenv('EZDES_HOST', '0.0.0.0')
STATE_DIR = Path(os.getenv('EZDES_STATE_DIR', str(ROOT / 'state')))
SPEED_TRACKER_FILE = STATE_DIR / 'speed-tracker.json'
SPEED_TRACKER_LOCK = threading.Lock()
LEARNING_FILE = STATE_DIR / 'production-learning.json'
LEARNING_LOCK = threading.Lock()

def read_speed_entries():
    if not SPEED_TRACKER_FILE.exists():
        return []
    payload = json.loads(SPEED_TRACKER_FILE.read_text(encoding='utf-8'))
    entries = payload.get('entries', [])
    if not isinstance(entries, list):
        raise ValueError('The speed tracker file is invalid.')
    return entries

def write_speed_entries(entries):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    temporary = SPEED_TRACKER_FILE.with_suffix('.tmp')
    temporary.write_text(json.dumps({'version': 1, 'entries': entries}, indent=2), encoding='utf-8')
    os.replace(temporary, SPEED_TRACKER_FILE)

def read_learning_data():
    if not LEARNING_FILE.exists():
        return {'version': 1, 'observations': [], 'decisions': {}}
    payload = json.loads(LEARNING_FILE.read_text(encoding='utf-8'))
    observations = payload.get('observations', [])
    decisions = payload.get('decisions', {})
    if not isinstance(observations, list) or not isinstance(decisions, dict):
        raise ValueError('The production-learning file is invalid.')
    return {'version': 1, 'observations': observations, 'decisions': decisions}

def write_learning_data(payload):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    temporary = LEARNING_FILE.with_suffix('.tmp')
    temporary.write_text(json.dumps({
        'version': 1,
        'observations': payload.get('observations', []),
        'decisions': payload.get('decisions', {}),
    }, indent=2), encoding='utf-8')
    os.replace(temporary, LEARNING_FILE)

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        if urlparse(self.path).path.endswith('.html'):
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def send_json(self, payload, status=HTTPStatus.OK):
        data = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        request = urlparse(self.path)
        if request.path == '/api/speed-tracker':
            try:
                with SPEED_TRACKER_LOCK:
                    entries = read_speed_entries()
                return self.send_json({'storage': 'shared', 'entries': entries})
            except (OSError, ValueError, json.JSONDecodeError) as error:
                return self.send_json({'error': str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
        if request.path == '/api/learning':
            try:
                with LEARNING_LOCK:
                    payload = read_learning_data()
                return self.send_json({'storage': 'shared', **payload})
            except (OSError, ValueError, json.JSONDecodeError) as error:
                return self.send_json({'error': str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
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

    def do_POST(self):
        request = urlparse(self.path)
        if request.path == '/api/learning':
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if length < 1 or length > 65536:
                    raise ValueError('Invalid request size.')
                incoming = json.loads(self.rfile.read(length).decode('utf-8'))
                if not isinstance(incoming, dict):
                    raise ValueError('Invalid production-learning request.')
                action = str(incoming.get('action') or 'observation').strip().lower()
                with LEARNING_LOCK:
                    payload = read_learning_data()
                    if action == 'observation':
                        outcome = str(incoming.get('outcome') or 'good').strip().lower()
                        if outcome not in {'good', 'adjusted', 'problem'}:
                            raise ValueError('Choose a valid run result.')
                        observation = {
                            'id': str(incoming.get('id') or uuid.uuid4())[:80],
                            'tn': str(incoming.get('tn') or '').strip()[:100],
                            'woGroup': str(incoming.get('woGroup') or '').strip()[:100],
                            'copperweight': str(incoming.get('copperweight') or '').strip()[:50],
                            'plannedSpeed': str(incoming.get('plannedSpeed') or '').strip()[:30],
                            'actualSpeed': str(incoming.get('actualSpeed') or '').strip()[:30],
                            'cores': str(incoming.get('cores') or '').strip()[:30],
                            'actualMinutes': str(incoming.get('actualMinutes') or '').strip()[:30],
                            'outcome': outcome,
                            'notes': str(incoming.get('notes') or '').strip()[:2000],
                            'recordedAt': datetime.now(timezone.utc).isoformat(),
                        }
                        if not observation['tn']:
                            raise ValueError('Tool number is required.')
                        if not observation['copperweight']:
                            raise ValueError('Copperweight is required.')
                        if not observation['actualSpeed']:
                            raise ValueError('Actual stable speed is required.')
                        payload['observations'] = [
                            observation,
                            *[item for item in payload['observations'] if item.get('id') != observation['id']],
                        ]
                    elif action == 'decision':
                        key = str(incoming.get('key') or '').strip()[:300]
                        status = str(incoming.get('status') or '').strip().lower()
                        if not key or status not in {'approved', 'rejected', 'pending'}:
                            raise ValueError('A recommendation key and valid decision are required.')
                        if status == 'pending':
                            payload['decisions'].pop(key, None)
                        else:
                            payload['decisions'][key] = {
                                'status': status,
                                'decidedAt': datetime.now(timezone.utc).isoformat(),
                            }
                    else:
                        raise ValueError('Unknown production-learning action.')
                    write_learning_data(payload)
                return self.send_json({'storage': 'shared', **payload})
            except (OSError, ValueError, json.JSONDecodeError) as error:
                return self.send_json({'error': str(error)}, HTTPStatus.BAD_REQUEST)
        if request.path != '/api/speed-tracker':
            return self.send_error(HTTPStatus.NOT_FOUND)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length < 1 or length > 65536:
                raise ValueError('Invalid request size.')
            incoming = json.loads(self.rfile.read(length).decode('utf-8'))
            if not isinstance(incoming, dict):
                raise ValueError('Invalid tracker entry.')
            entry = {
                'id': str(incoming.get('id') or uuid.uuid4())[:80],
                'woGroup': str(incoming.get('woGroup') or '').strip()[:100],
                'tn': str(incoming.get('tn') or '').strip()[:100],
                'copperweight': str(incoming.get('copperweight') or '').strip()[:50],
                'normalSpeed': str(incoming.get('normalSpeed') or '').strip()[:30],
                'adjustedSpeed': str(incoming.get('adjustedSpeed') or '').strip()[:30],
                'reason': str(incoming.get('reason') or '').strip()[:300],
                'notes': str(incoming.get('notes') or '').strip()[:2000],
                'updatedAt': datetime.now(timezone.utc).isoformat(),
            }
            if not entry['tn']:
                raise ValueError('Tool number is required.')
            if not entry['adjustedSpeed']:
                raise ValueError('Adjusted speed is required.')
            with SPEED_TRACKER_LOCK:
                entries = read_speed_entries()
                tool_key = entry['tn'].casefold()
                existing = next((
                    item for item in entries
                    if item.get('id') == entry['id']
                    or str(item.get('tn') or '').strip().casefold() == tool_key
                ), None)
                if existing:
                    entry['id'] = str(existing.get('id') or entry['id'])
                entry['createdAt'] = existing.get('createdAt', entry['updatedAt']) if existing else entry['updatedAt']
                entries = [
                    item for item in entries
                    if item.get('id') != entry['id']
                    and str(item.get('tn') or '').strip().casefold() != tool_key
                ]
                entries.insert(0, entry)
                write_speed_entries(entries)
            return self.send_json({'storage': 'shared', 'entry': entry, 'entries': entries})
        except (OSError, ValueError, json.JSONDecodeError) as error:
            return self.send_json({'error': str(error)}, HTTPStatus.BAD_REQUEST)

    def do_DELETE(self):
        request = urlparse(self.path)
        if request.path == '/api/learning':
            entry_id = parse_qs(request.query).get('id', [''])[0]
            if not entry_id:
                return self.send_json({'error': 'Observation id is required.'}, HTTPStatus.BAD_REQUEST)
            try:
                with LEARNING_LOCK:
                    payload = read_learning_data()
                    updated = [item for item in payload['observations'] if item.get('id') != entry_id]
                    if len(updated) == len(payload['observations']):
                        return self.send_json({'error': 'Observation was not found.'}, HTTPStatus.NOT_FOUND)
                    payload['observations'] = updated
                    write_learning_data(payload)
                return self.send_json({'storage': 'shared', **payload})
            except (OSError, ValueError, json.JSONDecodeError) as error:
                return self.send_json({'error': str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)
        if request.path != '/api/speed-tracker':
            return self.send_error(HTTPStatus.NOT_FOUND)
        entry_id = parse_qs(request.query).get('id', [''])[0]
        if not entry_id:
            return self.send_json({'error': 'Entry id is required.'}, HTTPStatus.BAD_REQUEST)
        try:
            with SPEED_TRACKER_LOCK:
                entries = read_speed_entries()
                updated = [item for item in entries if item.get('id') != entry_id]
                if len(updated) == len(entries):
                    return self.send_json({'error': 'Tracker entry was not found.'}, HTTPStatus.NOT_FOUND)
                write_speed_entries(updated)
            return self.send_json({'storage': 'shared', 'entries': updated})
        except (OSError, ValueError, json.JSONDecodeError) as error:
            return self.send_json({'error': str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)

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
