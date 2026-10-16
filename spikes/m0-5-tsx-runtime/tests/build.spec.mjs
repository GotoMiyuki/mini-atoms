import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { buildSource } from '../src/controlled-build/index.mjs';
import { fixture } from '../src/spike-cli/fixtures.mjs';
import { root, json, runId } from '../src/shared.mjs';
const id = runId('t1'), checks = [], builds = {};
async function check(name, action) { try { const detail = await action(); checks.push({ name, status: 'PASS', detail }); } catch (error) { checks.push({ name, status: 'FAIL', error: error.message }); } }
for (const name of ['todo-good', 'todo-noop', 'counter-good']) await check(`build-${name}`, async () => { builds[name] = await buildSource(await fixture(name)); return builds[name]; });
await check('different-logic-produces-different-source-and-build', () => { assert.notEqual(builds['todo-good'].sourceSha256, builds['counter-good'].sourceSha256); assert.notEqual(builds['todo-good'].buildSha256, builds['counter-good'].buildSha256); });
await check('repeat-build-is-byte-identical', async () => assert.equal((await buildSource(await fixture('todo-good'))).buildSha256, builds['todo-good'].buildSha256));
await check('source-identity-survives-identical-output', async () => {
  const input = await fixture('todo-good'); input.files[0].content += '\n// additional source comment';
  const changed = await buildSource(input);
  assert.equal(changed.buildSha256, builds['todo-good'].buildSha256);
  assert.notEqual(changed.sourceSha256, builds['todo-good'].sourceSha256);
  assert.notEqual(changed.versionId, builds['todo-good'].versionId);
});
const simple = "import React from 'react'; export default function App(){return <p>test</p>}";
const badInputs = [
  ['parent-path', [{ path: '../../escape.tsx', content: simple }]],
  ['package-script', [{ path: 'package.json', content: '{"scripts":{"build":"echo forbidden"}}' }]],
  ['normalized-traversal', [{ path: 'src/../../server.ts', content: simple }]],
  ['absolute-path', [{ path: '/src/App.tsx', content: simple }]],
  ['duplicate-path', [{ path: 'src/App.tsx', content: simple }, { path: 'src/App.tsx', content: simple }]],
  ['symlink-field', [{ path: 'src/App.tsx', content: simple, symlink: '/etc/passwd' }]],
  ['unknown-package', [{ path: 'src/App.tsx', content: "import x from 'axios';" + simple }]],
  ['node-module', [{ path: 'src/App.tsx', content: "import fs from 'node:fs';" + simple }]],
  ['remote-import', [{ path: 'src/App.tsx', content: "import x from 'https://example.invalid/x.js';" + simple }]],
  ['unused-type-import', [{ path: 'src/App.tsx', content: "import type { Stats } from 'node:fs';" + simple }]],
  ['dynamic-import', [{ path: 'src/App.tsx', content: "import('react');" + simple }]],
  ['css-egress-url', [{ path: 'src/App.tsx', content: "import './styles.css';" + simple }, { path: 'src/styles.css', content: 'body{background:url(https://example.invalid/x)}' }]],
  ['oversize-file', [{ path: 'src/App.tsx', content: 'x'.repeat(65537) }]],
  ['too-many-files', [{ path: 'src/App.tsx', content: simple }, ...Array.from({ length: 12 }, (_, index) => ({ path: `src/components/Item${index}.tsx`, content: simple }))]],
  ['oversize-total', [{ path: 'src/App.tsx', content: simple }, ...Array.from({ length: 10 }, (_, index) => ({ path: `src/components/Item${index}.tsx`, content: 'x'.repeat(30000) }))]],
  ['css-import', [{ path: 'src/App.tsx', content: "import './styles.css';" + simple }, { path: 'src/styles.css', content: '@import "https://example.invalid/style.css";' }]],
];
for (const [name, files] of badInputs) await check(`reject-${name}`, async () => {
  const file = resolve(root, 'evidence', id, `${name}-source.json`);
  await json(file, { schemaVersion: '0.1', files });
  const execution = await new Promise((done, reject) => {
    const child = spawn(process.execPath, [resolve(root, 'src/spike-cli/compile-input.mjs'), file], { shell: false, windowsHide: true });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    child.once('error', reject); child.once('exit', exitCode => done({ exitCode, stdout, stderr }));
  });
  assert.equal(execution.exitCode, 1, `Expected actual rejection exit 1: ${execution.stdout} ${execution.stderr}`);
  const rejection = JSON.parse(execution.stdout.trim());
  assert.equal(rejection.status, 'REJECTED');
  return { ...rejection, actualExitCode: execution.exitCode };
});
await check('concurrent-build-rejected', async () => {
  const input = await fixture('todo-good');
  const first = buildSource(input);
  try { await assert.rejects(buildSource(input), error => error.code === 'BUILD_BUSY'); }
  finally { await first; }
});
const report = { runId: id, environment: process.env.SPIKE_ENV || 'LOCAL', finishedAt: new Date().toISOString(), gate: 'T1', status: checks.every(c => c.status === 'PASS') ? 'PASS' : 'FAIL', checks, builds };
await json(resolve(root, 'evidence', id, 'report.json'), report);
await json(resolve(root, 'artifacts/fixture-index.json'), builds);
console.log(JSON.stringify({ gate: 'T1', status: report.status, passed: checks.filter(c => c.status === 'PASS').length, failed: checks.filter(c => c.status === 'FAIL'), report: `evidence/${id}/report.json` }));
process.exitCode = report.status === 'PASS' ? 0 : 1;
