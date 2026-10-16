import { createServer, request as httpRequest } from 'node:http';
const port = 8765;
const allowed = /^(?:\/healthz|\/(?:preview|harness)\/[a-f0-9]{64}|\/builds\/[a-f0-9]{64}\/(?:index\.html|app\.js|app\.css))$/;

// Fixed static-only transport: no target URL, API path, credentials or commands.
// localhost is potentially trustworthy, so Chromium sends real Fetch Metadata.
export async function startStaticLoopback() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const record = { path: request.url?.slice(0, 256), method: request.method, fetchDest: request.headers['sec-fetch-dest'] || null, fetchMode: request.headers['sec-fetch-mode'] || null, fetchSite: request.headers['sec-fetch-site'] || null };
    if (requests.length < 128) requests.push(record);
    if (request.method !== 'GET' || request.headers.host !== `127.0.0.1:${port}` || !allowed.test(request.url || '')) {
      record.status = 403; response.writeHead(403, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' }); response.end('{"error":"Static path rejected"}'); return;
    }
    try {
      const headers = { host: `127.0.0.1:${port}` };
      for (const name of ['sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site']) if (typeof request.headers[name] === 'string') headers[name] = request.headers[name];
      record.forwardedMetadata = Object.fromEntries(Object.entries(headers).filter(([name]) => name.startsWith('sec-fetch-')));
      // Native HTTP preserves Chromium's metadata verbatim. Node fetch rewrites
      // Sec-Fetch-Mode to cors, which would invalidate a real iframe navigation.
      const result = await new Promise((done, reject) => {
        const upstream = httpRequest({ hostname: 'preview', port: 8080, path: request.url, method: 'GET', headers }, incoming => {
          const chunks = []; let total = 0;
          incoming.on('data', chunk => { total += chunk.length; if (total > 1048576) { incoming.destroy(new Error('Static response size limit exceeded')); } else chunks.push(chunk); });
          incoming.once('error', reject);
          incoming.once('end', () => done({ status: incoming.statusCode, headers: incoming.headers, bytes: Buffer.concat(chunks) }));
        });
        upstream.setTimeout(4000, () => upstream.destroy(new Error('Fixed preview upstream timed out')));
        upstream.once('error', reject); upstream.end();
      });
      record.status = result.status;
      const outgoing = {};
      for (const name of ['content-type', 'content-security-policy', 'cache-control', 'vary', 'x-content-type-options', 'x-dns-prefetch-control', 'x-m0-5-build-sha256', 'x-m0-5-source-sha256']) if (result.headers[name]) outgoing[name] = result.headers[name];
      response.writeHead(result.status, outgoing); response.end(result.bytes);
    } catch { record.status = 502; response.writeHead(502, { 'Content-Type': 'application/json' }); response.end('{"error":"Fixed preview upstream unavailable"}'); }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 4000;
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  return { origin: `http://127.0.0.1:${port}`, requests, close: async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); } };
}
