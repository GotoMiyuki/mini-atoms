import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { validate } from '../../m0-preview-validation/runtime/validator.mjs';
import { root, readJson, json } from '../src/shared.mjs';

// Trusted M0 fixture only. Destination is fixed, never read from a submitted job.
const origin = 'http://127.0.0.1:18080';
const expected = await readJson(resolve(root, '../m0-preview-validation/dist/version.json'));
const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(5000) });
assert.equal(response.status, 200);
const version = await response.json();
assert.equal(version.appVersion, expected.appVersion);
assert.equal(version.sourceSha256, expected.sourceSha256);
assert.deepEqual(version.assets, expected.assets);
for (const [path, hash] of Object.entries(version.assets)) {
  const asset = await fetch(`${origin}/${path}`, { signal: AbortSignal.timeout(5000) });
  const { sha } = await import('../src/shared.mjs');
  assert.equal(sha(Buffer.from(await asset.arrayBuffer())), hash);
}
assert.equal((await fetch(`${origin}/api/runs`)).status, 503);
const reports = [];
for (const scenario of ['normal', 'fault']) {
  reports.push(await validate({ origin, version, scenario, evidenceRoot: resolve(root, 'evidence/m0-ecs-ssh-preview') }));
}
const accepted = reports[0].status === 'PASS' && reports[1].status === 'FAIL';
await json(resolve(root, 'evidence/m0-ecs-ssh-preview/summary.json'), {
  status: accepted ? 'PASS' : 'FAIL', environment: 'WINDOWS_BROWSER_TO_ECS_VIA_SSH',
  origin, version, serviceAssetsVerified: true, publicTestAPIEnabled: false,
  runs: reports.map(report => ({ runId: report.runId, scenario: report.scenario, status: report.status, evidenceDirectory: report.evidenceDirectory })),
});
console.log(JSON.stringify({ status: accepted ? 'PASS' : 'FAIL', runs: reports.map(report => ({ runId: report.runId, status: report.status })) }));
process.exitCode = accepted ? 0 : 1;
