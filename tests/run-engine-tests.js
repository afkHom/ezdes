// Runs the engine tests in tests/engine.test.html under Node, without a browser:
//   node tests/run-engine-tests.js
// The page's inline script only needs window, document.getElementById and performance.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
globalThis.window = globalThis;
globalThis.performance = globalThis.performance || require('perf_hooks').performance;
const elements = {};
globalThis.document = { getElementById: (id) => (elements[id] ??= { textContent: '', className: '', innerHTML: '' }) };

require(path.join(root, 'web', 'engine.js'));
const html = fs.readFileSync(path.join(root, 'tests', 'engine.test.html'), 'utf8');
const script = html.split('<script>')[1].split('</script>')[0];
new Function(script)();

const { passed, failed } = globalThis.testResults;
console.log(`${passed} passed, ${failed.length} failed`);
for (const f of failed) console.log(`FAIL ${f}`);
process.exit(failed.length ? 1 : 0);
