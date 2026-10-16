import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { build } from 'vite';

const root = resolve(import.meta.dirname, '..');
const sourceFiles = ['index.html', 'src/main.jsx', 'src/style.css', 'package-lock.json', 'scripts/build.mjs'];
const hash = createHash('sha256');
for (const file of sourceFiles) {
  hash.update(file).update('\0').update(await readFile(resolve(root, file))).update('\0');
}
const sourceSha256 = hash.digest('hex');
const appVersion = `m0-${sourceSha256.slice(0, 16)}`;
await build({ root, define: { __APP_VERSION__: JSON.stringify(appVersion) } });
const assets = {};
for (const file of (await readdir(resolve(root, 'dist'), { recursive: true })).sort()) {
  if (!/\.(html|js|css)$/.test(file)) continue;
  assets[file.replaceAll('\\', '/')] = createHash('sha256')
    .update(await readFile(resolve(root, 'dist', file))).digest('hex');
}
await writeFile(resolve(root, 'dist/version.json'), JSON.stringify({
  appVersion, sourceSha256, assets, builtAt: new Date().toISOString(),
}, null, 2) + '\n');
console.log(`Built ${appVersion} at ${relative(process.cwd(), resolve(root, 'dist'))}`);
