import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { root, readJson, json, sha, canonicalHash } from '../shared.mjs';
const evidence = resolve(root, 'evidence'), suites = [], files = {};
for (const entry of await readdir(evidence, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^(t1|t2|t3|resources)-/.test(entry.name)) continue;
  try { const report = await readJson(resolve(evidence, entry.name, 'report.json')); suites.push({ runId: report.runId, gate: report.gate, status: report.status, environment: report.environment, report: `${entry.name}/report.json`, reportSha256: sha(await readFile(resolve(evidence, entry.name, 'report.json'))) }); } catch {}
}
suites.sort((left, right) => left.runId.localeCompare(right.runId));
async function sourceFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (/\.local\./.test(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await sourceFiles(path);
    else files[relative(root, path).replaceAll('\\', '/')] = await readFile(path);
  }
}
for (const directory of ['src', 'fixtures', 'deploy']) await sourceFiles(resolve(root, directory));
for (const name of ['package.json', 'package-lock.json', '.dockerignore']) files[name] = await readFile(resolve(root, name));
const resources = await readJson(resolve(evidence, 'latest-resources.json')), t2 = await readJson(resolve(evidence, 'latest-t2.json')), t3 = await readJson(resolve(evidence, 'latest-t3.json'));
const jobs = [];
for (const item of resources.cases.filter(item => item.report)) {
  const report = await readJson(resolve(evidence, item.report));
  jobs.push({ runId: report.runId, fixture: report.fixture, probe: report.probe, status: report.status, failureCategory: report.failureCategory, faultObserved: report.faultObserved, durationMs: Date.parse(report.finishedAt) - Date.parse(report.startedAt), memoryPeakBytes: Number(report.resourceUsage['memory.peak']), memoryEvents: report.resourceUsage['memory.events'], cpuStat: report.resourceUsage['cpu.stat'], pidsPeak: Number(report.resourceUsage['pids.peak']), report: item.report });
}
const statsFile = (await readdir(evidence)).filter(name => /^docker-stats-.*\.json$/.test(name)).sort().at(-1);
const stats = await readJson(resolve(evidence, statsFile));
let ecs = null;
try { ecs = await readJson(resolve(evidence, 'ecs-m05-integrity.json')); } catch {}
const localPassed = t2.status === 'PASS' && t3.status === 'PASS' && resources.status === 'PASS';
const cloudPassed = ecs?.status === 'PASS';
const regular = jobs.filter(job => ['todo-good', 'todo-noop'].includes(job.fixture) && job.probe === 'none');
const summary = {
  schemaVersion: 1, capturedAt: new Date().toISOString(), sourceTreeSha256: canonicalHash(files),
  meaning: 'Snapshot of src/fixtures/deploy/package/lock/dockerignore; not a Git commit or image digest',
  sourceFiles: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha(bytes)])),
  dockerImageId: (await readFile(resolve(evidence, 'docker-image-id.txt'), 'utf8')).trim(),
  fixtures: await readJson(resolve(root, 'artifacts/fixture-index.json')),
  latest: { t1Local: suites.filter(suite => suite.gate === 'T1' && suite.environment === 'LOCAL').at(-1), t1Docker: suites.filter(suite => suite.gate === 'T1' && suite.environment === 'DOCKER').at(-1), t2: { runId: t2.runId, status: t2.status }, t3: { runId: t3.runId, status: t3.status }, resources: { runId: resources.runId, status: resources.status } },
  resourceExperiment: { jobs, regularJobCount: regular.length, regularMemoryPeakRangeBytes: [Math.min(...regular.map(job => job.memoryPeakBytes)), Math.max(...regular.map(job => job.memoryPeakBytes))], regularDurationRangeMs: [Math.min(...regular.map(job => job.durationMs)), Math.max(...regular.map(job => job.durationMs))], maximumMemoryPeakBytes: Math.max(...jobs.map(job => job.memoryPeakBytes)), maximumPidsPeak: Math.max(...jobs.map(job => job.pidsPeak)), stats: statsFile, sampledCpuMaximumPercent: stats.peakSampledCpuPercent, sampleCount: stats.samples.length },
  gateDecision: !localPassed ? 'NO-GO' : cloudPassed ? 'GO' : 'CONDITIONAL GO', blocker: !localPassed ? 'A current local mandatory gate failed; inspect original reports' : cloudPassed ? null : 'M0.5 ECS not verified; latest instance status in ecs-status-before-m05.json', contract: 'User approved trusted-shell-v1 on 2026-10-14; original raw-top-navigation failure preserved', ECS_M05: cloudPassed ? 'VERIFIED; ecs-m05-integrity.json' : 'NOT_VERIFIED', ECS_M0: 'VERIFIED; m0-ecs-integrity.json',
};
await json(resolve(evidence, 'audit-summary.json'), summary);
await json(resolve(evidence, 'index.json'), { capturedAt: summary.capturedAt, suites, latest: summary.latest, auditSummary: 'audit-summary.json', originalM0CloudEvidence: 'm0-ecs-20261014/evidence', M0Integrity: 'm0-ecs-integrity.json', SSHPreview: 'm0-ecs-ssh-preview/summary.json', environment: 'environment.json' });
console.log(JSON.stringify({ sourceTreeSha256: summary.sourceTreeSha256, latest: summary.latest, resource: { regularMemoryPeakRangeBytes: summary.resourceExperiment.regularMemoryPeakRangeBytes, regularDurationRangeMs: summary.resourceExperiment.regularDurationRangeMs, maximumMemoryPeakBytes: summary.resourceExperiment.maximumMemoryPeakBytes, maximumPidsPeak: summary.resourceExperiment.maximumPidsPeak, sampledCpuMaximumPercent: stats.peakSampledCpuPercent, sampleCount: stats.samples.length } }));
