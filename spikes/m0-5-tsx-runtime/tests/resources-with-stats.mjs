import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { root, json, runId } from '../src/shared.mjs';
const execute = promisify(execFile), samples = [], errors = [];
const id = runId('docker-stats');
let finished = false;
const child = spawn(process.execPath, [resolve(root, 'src/spike-cli/run.mjs'), '--gate', 'resources'], { cwd: root, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
child.stdout.on('data', chunk => { stdout += chunk; });
child.stderr.on('data', chunk => { stderr += chunk; });
const completion = new Promise((done, reject) => {
  child.once('error', error => { finished = true; reject(error); });
  child.once('exit', code => { finished = true; done(code); });
});
completion.catch(() => {});
while (!finished && samples.length < 256) {
  try {
    const options = { cwd: root, windowsHide: true, timeout: 10000, maxBuffer: 131072 };
    const listed = await execute('docker', ['ps', '-q', '--filter', 'label=com.docker.compose.project=mini-atoms-m05', '--filter', 'label=com.docker.compose.service=validator'], options);
    const ids = listed.stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.length && ids.every(value => /^[a-f0-9]{12,64}$/.test(value))) {
      const result = await execute('docker', ['stats', '--no-stream', '--format', '{{json .}}', ...ids], options);
      for (const line of result.stdout.trim().split('\n').filter(Boolean)) samples.push({ capturedAt: new Date().toISOString(), ...JSON.parse(line) });
    }
  } catch (error) { errors.push({ capturedAt: new Date().toISOString(), message: error.message.slice(0, 1000) }); }
  if (!finished) await new Promise(done => setTimeout(done, 500));
}
const exitCode = await completion;
const peakSampledCpuPercent = Math.max(0, ...samples.map(sample => Number(sample.CPUPerc?.replace('%', '')) || 0));
await json(resolve(root, 'evidence', `${id}.json`), { environment: process.env.SPIKE_ENV || 'DOCKER', exitCode, status: exitCode === 0 && samples.length ? 'PASS' : 'FAIL', peakSampledCpuPercent, meaning: 'docker stats observations only; sampled maximum is not guaranteed instantaneous peak. Exact memory.peak and CPU counters are in worker cgroup reports.', samples, errors, controllerStdout: stdout, controllerStderr: stderr });
console.log(JSON.stringify({ status: exitCode === 0 && samples.length ? 'PASS' : 'FAIL', samples: samples.length, peakSampledCpuPercent, report: `evidence/${id}.json` }));
process.exitCode = exitCode || (samples.length ? 0 : 1);
