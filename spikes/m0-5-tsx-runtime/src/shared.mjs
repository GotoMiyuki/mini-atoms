import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
export const root = resolve(import.meta.dirname, '..');
export const sha = data => createHash('sha256').update(data).digest('hex');
export const runId = prefix => `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
export async function json(path, value) { await mkdir(resolve(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2) + '\n'); }
export async function readJson(path) { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); }
export function canonicalHash(files) {
  const hash = createHash('sha256');
  for (const name of Object.keys(files).sort()) {
    const bytes = Buffer.from(files[name]);
    hash.update(`${Buffer.byteLength(name)}:${name}:${bytes.length}:`).update(bytes);
  }
  return hash.digest('hex');
}
