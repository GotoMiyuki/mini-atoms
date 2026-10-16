import assert from 'node:assert/strict';
import { readFile, lstat, readdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { root, readJson, json, sha } from '../src/shared.mjs';
const cloud = resolve(root, 'evidence/m05-ecs-20261014/evidence');
const local = await readJson(resolve(root, 'artifacts/fixture-index.json'));
const compiled = await readJson(resolve(cloud, 'fixture-index-ecs.json'));
for (const name of Object.keys(local)) for (const field of ['sourceSha256', 'buildSha256', 'configurationSha256', 'versionId', 'assets', 'sourceFiles', 'tool']) assert.deepEqual(compiled[name][field], local[name][field], `${name}.${field}`);
assert.equal((await readJson(resolve(cloud, 'cross-environment-builds.json'))).status, 'PASS');
const runtime = await readJson(resolve(cloud, 'runtime-files-ecs.json'));
assert.equal(runtime.status, 'PASS');
assert.deepEqual(runtime.hashes, await readJson(resolve(root, 'evidence/docker-shell-runtime-hashes.json')));
const checked = [], suites = [];
const allowed = ['before.png', 'after.png', 'raw-top-denied.png', 'trace.zip', 'browser-log.json', 'sandbox-status.json', 'process-boundary.json', 'security-probe.json', 'static-transport.json'];
for (const gate of ['t2', 't3', 'resources']) {
  const suite = await readJson(resolve(cloud, `latest-${gate}.json`));
  assert.equal(suite.status, 'PASS'); assert.equal(suite.environment, 'ECS');
  assert(suite.cases.some(item => item.name === 'preview-service-remains-healthy' && item.status === 'PASS'));
  assert(suite.cases.some(item => item.name === 'main-service-remains-healthy-and-protected' && item.role === 'main-canary' && item.httpStatus === 200 && item.unauthenticatedAPIStatus === 401));
  suites.push({ gate: suite.gate, runId: suite.runId, status: suite.status, report: `m05-ecs-20261014/evidence/${suite.runId}/report.json`, reportSha256: sha(await readFile(resolve(cloud, suite.runId, 'report.json'))) });
  for (const item of suite.cases.filter(item => item.report)) {
    const path = resolve(cloud, item.report); assert(path.startsWith(cloud + sep));
    if (item.reportSha256) assert.equal(sha(await readFile(path)), item.reportSha256);
    const report = await readJson(path);
    if (!report.runId) { assert.equal(report.status, 'PASS'); assert.equal(report.environment, 'ECS'); continue; }
    assert.equal(report.environment, 'ECS'); assert.equal(report.runId, item.jobId); assert.equal(report.status, item.actual); assert.equal(item.status, 'PASS');
    for (const [name, expected] of Object.entries(report.artifactSha256)) {
      assert(allowed.includes(name)); const asset = resolve(dirname(path), name), info = await lstat(asset);
      assert(info.isFile() && !info.isSymbolicLink() && info.size <= 10485760); assert.equal(sha(await readFile(asset)), expected);
    }
    if (report.status !== 'UNVERIFIED') for (const field of ['sourceSha256', 'buildSha256', 'versionId', 'configurationSha256']) assert.equal(report[field], local[report.fixture][field]);
    if (item.containerBoundary) {
      const path = resolve(dirname(resolve(cloud, item.report)), item.containerBoundary.path);
      assert.equal(sha(await readFile(path)), item.containerBoundary.sha256);
      const boundary = await readJson(path); assert.equal(boundary.user, '1001:1001'); assert.equal(boundary.hostConfig.readonlyRootfs, true); assert.equal(boundary.hostConfig.privileged, false); assert.deepEqual(boundary.networks, ['mini-atoms-m05_browser']); assert.deepEqual(boundary.hostConfig.dns, ['127.0.0.1']);
    }
    if (['PASS', 'FAIL'].includes(report.status)) {
      assert.equal(report.sandbox.uid, 1001); assert.match(report.sandbox.statusText, /Layer 1 Sandbox\s+Namespace/); assert.match(report.sandbox.statusText, /Seccomp-BPF sandbox\s+Yes/);
      for (const name of ['before.png', 'after.png', 'trace.zip']) assert(report.artifactSha256[name]);
      assert.equal(report.exposure.generatedHTML.requestHeaders['sec-fetch-dest'], 'iframe');
    }
    if (report.failureCategory === 'APP_BEHAVIOR') { assert.equal(report.fixture, 'todo-noop'); assert(report.steps.some(step => step.action === 'assertCount' && step.status === 'FAIL')); }
    if (['preview-unavailable', 'browser-crash', 'preview-disconnect', 'resource-timeout'].includes(report.probe)) assert.equal(report.faultObserved, true);
    if (report.fixture === 'security-probe') { assert(report.security.checks.every(item => item.status === 'PASS')); assert.equal(report.exposure.rawTopLevel.status, 403); assert.equal(report.exposure.rawTopLevel.generatedRootCount, 0); }
    checked.push({ runId: report.runId, fixture: report.fixture, probe: report.probe, actual: report.status, status: 'PASS', report: `m05-ecs-20261014/evidence/${item.report}`, reportSha256: sha(await readFile(path)), artifactCount: Object.keys(report.artifactSha256).length, memoryPeakBytes: Number(report.resourceUsage['memory.peak']), durationMs: Date.parse(report.finishedAt) - Date.parse(report.startedAt), resourceUsage: report.resourceUsage });
  }
}
const t1File = (await readdir(cloud, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^t1-/.test(entry.name)).map(entry => entry.name).sort().at(-1), t1 = await readJson(resolve(cloud, t1File, 'report.json'));
assert.equal(t1.status, 'PASS'); assert.equal(t1.environment, 'ECS'); assert.equal(t1.checks.length, 23); assert(t1.checks.every(check => check.status === 'PASS'));
const headerFile = (await readdir(cloud)).filter(name => /^preview-headers-.*\.json$/.test(name)).sort().at(-1), headers = await readJson(resolve(cloud, headerFile));
assert.equal(headers.status, 'PASS'); assert.equal(headers.checks.length, 12);
const statsFile = (await readdir(cloud)).filter(name => /^docker-stats-.*\.json$/.test(name)).sort().at(-1), stats = await readJson(resolve(cloud, statsFile));
assert.equal(stats.status, 'PASS'); assert.equal(stats.environment, 'ECS'); assert(stats.samples.length > 0);
const preview = await readJson(resolve(root, 'evidence/latest-ecs-ssh-preview.json'));
assert.equal(preview.status, 'PASS'); assert.equal(preview.environment, 'WINDOWS_BROWSER_TO_ECS_VIA_SSH'); assert.equal(preview.results.length, 8);
for (const item of preview.results) {
  const path = resolve(root, 'evidence', item.report); assert.equal(sha(await readFile(path)), item.reportSha256);
  const report = await readJson(path); assert.equal(report.status, item.expected); assert.equal(report.environment, preview.environment);
  for (const [name, expected] of Object.entries(report.artifactSha256)) { assert(allowed.includes(name)); assert.equal(sha(await readFile(resolve(dirname(path), name))), expected); }
  for (const [name, asset] of Object.entries(local[report.fixture].assets)) assert.equal(report.loadedAssets[name].sha256, asset.sha256);
  if (report.security) { assert(report.security.checks.every(check => check.status === 'PASS')); assert.equal(report.exposure.rawTop.status, 403); }
}
await json(resolve(root, 'evidence/ecs-m05-integrity.json'), { status: 'PASS', capturedAt: new Date().toISOString(), scope: 'ECS M0.5 core gates + Windows browser over SSH', suites, t1: `m05-ecs-20261014/evidence/${t1File}/report.json`, headers: `m05-ecs-20261014/evidence/${headerFile}`, stats: `m05-ecs-20261014/evidence/${statsFile}`, imageId: (await readFile(resolve(cloud, 'docker-image-id.txt'), 'utf8')).trim(), localImageId: (await readFile(resolve(root, 'evidence/docker-image-id.txt'), 'utf8')).trim(), sourceAndBuildIdentitiesMatch: true, runtimeSourceFilesMatch: Object.keys(runtime.hashes).length, checked, SSHPreviewSuite: preview.suite, SSHPreviewCases: preview.results.length });
console.log(JSON.stringify({ status: 'PASS', cloudWorkerReports: checked.length, SSHPreviewCases: preview.results.length, coreRuntimeFiles: Object.keys(runtime.hashes).length }));
