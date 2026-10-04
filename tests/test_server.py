import base64
import importlib.util
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('ezdes_server', ROOT / 'ezdes_server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.settings = patch.multiple(server, STATE_DIR=root / 'state', DATA_DIR=root / 'data', PASSWORD='')
        self.settings.start()
        server.DATA_DIR.mkdir()
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.url = 'http://127.0.0.1:' + str(self.http.server_address[1])

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()
        self.settings.stop()
        self.temp.cleanup()

    def request(self, path, method='GET', payload=None, headers=None):
        data = json.dumps(payload).encode() if payload is not None else None
        request = Request(self.url + path, data=data, method=method,
                          headers={'Content-Type': 'application/json', **(headers or {})})
        try:
            response = urlopen(request, timeout=5)
        except HTTPError as error:
            response = error
        with response:
            body = response.read()
            return response.status, json.loads(body) if body.startswith(b'{') else body

    def observe(self, run, weight='2/2', actual='22', **extra):
        return self.request('/api/learning', 'POST', {
            'tn': '1740', 'copperweight': weight, 'plannedSpeed': '24', 'actualSpeed': actual,
            'runId': run, 'outcome': 'good', 'cores': '12', **extra})

    def approval(self):
        _, history = self.request('/api/learning')
        key, ids, _ = server.recommendation(history['observations'], '1740', '2/2')
        return {'action': 'approve', 'tn': '1740', 'copperweight': '2/2', 'key': key, 'observationIds': ids}

    def test_only_public_assets_are_served(self):
        for path in ('/.git/config', '/state/ezdes.sqlite3', '/ezdes_server.py', '/README-Local-Test.md', '/%2e%2e/README.md'):
            for method in ('GET', 'HEAD'):
                self.assertEqual(self.request(path, method)[0], 404, (path, method))
        self.assertEqual(self.request('/')[0], 200)
        self.assertEqual(self.request('/ezdes-core.js', 'HEAD')[0], 200)

    def test_authentication_and_cross_site_changes(self):
        with patch.object(server, 'PASSWORD', 'test-password'):
            self.assertEqual(self.request('/api/learning')[0], 401)
            auth = 'Basic ' + base64.b64encode(b'ezdes:test-password').decode()
            self.assertEqual(self.request('/api/learning', headers={'Authorization': auth})[0], 200)
        self.assertEqual(self.request('/api/learning', 'POST', {}, {'Origin': 'https://elsewhere.example'})[0], 403)
        self.assertEqual(self.request('/api/learning', headers={'Host': 'hostile.example'})[0], 403)

    def test_latest_is_confined_to_data_directory(self):
        (server.DATA_DIR / 'old.csv').write_text('old')
        (server.DATA_DIR / 'new.xlsx').write_bytes(b'new')
        (server.DATA_DIR / '~$locked.xlsx').write_bytes(b'ignore')
        import os
        os.utime(server.DATA_DIR / 'old.csv', (1, 1))
        self.assertEqual(self.request('/latest')[1], b'new')
        from urllib.parse import quote
        outside = Path(self.temp.name)
        self.assertEqual(self.request('/latest?directory=' + quote(str(outside)))[0], 403)

    def test_tracker_separates_tool_and_weight(self):
        for weight in ('1/1', '2/2'):
            self.assertEqual(self.request('/api/speed-tracker', 'POST', {
                'tn': '1740', 'copperweight': weight, 'adjustedSpeed': '22'})[0], 200)
        _, tracker = self.request('/api/speed-tracker')
        self.assertEqual(len(tracker['entries']), 2)
        self.assertEqual(self.request('/api/speed-tracker', 'POST', {
            'tn': '1740', 'copperweight': '2/2', 'adjustedSpeed': '21'})[0], 200)
        self.assertEqual(len(self.request('/api/speed-tracker')[1]['entries']), 2)

    def test_validation_duplicates_and_no_direct_approval(self):
        for value in ('0', '-1', 'NaN', 'Infinity', 'not numeric'):
            self.assertEqual(self.observe('invalid', actual=value)[0], 400)
        self.assertEqual(self.observe('run-1', cores='1.5')[0], 400)
        self.assertEqual(self.observe('run-1')[0], 200)
        self.assertEqual(self.observe('RUN-1')[0], 400)
        self.assertEqual(self.observe('run-1', weight='1/1')[0], 200)
        self.assertEqual(self.observe('')[0], 400)
        self.assertEqual(self.request('/api/learning', 'POST', {
            'action': 'decision', 'key': 'unsafe', 'status': 'approved'})[0], 400)

    def test_approval_is_atomic_and_revalidates_evidence(self):
        for i in range(3):
            self.assertEqual(self.observe('run-' + str(i))[0], 200)
        incoming = self.approval()
        original = server.put_document

        def fail_decision(db, key, value):
            if key == 'learning' and value['decisions']:
                raise sqlite3.OperationalError('Simulated disk failure')
            original(db, key, value)

        with patch.object(server, 'put_document', fail_decision):
            self.assertEqual(self.request('/api/learning', 'POST', incoming)[0], 500)
        self.assertEqual(self.request('/api/speed-tracker')[1]['entries'], [])
        self.assertEqual(self.request('/api/learning')[1]['decisions'], {})
        self.assertEqual(self.request('/api/learning', 'POST', incoming)[0], 200)
        self.assertEqual(len(self.request('/api/speed-tracker')[1]['entries']), 1)
        self.assertEqual(self.request('/api/learning')[1]['decisions'][incoming['key']]['status'], 'approved')
        status, backup = self.request('/api/backup')
        self.assertEqual(status, 200)
        self.assertEqual(backup['speedEntries'], self.request('/api/speed-tracker')[1]['entries'])
        self.assertEqual(backup['decisions'][incoming['key']]['status'], 'approved')
        self.observe('new-run')
        self.assertEqual(self.request('/api/learning', 'POST', incoming)[0], 400)

    def test_migration_preserves_legacy_without_counting_duplicate_evidence(self):
        server.STATE_DIR.mkdir()
        observations = [{'id': 'legacy', 'tn': '1740', 'copperweight': '2/2', 'actualSpeed': '22', 'outcome': 'good'}]
        legacy = server.STATE_DIR / 'production-learning.json'
        legacy.write_text(json.dumps({'observations': observations, 'decisions': {}}))
        self.assertEqual(self.request('/api/learning')[1]['observations'], observations)
        self.assertTrue(legacy.exists())
        self.assertTrue((server.STATE_DIR / 'ezdes.sqlite3').exists())
        with self.assertRaises(ValueError):
            server.recommendation(observations * 3, '1740', '2/2')
        duplicate = {**observations[0], 'runId': 'same-run'}
        with self.assertRaises(ValueError):
            server.recommendation([duplicate] * 3, '1740', '2/2')

    def test_parallel_observations_do_not_overwrite_each_other(self):
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=5) as pool:
            statuses = list(pool.map(lambda i: self.observe('parallel-' + str(i))[0], range(10)))
        self.assertEqual(statuses, [200] * 10)
        self.assertEqual(len(self.request('/api/learning')[1]['observations']), 10)

    def test_invalid_legacy_storage_is_not_silently_overwritten(self):
        server.STATE_DIR.mkdir()
        legacy = server.STATE_DIR / 'production-learning.json'
        legacy.write_text('{"observations":false,"decisions":{}}')
        self.assertEqual(self.request('/api/learning')[0], 400)
        self.assertEqual(legacy.read_text(), '{"observations":false,"decisions":{}}')
        legacy.write_text('{"observations":[],"decisions":{}}')
        self.assertEqual(self.request('/api/learning')[0], 200)


if __name__ == '__main__':
    unittest.main()
