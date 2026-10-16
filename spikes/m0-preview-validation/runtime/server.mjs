import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import { validate, scenarios } from './validator.mjs';

const root = resolve(import.meta.dirname, '..');
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json' };
const digest = (text) => createHash('sha256').update(text).digest();

export async function createPreview({ port = Number(process.env.PORT || 8080), host = process.env.HOST || '127.0.0.1', evidenceRoot = resolve(root, 'evidence'), token = process.env.M0_RUN_TOKEN } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
  const version = JSON.parse(await readFile(resolve(root, 'dist/version.json'), 'utf8'));
  let origin, busy = false;
  const server = createServer(async (request, response) => {
    const send = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(data));
    };
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/healthz' && request.method === 'GET') return send(200, { status: 'ok', ...version });
      if (url.pathname === '/api/runs') {
        if (!token) return send(503, { error: 'Test API disabled: configure M0_RUN_TOKEN' });
        const supplied = request.headers['x-m0-run-token'];
        if (typeof supplied !== 'string' || !timingSafeEqual(digest(supplied), digest(token))) return send(401, { error: 'Unauthorized' });
        if (request.method !== 'POST') return send(405, { error: 'Use POST' });
        if (url.search) return send(400, { error: 'Query parameters are not accepted' });
        if (!request.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'Use application/json' });
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body) > 1024) return send(413, { error: 'Body too large' });
        }
        let input;
        try { input = JSON.parse(body); } catch { return send(400, { error: 'Invalid JSON' }); }
        if (!input || Array.isArray(input) || Object.keys(input).length !== 1 || !scenarios.includes(input.scenario)) {
          return send(400, { error: 'Only { scenario: normal | fault } is accepted' });
        }
        if (busy) return send(409, { error: 'A browser run is already active' });
        busy = true;
        try {
          const report = await validate({ origin, version, scenario: input.scenario, evidenceRoot });
          // Return all artifacts in the same request: no reliance on the next request reaching the same cloud instance.
          const files = {};
          for (const name of Object.values(report.artifacts).filter(Boolean)) {
            files[name] = (await readFile(resolve(report.evidenceDirectory, name))).toString('base64');
          }
          return send(200, { report, files });
        } finally { busy = false; }
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return send(405, { error: 'Method not allowed' });
      // Only the fixed build manifest is served; no arbitrary filesystem paths or SPA catch-all.
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!Object.hasOwn(version.assets, name)) return send(404, { error: 'Not found' });
      const content = await readFile(resolve(root, 'dist', name));
      const extension = name.slice(name.lastIndexOf('.'));
      response.writeHead(200, {
        'Content-Type': types[extension] || 'application/octet-stream', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      console.error('Runtime request failed:', error.message);
      if (!response.headersSent) send(500, { error: 'Runtime error; inspect server logs' });
      else response.end();
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 10000;
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, host, done); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, version, evidenceRoot, close: () => new Promise((done, reject) => server.close((error) => error ? reject(error) : done())) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const preview = await createPreview();
  console.log(JSON.stringify({ preview: preview.origin, appVersion: preview.version.appVersion, apiEnabled: Boolean(process.env.M0_RUN_TOKEN) }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await preview.close(); process.exit(0); });
}
