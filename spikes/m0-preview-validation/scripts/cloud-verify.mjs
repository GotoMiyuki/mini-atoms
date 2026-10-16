import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const url = new URL(process.env.M0_SERVICE_URL || 'https://configure-service-url.invalid');
if (url.protocol !== 'https:' || !url.hostname.endsWith('.run.app') || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
  throw new Error('M0_SERVICE_URL must be the deployed Cloud Run HTTPS origin (*.run.app)');
}
if (!process.env.M0_RUN_TOKEN || !process.env.M0_ID_TOKEN) throw new Error('Set M0_RUN_TOKEN and M0_ID_TOKEN without committing credentials');
const cloudDirectory = resolve(import.meta.dirname, '../evidence/cloud', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(cloudDirectory, { recursive: true });
const results = [];
for (const [scenario, expectedStatus] of [['normal', 'PASS'], ['fault', 'FAIL']]) {
  // This URL addresses the control plane; the service always tests its own fixed localhost application.
  const response = await fetch(`${url.origin}/api/runs`, {
    method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${process.env.M0_ID_TOKEN}`,
      'X-M0-Run-Token': process.env.M0_RUN_TOKEN,
    },
    body: JSON.stringify({ scenario }), signal: AbortSignal.timeout(150000),
  });
  if (!response.ok) throw new Error(`Cloud invocation HTTP ${response.status}; credentials are not logged`);
  const { report, files } = await response.json();
  if (!/^[a-zA-Z0-9-]+$/.test(report.runId)) throw new Error('Invalid run ID');
  for (const name of Object.values(report.artifacts).filter(Boolean)) {
    if (typeof files?.[name] !== 'string') throw new Error(`Missing artifact: ${name}`);
  }
  if (JSON.stringify(JSON.parse(Buffer.from(files['report.json'], 'base64').toString())) !== JSON.stringify(report)) {
    throw new Error('Downloaded report differs from the API result');
  }
  const directory = resolve(cloudDirectory, report.runId);
  await mkdir(directory);
  for (const [name, encoded] of Object.entries(files)) {
    if (!['report.json', 'browser-log.json', 'before.png', 'after.png', 'trace.zip'].includes(name)) throw new Error('Unexpected artifact name');
    const content = Buffer.from(encoded, 'base64');
    if (name !== 'report.json' && createHash('sha256').update(content).digest('hex') !== report.artifactSha256[name]) throw new Error(`Artifact hash mismatch: ${name}`);
    await writeFile(resolve(directory, name), content);
  }
  const verified = report.status === expectedStatus && report.environment.platform === 'linux' &&
    Boolean(report.environment.cloudService && report.environment.cloudRevision) &&
    report.actualResult.interactionCompleted && report.artifacts.screenshot && report.artifacts.trace;
  results.push({ runId: report.runId, scenario, status: report.status, verified: Boolean(verified), appVersion: report.app.appVersion, cloudRevision: report.environment.cloudRevision });
  console.log(JSON.stringify(results.at(-1)));
}
const sameBuild = results[0].appVersion === results[1].appVersion && results[0].cloudRevision === results[1].cloudRevision;
const summary = {
  executedAt: new Date().toISOString(), serviceUrl: url.origin, sameBuild,
  status: sameBuild && results.every((result) => result.verified) ? 'CLOUD_VERIFIED' : 'CLOUD_NOT_VERIFIED', results,
};
await writeFile(resolve(cloudDirectory, 'cloud-summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ status: summary.status, directory: cloudDirectory }));
process.exitCode = summary.status === 'CLOUD_VERIFIED' ? 0 : 2;
