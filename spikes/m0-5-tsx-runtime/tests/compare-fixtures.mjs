import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { root, readJson, json } from '../src/shared.mjs';
const expected = await readJson(resolve(root, 'expected-fixtures.json'));
const actual = await readJson(resolve(root, 'artifacts/fixture-index.json'));
const identities = [];
for (const name of Object.keys(expected)) {
  for (const field of ['versionId', 'sourceSha256', 'buildSha256', 'configurationSha256', 'assets', 'sourceFiles', 'tool']) assert.deepEqual(actual[name][field], expected[name][field], `${name}.${field}`);
  identities.push({ fixture: name, sourceSha256: actual[name].sourceSha256, buildSha256: actual[name].buildSha256, versionId: actual[name].versionId });
}
await json(resolve(root, 'evidence/cross-environment-builds.json'), { status: 'PASS', environment: process.env.SPIKE_ENV || 'ECS', capturedAt: new Date().toISOString(), identities });
console.log(JSON.stringify({ status: 'PASS', fixtures: identities.length, meaning: 'ECS compiler output/source/config/asset bytes match frozen Docker baseline' }));
