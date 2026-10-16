import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { request } from 'node:http';
import { root, readJson, json, runId, sha } from '../src/shared.mjs';
const index = await readJson(resolve(root, 'artifacts/fixture-index.json')), manifest = index['todo-good'];
const origin = 'http://127.0.0.1:8091', path = `/builds/${manifest.versionId}/index.html`, checks = [];
const valid = { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'same-origin' };
const cases = [
  ['missing-metadata', {}, 403],
  ['top-level-document', { ...valid, 'sec-fetch-dest': 'document' }, 403],
  ['fetch-not-navigation', { ...valid, 'sec-fetch-mode': 'cors' }, 403],
  ['cross-site-iframe', { ...valid, 'sec-fetch-site': 'cross-site' }, 403],
  ['missing-destination', { ...valid, 'sec-fetch-dest': '' }, 403],
  ['same-origin-iframe-control', valid, 200],
];
for (const [name, headers, expected] of cases) {
  const response = await new Promise((done, reject) => {
    const task = request(`${origin}${path}`, { headers }, result => { const bytes = []; result.on('data', chunk => bytes.push(chunk)); result.once('end', () => done({ status: result.statusCode, headers: result.headers, bytes: Buffer.concat(bytes) })); result.once('error', reject); });
    task.once('error', reject); task.end();
  });
  assert.equal(response.status, expected, name);
  if (expected === 200) assert.equal(sha(response.bytes), manifest.assets['index.html'].sha256);
  else assert.equal(response.headers['content-type'], 'application/json');
  checks.push({ name, status: 'PASS', httpStatus: response.status, headers });
}
for (const [name, target, options, expected] of [
  ['trusted-shell', `/preview/${manifest.versionId}`, {}, 200],
  ['trusted-main-harness', `/harness/${manifest.versionId}`, {}, 200],
  ['protected-api-unauthenticated', '/protected-api', {}, 401],
  ['private-source', '/src/validator/worker.mjs', {}, 404],
  ['query-rejected', `${path}?url=http://169.254.169.254`, { headers: valid }, 400],
  ['post-rejected', path, { method: 'POST', headers: valid }, 405],
]) {
  const response = await fetch(`${origin}${target}`, options);
  assert.equal(response.status, expected, name);
  checks.push({ name, status: 'PASS', httpStatus: response.status });
}
const id = runId('preview-headers');
await json(resolve(root, 'evidence', `${id}.json`), { environment: process.env.SPIKE_ENV || 'DOCKER', status: 'PASS', checks, meaning: 'HTTP guard truth table; actual browser-generated metadata and raw top-level refusal separately proven by security workers.' });
console.log(JSON.stringify({ status: 'PASS', checks: checks.length, report: `evidence/${id}.json` }));
