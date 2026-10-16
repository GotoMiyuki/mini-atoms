import assert from 'node:assert/strict';
import { readFile, lstat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { root, readJson, sha, json } from '../src/shared.mjs';
const evidence = resolve(root, 'evidence'), index = await readJson(resolve(root, 'artifacts/fixture-index.json')), checked = [];
const allowed = ['before.png', 'after.png', 'raw-top-denied.png', 'trace.zip', 'browser-log.json', 'sandbox-status.json', 'process-boundary.json', 'security-probe.json', 'static-transport.json'];
for (const name of ['latest-t2.json', 'latest-t3.json', 'latest-resources.json', 'latest-local-browser.json']) {
  const suite = await readJson(resolve(evidence, name)); assert.equal(suite.status, 'PASS', name);
  for (const item of suite.cases || suite.results) {
    if (!item.report) continue;
    const path = resolve(evidence, item.report); assert(path.startsWith(evidence));
    if (item.reportSha256) assert.equal(sha(await readFile(path)), item.reportSha256);
    if (item.containerBoundary) assert.equal(sha(await readFile(resolve(dirname(path), item.containerBoundary.path))), item.containerBoundary.sha256);
    const report = await readJson(path);
    if (!report.runId) { assert.equal(report.status, 'PASS'); continue; }
    assert.equal(report.runId, item.jobId || item.runId);
    assert.equal(report.status, item.actual);
    for (const [name, hash] of Object.entries(report.artifactSha256)) {
      assert(allowed.includes(name)); const asset = resolve(dirname(path), name), info = await lstat(asset);
      assert(info.isFile() && !info.isSymbolicLink() && info.size <= 10485760);
      assert.equal(sha(await readFile(asset)), hash);
    }
    if (report.status !== 'UNVERIFIED') {
      for (const field of ['sourceSha256', 'buildSha256', 'versionId']) assert.equal(report[field], index[report.fixture][field]);
    }
    if (['PASS', 'FAIL'].includes(report.status)) {
      for (const name of ['before.png', 'after.png', 'trace.zip']) assert(report.artifactSha256[name]);
      assert.equal((report.exposure.generatedHTML?.requestHeaders || report.exposure.requestHeaders)['sec-fetch-dest'], 'iframe');
      if (report.sandbox) { assert.equal(report.sandbox.uid, 1001); assert.match(report.sandbox.statusText, /Seccomp-BPF sandbox\s+Yes/); }
    }
    if (report.failureCategory === 'APP_BEHAVIOR') { assert.equal(report.fixture, 'todo-noop'); assert(report.steps.some(step => step.action === 'assertCount' && step.expected === 1 && step.status === 'FAIL')); }
    if (['browser-crash', 'preview-disconnect', 'resource-timeout', 'preview-unavailable'].includes(report.probe)) assert.equal(report.faultObserved, true);
    if (report.probe === 'preview-unavailable') assert.equal(report.error.causeCode, 'ECONNREFUSED');
    if (report.fixture === 'security-probe') {
      assert(report.security.checks.every(check => check.status === 'PASS'));
      const rejected = report.exposure.rawTopLevel || report.exposure.rawTop;
      assert.equal(rejected.status, 403); assert.equal(rejected.generatedRootCount, 0); assert.equal(rejected.requestHeaders['sec-fetch-dest'], 'document');
      assert(report.artifactSha256['raw-top-denied.png']);
    }
    checked.push({ runId: report.runId, fixture: report.fixture, status: report.status, environment: report.environment, report: item.report, reportSha256: sha(await readFile(path)), artifactCount: Object.keys(report.artifactSha256).length });
  }
}
await json(resolve(evidence, 'shell-local-integrity.json'), { status: 'PASS', capturedAt: new Date().toISOString(), scope: 'LOCAL Docker workers + Windows browser to local Docker; not ECS', reports: checked });
console.log(JSON.stringify({ status: 'PASS', reports: checked.length, scope: 'LOCAL_ONLY' }));
