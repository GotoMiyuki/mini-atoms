import { resolve } from 'node:path';
import { fixture, fixtureNames } from './fixtures.mjs';
import { buildSource } from '../controlled-build/index.mjs';
import { root, json } from '../shared.mjs';
const index = {};
for (const name of fixtureNames) { index[name] = await buildSource(await fixture(name)); console.log(JSON.stringify({ fixture: name, sourceSha256: index[name].sourceSha256, buildSha256: index[name].buildSha256, versionId: index[name].versionId })); }
await json(resolve(root, 'artifacts/fixture-index.json'), index);
