import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root, readJson, json, sha } from '../src/shared.mjs';
const expected = await readJson(resolve(root, '../m0-preview-validation/dist/version.json'));
const checks = [];
for (const folder of ['m0-ecs-20261014/evidence', 'm0-ecs-ssh-preview']) {
  const directory = resolve(root, 'evidence', folder);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runDirectory = resolve(directory, entry.name);
    const report = await readJson(resolve(runDirectory, 'report.json'));
    assert.equal(report.runId, entry.name);
    assert.equal(report.app.appVersion, expected.appVersion);
    assert.equal(report.app.sourceSha256, expected.sourceSha256);
    assert.deepEqual(report.app.assets, expected.assets);
    const artifacts = {};
    for (const [name, hash] of Object.entries(report.artifactSha256)) {
      assert(['before.png', 'after.png', 'browser-log.json', 'trace.zip'].includes(name));
      const actual = sha(await readFile(resolve(runDirectory, name)));
      assert.equal(actual, hash);
      artifacts[name] = actual;
    }
    if (report.status === 'PASS' || report.status === 'FAIL') {
      assert.equal(Object.keys(artifacts).length, 4);
      assert.equal(report.actualResult.interactionCompleted, true);
      assert.equal(report.actualResult.taskCountAfter, report.scenario === 'normal' ? 1 : 0);
      assert.equal(report.status, report.scenario === 'normal' ? 'PASS' : 'FAIL');
    } else {
      assert.equal(report.status, 'ERROR');
      assert.equal(report.artifacts.screenshot, null);
      assert.equal(report.artifacts.trace, null);
    }
    checks.push({ runId: report.runId, scenario: report.scenario, actual: report.status, status: 'PASS', report: `${folder}/${entry.name}/report.json`, reportSha256: sha(await readFile(resolve(runDirectory, 'report.json'))), artifacts });
  }
}
assert.equal(checks.length, 7);
assert.equal(checks.filter(check => check.actual === 'PASS').length, 3);
assert.equal(checks.filter(check => check.actual === 'FAIL').length, 3);
assert.equal(checks.filter(check => check.actual === 'ERROR').length, 1);
await json(resolve(root, 'evidence/m0-ecs-integrity.json'), { status: 'PASS', executedAt: new Date().toISOString(), appVersion: expected.appVersion, sourceSha256: expected.sourceSha256, checks });
console.log(JSON.stringify({ status: 'PASS', reports: checks.length, meaning: 'Original ECS and SSH preview artifacts, version identity, actual interaction and SHA-256 verified' }));
