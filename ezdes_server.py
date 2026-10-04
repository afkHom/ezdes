"""Local EZDES server: restricted files, validated records, atomic approvals."""
from contextlib import contextmanager
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
import base64
import hmac
import ipaddress
import json
import math
import os
import sqlite3
import statistics
import uuid
import webbrowser

ROOT = Path(__file__).resolve().parent
EXTENSIONS = {'.xlsx', '.xls', '.csv'}
ASSETS = {'copper-speed-organizer.html', 'ezdes-core.js', 'schedule-viewer.css',
          'schedule-viewer.js', 'learning-center.css', 'learning-center.js'}
PORT = int(os.getenv('EZDES_PORT', '8765'))
HOST = os.getenv('EZDES_HOST', '127.0.0.1')
PASSWORD = os.getenv('EZDES_PASSWORD', '')
USERNAME = os.getenv('EZDES_USER', 'ezdes')
STATE_DIR = Path(os.getenv('EZDES_STATE_DIR', str(ROOT / 'state')))
DATA_DIR = Path(os.getenv('EZDES_DATA_DIR', str(ROOT / 'data'))).resolve()


def now():
    return datetime.now(timezone.utc).isoformat()


def normalized(value):
    return str(value or '').strip().lower()


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def read_document(db, key):
    return json.loads(db.execute('SELECT value FROM documents WHERE key=?', (key,)).fetchone()[0])


def put_document(db, key, value):
    db.execute('INSERT OR REPLACE INTO documents(key,value) VALUES (?,?)', (key, dumps(value)))


