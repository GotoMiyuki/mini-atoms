import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { root, readJson, sha } from '../shared.mjs';
const artifactsRoot = process.env.ARTIFACTS_ROOT || resolve(root, 'artifacts');
const canary = process.env.SERVER_ROLE === 'main-canary';
const server = createServer(async (request, response) => {
  function send(code, body, type = 'application/json', headers = {}) {
    response.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-DNS-Prefetch-Control': 'off', 'Vary': 'Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site', ...headers });
    response.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  }
  try {
    if (request.method !== 'GET') return send(405, { error: 'Static GET only' });
    const address = new URL(request.url, 'http://preview'), path = address.pathname;
    if (address.search) return send(400, { error: 'Query parameters are not accepted' });
    if (path === '/healthz') return send(200, { status: 'ok', role: canary ? 'main-canary' : 'preview-static' });
    if (path === '/protected-api' || canary) return send(401, { error: 'No authorization for this harmless main API canary' });
    const shell = /^\/(preview|harness)\/([a-f0-9]{64})$/.exec(path);
    if (shell) {
      const [, role, version] = shell;
      await readJson(resolve(artifactsRoot, version, 'build-manifest.json'));
      const nonce = randomBytes(24).toString('base64');
      const script = "localStorage.setItem('m05-main-marker','MAIN-STORAGE-CANARY'); document.cookie='m05_canary=MAIN-COOKIE-CANARY; SameSite=Strict';";
      const frame = role === 'preview'
        ? `<iframe title="Generated preview" data-testid="preview-frame" sandbox="allow-scripts" src="/builds/${version}/index.html" width="1050" height="650"></iframe>`
        : `<iframe title="Trusted preview shell" data-testid="shell-frame" src="/preview/${version}" width="1070" height="740"></iframe>`;
      return send(200, `<!doctype html><html><head><meta charset="utf-8"><title>M0.5 trusted ${role}</title></head><body><p id="main-marker">MAIN-DOM-CANARY</p>${frame}<script nonce="${nonce}">${script}</script></body></html>`, 'text/html', { 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; frame-src 'self'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors ${role === 'preview' ? "'self'" : "'none'"}` });
    }
    const match = /^\/builds\/([a-f0-9]{64})\/(index\.html|app\.js|app\.css)$/.exec(path);
    if (!match) return send(404, { error: 'No allowlisted artifact at this path' });
    const [, version, name] = match;
    // Browser-generated metadata is mandatory. An absent/unknown context fails
    // closed. This is an execution-context guard, not secrecy/authentication.
    if (name === 'index.html' && (request.headers['sec-fetch-dest'] !== 'iframe' || request.headers['sec-fetch-mode'] !== 'navigate' || request.headers['sec-fetch-site'] !== 'same-origin')) {
      return send(403, { error: 'Generated HTML requires a same-origin iframe navigation' }, 'application/json', { 'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'none'" });
    }
    const manifest = await readJson(resolve(artifactsRoot, version, 'build-manifest.json'));
    if (!Object.hasOwn(manifest.assets, name)) return send(404, { error: 'Unknown build asset' });
    const bytes = await readFile(resolve(artifactsRoot, version, name));
    if (sha(bytes) !== manifest.assets[name].sha256) return send(500, { error: 'Artifact integrity mismatch' });
    const host = request.headers.host;
    if (!/^[a-zA-Z0-9_.:[\]-]+$/.test(host || '')) return send(400, { error: 'Invalid host' });
    const base = `http://${host}/builds/${version}`;
    const csp = `sandbox allow-scripts; default-src 'none'; script-src ${base}/app.js; style-src ${base}/app.css; connect-src 'none'; img-src 'none'; font-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'`;
    send(200, bytes, name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', { 'Content-Security-Policy': csp, 'X-M0-5-Build-SHA256': manifest.buildSha256, 'X-M0-5-Source-SHA256': manifest.sourceSha256 });
  } catch (error) { send(404, { error: 'Artifact unavailable' }); }
});
server.requestTimeout = 10000;
server.headersTimeout = 5000;
server.listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log(JSON.stringify({ service: canary ? 'main-canary' : 'preview-static', port: Number(process.env.PORT || 8080) })));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(() => process.exit(0)));
