import { fork } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { canonicalHash, sha, root, json, readJson } from '../shared.mjs';
import { policy, validateSource, BuildRejected } from './policy.mjs';
let busy = false;
export async function buildSource(input, artifactsRoot = resolve(root, 'artifacts')) {
  const files = validateSource(input);
  if (busy) throw new BuildRejected('Only one build may run at a time', 'BUILD_BUSY');
  busy = true;
  const startedAt = new Date().toISOString();
  try {
    const result = await new Promise((done, reject) => {
      const worker = fork(resolve(import.meta.dirname, 'compile-child.mjs'), [], { execArgv: ['--max-old-space-size=128'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } });
      let stderr = '', received = false, response;
      worker.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk; });
      const timer = setTimeout(() => { worker.kill(); reject(new BuildRejected('Build timeout', 'BUILD_TIMEOUT')); }, policy.timeoutMs);
      worker.once('error', error => { clearTimeout(timer); reject(error); });
      worker.once('message', message => { received = true; response = message; });
      worker.once('exit', code => { clearTimeout(timer); if (!received || code !== 0) reject(new BuildRejected(`Compiler exited ${code} without a valid result: ${stderr}`, 'BUILD_ERROR')); else done(response); });
      worker.send(input);
    });
    if (!result.ok) throw new BuildRejected(result.message, result.code);
    const sourceSha256 = canonicalHash(files), buildSha256 = canonicalHash(result.output);
    const configurationSha256 = canonicalHash({ policy: JSON.stringify(policy), compiler: await readFile(resolve(import.meta.dirname, 'compile-child.mjs')), ast: await readFile(resolve(import.meta.dirname, 'inspect-imports.mjs')), guard: await readFile(resolve(import.meta.dirname, 'policy.mjs')), controller: await readFile(import.meta.filename), lockfile: await readFile(resolve(root, 'package-lock.json')) });
    const versionId = sha(`${sourceSha256}:${buildSha256}:${configurationSha256}`);
    const directory = resolve(artifactsRoot, versionId);
    try { await access(resolve(directory, 'build-manifest.json')); return await readJson(resolve(directory, 'build-manifest.json')); } catch {}
    await mkdir(directory, { recursive: true });
    const assets = {};
    for (const [name, content] of Object.entries(result.output)) { await writeFile(resolve(directory, name), content); assets[name] = { sha256: sha(content), bytes: Buffer.byteLength(content) }; }
    const manifest = { schemaVersion: 1, versionId, sourceSha256, buildSha256, configurationSha256, policyVersion: policy.version, policySha256: sha(JSON.stringify(policy)), tool: { name: 'esbuild', version: result.toolVersion }, assets, sourceFiles: Object.keys(files).sort(), startedAt, finishedAt: new Date().toISOString() };
    await json(resolve(directory, 'build-manifest.json'), manifest);
    return manifest;
  } finally { busy = false; }
}