@contextmanager
def transaction():
    """One transaction covers both history and tracker; never a half approval."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(STATE_DIR / 'ezdes.sqlite3', timeout=15)
    try:
        db.execute('BEGIN IMMEDIATE')
        db.execute('CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
        for key, filename, default in (
            ('tracker', 'speed-tracker.json', {'entries': []}),
            ('learning', 'production-learning.json', {'version': 2, 'observations': [], 'decisions': {}}),
        ):
            if not db.execute('SELECT 1 FROM documents WHERE key=?', (key,)).fetchone():
                legacy = STATE_DIR / filename
                value = json.loads(legacy.read_text(encoding='utf-8')) if legacy.exists() else default
                if not isinstance(value, dict):
                    raise ValueError('Invalid legacy storage. Restore a backup before continuing.')
                if key == 'tracker' and not isinstance(value.get('entries'), list):
                    raise ValueError('Invalid legacy speed tracker. Restore a backup before continuing.')
                if key == 'learning' and (not isinstance(value.get('observations'), list)
                                          or not isinstance(value.get('decisions'), dict)):
                    raise ValueError('Invalid legacy learning history. Restore a backup before continuing.')
                put_document(db, key, value)
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def text(payload, key, limit=100, required=False):
    value = str(payload.get(key) or '').strip()
    if len(value) > limit:
        raise ValueError(f'{key} is too long (maximum {limit} characters).')
    if required and not value:
        raise ValueError(f'{key} is required.')
    return value


def numeric(payload, key, required=False, positive=True, integer=False):
    value = text(payload, key, 30, required)
    if not value:
        return ''
    number = float(value)
    if not math.isfinite(number) or (number <= 0 if positive else number < 0):
        raise ValueError(f'{key} must be a finite {"positive" if positive else "non-negative"} number.')
    if integer and not number.is_integer():
        raise ValueError(f'{key} must be a whole number.')
    return value


def tracker_key(entry):
    return normalized(entry.get('tn')), normalized(entry.get('copperweight'))


def upsert_tracker(entries, payload):
    entry = {key: text(payload, key, limit, required) for key, limit, required in (
        ('tn', 100, True), ('woGroup', 100, False), ('copperweight', 50, True),
        ('reason', 300, False), ('notes', 2000, False))}
    entry['normalSpeed'] = numeric(payload, 'normalSpeed')
    entry['adjustedSpeed'] = numeric(payload, 'adjustedSpeed', required=True)
    existing = next((item for item in entries if payload.get('id') and item.get('id') == payload['id']), None)
    if existing is None:
        existing = next((item for item in entries if tracker_key(item) == tracker_key(entry)), None)
    entry.update(id=existing['id'] if existing else str(uuid.uuid4()), updatedAt=now())
    entry['createdAt'] = existing.get('createdAt', entry['updatedAt']) if existing else entry['updatedAt']
    return [entry, *[item for item in entries if item.get('id') != entry['id']
                    and tracker_key(item) != tracker_key(entry)]], entry


def run_key(item):
    return *tracker_key(item), normalized(item.get('runId'))


def make_observation(incoming, observations):
    entry = {key: text(incoming, key, limit, required) for key, limit, required in (
        ('tn', 100, True), ('woGroup', 100, False), ('copperweight', 50, True),
        ('runId', 100, True), ('notes', 2000, False))}
    for key in ('plannedSpeed', 'actualSpeed', 'cores', 'actualMinutes'):
        entry[key] = numeric(incoming, key, required=key == 'actualSpeed',
                             positive=key != 'actualMinutes', integer=key == 'cores')
    entry['outcome'] = text(incoming, 'outcome', 20, True)
    if entry['outcome'] not in {'good', 'adjusted', 'problem'}:
        raise ValueError('Choose a valid run result.')
    if any(run_key(item) == run_key(entry) for item in observations):
        raise ValueError('This tool, weight and run reference are already recorded. Use a different real run.')
    entry.update(id=str(uuid.uuid4()), recordedAt=now())
    return entry


def recommendation(observations, tn, weight):
    usable, seen = [], set()
    for item in observations:
        if tracker_key(item) != (normalized(tn), normalized(weight)):
            continue
        if not item.get('id') or not item.get('runId') or item.get('outcome') not in {'good', 'adjusted'}:
            continue
        try:
            speed = float(item['actualSpeed'])
        except (KeyError, TypeError, ValueError):
            continue
        if not math.isfinite(speed) or speed <= 0 or run_key(item) in seen:
            continue
        seen.add(run_key(item))
        usable.append(item)
    if len(usable) < 3:
        raise ValueError('Approval requires at least three distinct, usable completed runs.')
    actual = [float(item['actualSpeed']) for item in usable]
    median = statistics.median(actual)
    if max(actual) - min(actual) > max(4, median * .08):
        raise ValueError('These runs are not consistent enough for approval.')
    planned = []
    for item in usable:
        try:
            number = float(item.get('plannedSpeed') or 0)
            if math.isfinite(number) and number > 0:
                planned.append(number)
        except (TypeError, ValueError):
            pass
    baseline = statistics.median(planned) if planned else None
    if baseline is not None and abs(median - baseline) < 1:
        raise ValueError('The current planned speed is already confirmed; no change is needed.')
    speed = math.floor(median * 10 + .5) / 10
    ids = sorted(item['id'] for item in usable)
    key = dumps([normalized(tn), normalized(weight), format(speed, '.15g'), ids])
    return key, ids, {
        'tn': tn, 'copperweight': weight, 'woGroup': usable[0].get('woGroup', ''),
        'normalSpeed': '' if baseline is None else format(baseline, '.15g'),
        'adjustedSpeed': format(speed, '.15g'),
        'reason': 'Approved production-learning recommendation',
        'notes': f'Approved from {len(usable)} distinct usable runs. Observed range {min(actual):g}–{max(actual):g}. Scheduling rules remain unchanged.',
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        super().end_headers()

    def send_json(self, payload, status=HTTPStatus.OK):
        data = dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)

    def authorized(self):
        origin = self.headers.get('Origin')
        if origin and urlparse(origin).netloc != self.headers.get('Host'):
            self.send_json({'error': 'Cross-site access is not allowed.'}, HTTPStatus.FORBIDDEN)
            return False
        if self.command in {'POST', 'DELETE'} and self.headers.get('Sec-Fetch-Site') == 'cross-site':
            self.send_json({'error': 'Cross-site changes are not allowed.'}, HTTPStatus.FORBIDDEN)
            return False
        if PASSWORD:
            expected = 'Basic ' + base64.b64encode(f'{USERNAME}:{PASSWORD}'.encode()).decode()
            if hmac.compare_digest(self.headers.get('Authorization', '').encode('utf-8'), expected.encode('ascii')):
                return True
            self.send_response(HTTPStatus.UNAUTHORIZED)
            self.send_header('WWW-Authenticate', 'Basic realm="EZDES", charset="UTF-8"')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return False
        host = urlparse('http://' + self.headers.get('Host', '')).hostname
        if ipaddress.ip_address(self.client_address[0]).is_loopback and host in {'localhost', '127.0.0.1', '::1'}:
            return True
        self.send_json({'error': 'Network access requires EZDES_PASSWORD. Local-only access uses localhost.'}, HTTPStatus.FORBIDDEN)
        return False

    def static_path(self):
        path = unquote(urlparse(self.path).path)
        if path == '/':
            path = '/copper-speed-organizer.html'
        if path[1:] not in ASSETS or path != '/' + Path(path).name:
            return False
        target = (ROOT / path[1:]).resolve()
        return target.is_relative_to(ROOT) and target.is_file()

    def do_HEAD(self):
        if not self.authorized():
            return
        if not self.static_path():
            return self.send_error(HTTPStatus.NOT_FOUND)
        if urlparse(self.path).path == '/':
            self.path = '/copper-speed-organizer.html'
        super().do_HEAD()

    def do_GET(self):
        if not self.authorized():
            return
        request = urlparse(self.path)
        try:
            if request.path == '/api/backup':
                with transaction() as db:
                    payload = {**read_document(db, 'learning'), 'version': 2,
                               'speedEntries': read_document(db, 'tracker')['entries'], 'exportedAt': now()}
                return self.send_json(payload)
            if request.path in {'/api/learning', '/api/speed-tracker'}:
                with transaction() as db:
                    payload = read_document(db, 'learning' if request.path.endswith('learning') else 'tracker')
                return self.send_json({'storage': 'shared', **payload})
            if request.path == '/latest':
                directory = parse_qs(request.query).get('directory', [''])[0]
                folder = (Path(directory) if directory else DATA_DIR).resolve()
                if not folder.is_relative_to(DATA_DIR):
                    return self.send_json({'error': 'Choose a folder inside EZDES_DATA_DIR.'}, HTTPStatus.FORBIDDEN)
                if not folder.is_dir():
                    raise ValueError('Choose a valid folder inside the configured data directory.')
                files = [item for item in folder.iterdir() if item.is_file()
                         and item.resolve().is_relative_to(DATA_DIR)
                         and item.suffix.lower() in EXTENSIONS and not item.name.startswith('~$')]
                if not files:
                    return self.send_json({'error': 'No Excel files were found.'}, HTTPStatus.NOT_FOUND)
                latest = max(files, key=lambda item: (item.stat().st_mtime_ns, item.name))
                data = latest.read_bytes()
                self.send_response(HTTPStatus.OK)
                self.send_header('Content-Type', 'application/octet-stream')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('X-EZDES-Filename', latest.name.encode('ascii', 'replace').decode())
                self.send_header('X-EZDES-Modified', str(int(latest.stat().st_mtime * 1000)))
                self.end_headers()
                return self.wfile.write(data)
            if not self.static_path():
                return self.send_error(HTTPStatus.NOT_FOUND)
            if request.path == '/':
                self.path = '/copper-speed-organizer.html'
            return super().do_GET()
        except ValueError as error:
            return self.send_json({'error': str(error)}, HTTPStatus.BAD_REQUEST)
        except (OSError, sqlite3.Error):
            return self.send_json({'error': 'Storage is unavailable. Nothing was saved; check server storage.'}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def incoming(self):
        length = int(self.headers.get('Content-Length', '0'))
        if not 1 <= length <= 65536:
            raise ValueError('Invalid request size.')
        payload = json.loads(self.rfile.read(length).decode('utf-8'))
        if not isinstance(payload, dict):
            raise ValueError('Expected an object.')
        return payload

    def do_POST(self):
        if not self.authorized():
            return
        request = urlparse(self.path)
        if request.path not in {'/api/learning', '/api/speed-tracker'}:
            return self.send_error(HTTPStatus.NOT_FOUND)
        try:
            incoming = self.incoming()
            with transaction() as db:
                if request.path == '/api/speed-tracker':
                    entries, entry = upsert_tracker(read_document(db, 'tracker')['entries'], incoming)
                    put_document(db, 'tracker', {'entries': entries})
                    result = {'entries': entries, 'entry': entry}
                else:
                    payload = read_document(db, 'learning')
                    action = incoming.get('action', 'observation')
                    if action == 'observation':
                        entry = make_observation(incoming, payload['observations'])
                        payload['observations'].insert(0, entry)
                    elif action == 'approve':
                        key, ids, tracker = recommendation(payload['observations'], text(incoming, 'tn', required=True),
                                                            text(incoming, 'copperweight', 50, True))
                        if key != incoming.get('key') or ids != sorted(incoming.get('observationIds', [])):
                            raise ValueError('Evidence has changed. Refresh and review the recommendation again.')
                        entries, _ = upsert_tracker(read_document(db, 'tracker')['entries'], tracker)
                        put_document(db, 'tracker', {'entries': entries})
                        payload['decisions'][key] = {'status': 'approved', 'decidedAt': now(), 'observationIds': ids}
                    elif action == 'decision':
                        key = text(incoming, 'key', 8192, True)
                        status = text(incoming, 'status', 20, True)
                        if status not in {'rejected', 'pending'}:
                            raise ValueError('Approval must use the atomic approval action.')
                        if status == 'pending':
                            payload['decisions'].pop(key, None)
                        else:
                            payload['decisions'][key] = {'status': status, 'decidedAt': now()}
                    else:
                        raise ValueError('Unknown learning action.')
                    put_document(db, 'learning', payload)
                    result = {**payload}
                    if action == 'approve':
                        result['entries'] = entries
            return self.send_json({'storage': 'shared', **result})
        except (ValueError, TypeError, UnicodeError) as error:
            return self.send_json({'error': str(error)}, HTTPStatus.BAD_REQUEST)
        except (OSError, sqlite3.Error):
            return self.send_json({'error': 'Storage is unavailable. No changes were saved.'}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_DELETE(self):
        if not self.authorized():
            return
        request = urlparse(self.path)
        if request.path not in {'/api/learning', '/api/speed-tracker'}:
            return self.send_error(HTTPStatus.NOT_FOUND)
        entry_id = parse_qs(request.query).get('id', [''])[0]
        if not entry_id:
            return self.send_json({'error': 'Record id is required.'}, HTTPStatus.BAD_REQUEST)
        try:
            with transaction() as db:
                key = 'learning' if request.path.endswith('learning') else 'tracker'
                payload = read_document(db, key)
                field = 'observations' if key == 'learning' else 'entries'
                updated = [item for item in payload[field] if item.get('id') != entry_id]
                if len(updated) == len(payload[field]):
                    return self.send_json({'error': 'Record not found.'}, HTTPStatus.NOT_FOUND)
                payload[field] = updated
                put_document(db, key, payload)
            return self.send_json({'storage': 'shared', **payload})
        except (OSError, sqlite3.Error, ValueError):
            return self.send_json({'error': 'Storage is unavailable. No changes were saved.'}, HTTPStatus.INTERNAL_SERVER_ERROR)


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f'http://localhost:{PORT}/copper-speed-organizer.html'
    print(f'EZDES is running at {url}')
    if HOST not in {'127.0.0.1', 'localhost', '::1'} and not PASSWORD:
        print('Network access is blocked until EZDES_PASSWORD is configured.')
    if os.getenv('EZDES_OPEN_BROWSER', '1') == '1':
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
