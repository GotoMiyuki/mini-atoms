import { readFile, readdir, lstat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { root } from '../shared.mjs';
export const fixtureNames = ['todo-good', 'todo-noop', 'counter-good', 'security-probe', 'cpu-loop'];
export async function fixture(name) {
  if (!fixtureNames.includes(name)) throw new Error('Unknown fixture');
  const directory = resolve(root, 'fixtures', name);
  const files = [];
  for (const entry of (await readdir(directory, { recursive: true })).sort()) {
    const path = resolve(directory, entry), stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('Symlink inputs rejected');
    if (stat.isFile()) files.push({ path: `src/${relative(directory, path).replaceAll('\\', '/')}`, content: await readFile(path, 'utf8') });
  }
  return { schemaVersion: '0.1', files };
}
