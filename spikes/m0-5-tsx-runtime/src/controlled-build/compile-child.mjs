import * as esbuild from 'esbuild';
import { createRequire } from 'node:module';
import { resolve, posix, sep } from 'node:path';
import { root } from '../shared.mjs';
import { policy, validateSource } from './policy.mjs';
import { inspectImports } from './inspect-imports.mjs';
const require = createRequire(import.meta.url);
const dependencyRoot = resolve(root, 'node_modules') + sep;
const entry = "import React from 'react'; import {createRoot} from 'react-dom/client'; import App from '../src/App.tsx'; createRoot(document.getElementById('root')).render(<App/>);";

process.once('message', async input => {
  try {
    const source = validateSource(input);
    inspectImports(source);
    const files = { ...source, '__platform__/main.tsx': entry };
    const plugin = { name: policy.version, setup(build) {
      build.onResolve({ filter: /.*/ }, args => {
        if (args.namespace === 'file' && args.importer.startsWith(dependencyRoot)) return undefined;
        if (args.kind === 'entry-point') return { path: '__platform__/main.tsx', namespace: 'generated' };
        if (args.kind === 'dynamic-import' || args.kind === 'require-call' || args.kind === 'url-token' || args.kind === 'import-rule') throw new Error(`Import kind is forbidden: ${args.kind}`);
        if (args.path.startsWith('.')) {
          if (args.path.includes('\\') || args.path.split('/').includes('..') && args.importer !== '__platform__/main.tsx') throw new Error('Path traversal import forbidden');
          const base = posix.join(posix.dirname(args.importer), args.path);
          const name = [base, `${base}.tsx`].find(candidate => Object.hasOwn(files, candidate));
          if (!name) throw new Error(`Unknown source import: ${args.path}`);
          return { path: name, namespace: 'generated' };
        }
        const allowed = args.importer === '__platform__/main.tsx' ? ['react', 'react-dom/client'] : policy.allowedBareImports;
        if (!allowed.includes(args.path)) throw new Error(`Dependency is forbidden: ${args.path}`);
        const name = require.resolve(args.path);
        if (!name.startsWith(dependencyRoot)) throw new Error('Dependency escaped fixed node_modules');
        return { path: name, namespace: 'file' };
      });
      build.onLoad({ filter: /.*/, namespace: 'generated' }, args => ({ contents: files[args.path], loader: args.path.endsWith('.css') ? 'css' : 'tsx' }));
    }};
    const result = await esbuild.build({
      entryPoints: ['__platform__/main.tsx'], bundle: true, write: false, outdir: '/compiled',
      platform: 'browser', format: 'iife', target: 'es2022', jsx: 'transform',
      define: { 'process.env.NODE_ENV': '"production"' }, minify: true, sourcemap: false,
      plugins: [plugin], logLevel: 'silent', legalComments: 'none',
    });
    const output = {};
    for (const file of result.outputFiles) output[file.path.endsWith('.css') ? 'app.css' : 'app.js'] = file.text;
    output['app.css'] ||= 'body{font-family:system-ui,sans-serif;margin:24px}';
    output['index.html'] = '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="app.css"><title>M0.5 Preview</title></head><body><div id="root"></div><script src="app.js"></script></body></html>';
    if (Object.values(output).reduce((size, text) => size + Buffer.byteLength(text), 0) > policy.maxOutputBytes) throw new Error('Build output size limit exceeded');
    await new Promise((done, reject) => process.send({ ok: true, output, toolVersion: esbuild.version }, error => error ? reject(error) : done()));
  } catch (error) { await new Promise(done => process.send({ ok: false, message: error.message, code: error.code || 'BUILD_REJECTED' }, done)); }
  finally { esbuild.stop(); process.disconnect(); }
});
