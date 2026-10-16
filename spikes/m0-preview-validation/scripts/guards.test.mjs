import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPreview } from '../runtime/server.mjs';
import { validate } from '../runtime/validator.mjs';

const token = randomUUID();
let preview;
before(async () => { preview = await createPreview({ port: 0, host: '127.0.0.1', token }); });
after(async () => { await preview?.close(); });
const invoke = (body, options = {}) => fetch(`${preview.origin}/api/runs${options.query || ''}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-M0-Run-Token': options.token ?? token },
  body: JSON.stringify(body),
});

test('served assets match the exact build fingerprint', async () => {
  for (const [name, sha256] of Object.entries(preview.version.assets)) {
    const response = await fetch(`${preview.origin}/${name}`);
    assert.equal(response.status, 200);
    assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), sha256);
  }
});

test('test API denies unauthenticated calls, URLs, commands, unknown scenarios and query input', async () => {
  assert.equal((await invoke({ scenario: 'normal' }, { token: 'wrong' })).status, 401);
  for (const input of [
    { scenario: 'normal', url: 'http://169.254.169.254/latest/meta-data/' },
    { scenario: 'normal', command: 'whoami' },
    { scenario: 'other' }, [], null,
  ]) assert.equal((await invoke(input)).status, 400);
  assert.equal((await invoke({ scenario: 'normal' }, { query: '?url=http://example.com' })).status, 400);
});

test('private source and evidence are not exposed as static files', async () => {
  for (const path of ['/package.json', '/.env', '/runtime/server.mjs', '/evidence/report.json', '/%2e%2e/SpikeTest.md']) {
    assert.equal((await fetch(`${preview.origin}${path}`)).status, 404);
  }
});

test('without token the API is disabled', async () => {
  const closed = await createPreview({ port: 0, host: '127.0.0.1', token: '' });
  try { assert.equal((await fetch(`${closed.origin}/api/runs`, { method: 'POST' })).status, 503); }
  finally { await closed.close(); }
});

test('HTTP API performs real PASS and FAIL and returns matching artifacts', async () => {
  for (const [scenario, expected] of [['normal', 'PASS'], ['fault', 'FAIL']]) {
    const response = await invoke({ scenario });
    assert.equal(response.status, 200);
    const { report, files } = await response.json();
    assert.equal(report.status, expected);
    assert.equal(report.actualResult.interactionCompleted, true);
    assert.equal(report.actualResult.taskCountBefore, 0);
    assert.equal(report.actualResult.taskCountAfter, scenario === 'normal' ? 1 : 0);
    for (const [name, sha256] of Object.entries(report.artifactSha256)) {
      assert.equal(createHash('sha256').update(Buffer.from(files[name], 'base64')).digest('hex'), sha256);
    }
    assert.deepEqual(JSON.parse(Buffer.from(files['report.json'], 'base64').toString()), report);
    console.log(`API ${scenario}: ${report.status}; evidence ${report.runId}`);
  }
});

test('unreachable preview produces ERROR with no fabricated screenshot', async () => {
  const offline = await createPreview({ port: 0, host: '127.0.0.1', token: '' });
  await offline.close();
  const report = await validate({ ...offline, scenario: 'normal' });
  assert.equal(report.status, 'ERROR');
  assert.equal(report.failure.step, 'preview-health');
  assert.equal(report.actualResult.interactionCompleted, false);
  assert.equal(report.artifacts.screenshot, null);
  assert.equal(report.artifacts.trace, null);
  assert.equal(JSON.parse(await readFile(resolve(report.evidenceDirectory, 'report.json'), 'utf8')).status, 'ERROR');
  console.log(`Infrastructure ERROR: ${report.runId}`);
});
