import { spawn } from 'node:child_process';
import { unlinkSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mkdir, writeFile, readFile, lstat, access, unlink, readdir, chown } from 'node:fs/promises';
import { root, json, readJson, sha, runId } from '../shared.mjs';
import { plans, validateJob } from '../validator/plans.mjs';
const gateIndex = process.argv.indexOf('--gate'), gate = gateIndex < 0 ? 't2' : process.argv[gateIndex + 1];
if (!['t2', 't3', 'resources'].includes(gate)) throw new Error('Gate must be t2, t3 or resources');
const environment = process.env.SPIKE_ENV || 'DOCKER';
await mkdir(resolve(root, '.local'), { recursive: true });
const lockFile = resolve(root, '.local/controller.lock'), lockToken = runId('lock');
try { await writeFile(lockFile, JSON.stringify({ pid: process.pid, token: lockToken }), { flag: 'wx' }); }
catch (error) { if (error.code !== 'EEXIST') throw error; console.log(JSON.stringify({ status: 'REJECTED', code: 'GLOBAL_BUSY' })); process.exit(4); }
process.once('exit', () => { try { if (JSON.parse(readFileSync(lockFile, 'utf8')).token === lockToken) unlinkSync(lockFile); } catch {} });
const suiteId = runId(gate), directory = resolve(root, 'evidence', suiteId);
await mkdir(directory, { recursive: true });
await mkdir(resolve(root, '.local/jobs'), { recursive: true });
const index = await readJson(resolve(root, 'artifacts/fixture-index.json'));
const cases = [];
async function workerOutput(directory) {
  await mkdir(directory, { mode: 0o700 });
  // Linux bind mounts preserve UID/mode; Windows Docker mounts do not expose
  // this difference. Only the trusted root controller adjusts its own new dir.
  if (process.platform === 'linux' && process.getuid() === 0) await chown(directory, 1001, 1001);
}
async function docker(args, env = {}, timeoutMs = 90000) {
  return dockerCommand(['compose', '-f', resolve(root, 'deploy/compose.yml'), ...args], env, timeoutMs);
}
async function dockerCommand(args, env = {}, timeoutMs = 90000) {
  return new Promise((done, reject) => {
    const child = spawn('docker', args, { cwd: root, env: { ...process.env, ...env, SPIKE_ENV: environment }, windowsHide: true, shell: false });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { if (stdout.length < 262144) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < 262144) stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Controller command exceeded its bounded execution time')); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); done({ exitCode: code, stdout, stderr }); });
  });
}
async function captureBoundary(jobId, output) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const inspected = await dockerCommand(['inspect', jobId, '--format', '{{json .}}'], {}, 5000);
    if (inspected.exitCode === 0) {
      const container = JSON.parse(inspected.stdout), host = container.HostConfig;
      if (container.State.Running) {
        const safe = { capturedAt: new Date().toISOString(), name: container.Name, user: container.Config.User, state: container.State, hostConfig: { readonlyRootfs: host.ReadonlyRootfs, privileged: host.Privileged, capAdd: host.CapAdd, capDrop: host.CapDrop, securityOpt: host.SecurityOpt, memory: host.Memory, nanoCpus: host.NanoCpus, pidsLimit: host.PidsLimit, ipcMode: host.IpcMode, shmSize: host.ShmSize, dns: host.Dns, tmpfs: host.Tmpfs }, mounts: container.Mounts, networks: Object.keys(container.NetworkSettings.Networks), environmentVariableNames: container.Config.Env.map(value => value.split('=', 1)[0]) };
        await json(resolve(output, 'container-boundary.json'), safe);
        const mounts = Object.fromEntries(safe.mounts.map(item => [item.Destination, item]));
        if (safe.user !== '1001:1001' || !host.ReadonlyRootfs || host.Privileged || host.CapAdd?.length || !host.CapDrop?.includes('ALL') || !host.SecurityOpt?.includes('no-new-privileges:true') || !host.SecurityOpt.some(value => value.startsWith('seccomp=') && !value.includes('unconfined')) || host.Memory !== 1073741824 || host.NanoCpus !== 1000000000 || host.PidsLimit !== 192 || host.IpcMode !== 'private' || host.ShmSize !== 268435456 || host.Dns?.join(',') !== '127.0.0.1' || safe.networks.join(',') !== 'mini-atoms-m05_browser' || Object.keys(mounts).sort().join(',') !== '/app/artifacts,/evidence,/jobs/job.json' || mounts['/app/artifacts'].RW || mounts['/jobs/job.json'].RW || !mounts['/evidence'].RW) throw new Error('Actual worker container boundary does not match mandatory policy');
        return { path: 'container-boundary.json', sha256: sha(await readFile(resolve(output, 'container-boundary.json'))) };
      }
    }
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error('Could not capture actual running worker boundary');
}
async function jobCase(fixture, presentation, expected, probe = 'none', modify) {
  if ((await readdir(resolve(root, '.local/jobs'))).length >= 32) throw new Error('Job inbox capacity reached');
  const jobId = runId(fixture), output = resolve(directory, jobId), file = resolve(root, '.local/jobs', `${jobId}.json`);
  await workerOutput(output);
  const job = { schemaVersion: '0.1', jobId, fixture, presentation, testPlan: structuredClone(plans[fixture]), probe };
  if (modify) modify(job);
  await json(file, job);
  await json(resolve(output, 'job.json'), job);
  // Cleanup targets only this controller's freshly generated container name.
  const executionPromise = docker(['run', '--rm', '--no-deps', '-T', '--name', jobId, '-e', `SPIKE_ENV=${environment}`, '-e', `M05_JOB_ID=${jobId}`, 'validator'], { M05_JOB_FILE: file, M05_OUTPUT_DIR: output });
  executionPromise.catch(() => {});
  const boundaryPromise = expected === 'UNVERIFIED' || probe === 'preview-unavailable' ? Promise.resolve(null) : captureBoundary(jobId, output);
  boundaryPromise.catch(() => {});
  let execution, boundary, previewStopped = false;
  try {
    if (probe === 'preview-disconnect') {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { await access(resolve(output, 'phase.json')); ready = true; break; } catch {}
        await new Promise(done => setTimeout(done, 200));
      }
      if (!ready) throw new Error('Worker did not reach the real preview disconnect checkpoint');
      previewStopped = true;
      await json(resolve(output, 'preview-stop.json'), await docker(['stop', 'preview']));
    }
    execution = await executionPromise;
    boundary = await boundaryPromise;
  } catch (exception) {
    await json(resolve(output, 'forced-container-cleanup.json'), await dockerCommand(['container', 'rm', '--force', jobId], {}, 10000));
    await executionPromise.catch(() => {});
    throw exception;
  } finally {
    if (previewStopped) await json(resolve(output, 'preview-restart.json'), await docker(['up', '-d', '--wait', 'preview']));
    await unlink(file);
  }
  await json(resolve(output, 'container-execution.json'), execution);
  const reportPath = resolve(output, 'report.json');
  const size = (await lstat(reportPath)).size;
  if (size > 131072) throw new Error('Untrusted report size limit exceeded');
  const report = await readJson(reportPath);
  if (report.runId !== jobId || !['PASS', 'FAIL', 'ERROR', 'UNVERIFIED'].includes(report.status) || expected !== 'UNVERIFIED' && (report.fixture !== fixture || report.buildSha256 !== index[fixture].buildSha256) || expected === 'UNVERIFIED' && report.failureCategory !== 'INVALID_TEST_PLAN') throw new Error('Untrusted worker result schema/identity mismatch');
  const artifactHashes = {};
  for (const [name, hash] of Object.entries(report.artifactSha256)) {
    if (!['before.png', 'after.png', 'raw-top-denied.png', 'browser-log.json', 'trace.zip', 'sandbox-status.json', 'process-boundary.json', 'security-probe.json', 'static-transport.json'].includes(name) || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid worker artifact reference');
    const artifactPath = resolve(output, name), info = await lstat(artifactPath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 10485760) throw new Error('Worker artifact type/size rejected');
    if (sha(await readFile(artifactPath)) !== hash) throw new Error('Worker artifact hash mismatch');
    artifactHashes[name] = hash;
  }
  const expectedExit = { PASS: 0, FAIL: 1, ERROR: 2, UNVERIFIED: 3 }[expected];
  const accepted = report.status === expected && execution.exitCode === expectedExit && (!['preview-unavailable', 'browser-crash', 'preview-disconnect', 'resource-timeout'].includes(probe) || report.faultObserved === true);
  const item = { jobId, fixture, presentation, probe, expected, actual: report.status, status: accepted ? 'PASS' : 'FAIL', failureCategory: report.failureCategory, report: `${suiteId}/${jobId}/report.json`, reportSha256: sha(await readFile(reportPath)), artifactsVerified: true, containerBoundary: boundary, memoryPeakBytes: Number(report.resourceUsage['memory.peak']) || null, exitCode: execution.exitCode };
  cases.push(item); console.log(JSON.stringify(item));
  return report;
}
let error = null;
try {
  if (gate !== 't2' && (await readJson(resolve(root, 'evidence/latest-t2.json'))).status !== 'PASS') throw new Error('T2 must pass before further local experiments');
  const up = await docker(['up', '-d', '--wait', 'preview', 'main-canary']);
  await json(resolve(directory, 'services-start.json'), up);
  if (up.exitCode !== 0) throw new Error(`Preview services unavailable: ${up.stderr}`);
  if (gate === 't2') {
    for (const presentation of ['direct', 'iframe']) {
      await jobCase('todo-good', presentation, 'PASS');
      await jobCase('todo-noop', presentation, 'FAIL');
      await jobCase('counter-good', presentation, 'PASS');
    }
    await jobCase('todo-good', 'direct', 'ERROR', 'preview-unavailable');
    await jobCase('todo-good', 'direct', 'UNVERIFIED', 'none', job => { job.testPlan.tests[0].steps[0].action = 'evaluate'; });
  } else if (gate === 't3') {
    for (const field of ['url', 'shell', 'evaluate', 'unknown']) await jobCase('todo-good', 'direct', 'UNVERIFIED', 'none', job => { job[field] = 'untrusted-extra-field'; });
    await jobCase('todo-good', 'direct', 'UNVERIFIED', 'none', job => { job.testPlan.tests[0].steps[0].target = 'body > *'; });
    await jobCase('todo-good', 'direct', 'UNVERIFIED', 'none', job => { job.testPlan.tests[0].steps = Array.from({ length: 21 }, () => ({ action: 'click', target: 'add-button' })); });
    await jobCase('todo-good', 'direct', 'UNVERIFIED', 'none', job => { job.oversized = 'x'.repeat(40000); });
    for (const presentation of ['iframe', 'direct']) await jobCase('security-probe', presentation, 'PASS');
    const networkOutput = resolve(directory, 'network'); await workerOutput(networkOutput);
    const file = resolve(root, '.local/jobs', 'network-placeholder.json'); await json(file, { placeholder: true });
    const execution = await docker(['run', '--rm', '--no-deps', '-T', '-e', `SPIKE_ENV=${environment}`, 'validator', 'node', 'src/validator/network-probe.mjs'], { M05_JOB_FILE: file, M05_OUTPUT_DIR: networkOutput });
    await json(resolve(networkOutput, 'container-execution.json'), execution);
    const report = await readJson(resolve(networkOutput, 'network-boundary.json'));
    await unlink(file);
    cases.push({ name: 'independent-network-and-file-boundaries', expected: 'PASS', actual: report.status, status: report.status === 'PASS' && execution.exitCode === 0 ? 'PASS' : 'FAIL', report: `${suiteId}/network/network-boundary.json` });
  } else {
    const concurrency = await new Promise((done, reject) => {
      const child = spawn(process.execPath, [import.meta.filename, '--gate', 't2'], { cwd: root, shell: false, windowsHide: true });
      let stdout = ''; child.stdout.on('data', chunk => stdout += chunk); child.once('error', reject); child.once('exit', exitCode => done({ exitCode, stdout }));
    });
    cases.push({ name: 'concurrent-controller-rejected', status: concurrency.exitCode === 4 && concurrency.stdout.includes('GLOBAL_BUSY') ? 'PASS' : 'FAIL', ...concurrency });
    await jobCase('todo-good', 'direct', 'ERROR', 'browser-crash');
    await jobCase('todo-good', 'direct', 'ERROR', 'preview-disconnect');
    await jobCase('cpu-loop', 'direct', 'ERROR', 'resource-timeout');
    for (let round = 0; round < 3; round++) { await jobCase('todo-good', 'iframe', 'PASS'); await jobCase('todo-noop', 'iframe', 'FAIL'); }
  }
  const preview = await fetch('http://127.0.0.1:8091/healthz', { signal: AbortSignal.timeout(3000) });
  cases.push({ name: 'preview-service-remains-healthy', status: preview.ok ? 'PASS' : 'FAIL', httpStatus: preview.status });
  const mainHealth = await docker(['exec', '-T', 'main-canary', 'node', '-e', 'Promise.all([fetch("http://127.0.0.1:8080/healthz"),fetch("http://127.0.0.1:8080/protected-api")]).then(async ([health,api])=>{const body=await health.json();console.log(JSON.stringify({httpStatus:health.status,role:body.role,unauthenticatedAPIStatus:api.status}));process.exitCode=health.ok&&body.role==="main-canary"&&api.status===401?0:1;}).catch(()=>process.exitCode=1)']);
  await json(resolve(directory, 'main-health-after.json'), mainHealth);
  cases.push({ name: 'main-service-remains-healthy-and-protected', status: mainHealth.exitCode === 0 ? 'PASS' : 'FAIL', ...JSON.parse(mainHealth.stdout || '{}') });
} catch (exception) { error = exception.message; console.error(error); }
const report = { schemaVersion: 1, runId: suiteId, gate: gate.toUpperCase(), environment, finishedAt: new Date().toISOString(), status: !error && cases.every(item => item.status === 'PASS') ? 'PASS' : 'FAIL', error, cases };
await json(resolve(directory, 'report.json'), report);
await json(resolve(root, 'evidence', `latest-${gate}.json`), { ...report, evidenceDirectory: directory });
console.log(JSON.stringify({ gate: report.gate, status: report.status, report: `evidence/${suiteId}/report.json` }));
process.exitCode = report.status === 'PASS' ? 0 : 1;
