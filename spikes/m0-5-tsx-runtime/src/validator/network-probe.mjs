import net from 'node:net';
import { Resolver } from 'node:dns/promises';
import { access, readFile } from 'node:fs/promises';
import { json } from '../shared.mjs';
async function connect(host, port) {
  return new Promise(done => {
    const socket = net.connect({ host, port }); let complete = false;
    const finish = result => { if (complete) return; complete = true; socket.destroy(); done(result); };
    socket.setTimeout(1200, () => finish({ connected: false, error: 'TIMEOUT' }));
    socket.once('connect', () => finish({ connected: true }));
    socket.once('error', error => finish({ connected: false, error: error.code }));
  });
}
const checks = [];
for (const [name, host, port, expected] of [['preview', 'preview', 8080, true], ['public-egress', '1.1.1.1', 443, false], ['public-ipv6-egress', '2606:4700:4700::1111', 443, false], ['link-local-metadata', '169.254.169.254', 80, false], ['aliyun-ecs-metadata', '100.100.100.200', 80, false], ['main-api-private-network', '172.30.245.2', 8080, false]]) {
  const actual = await connect(host, port);
  checks.push({ name, host, port, ...actual, status: actual.connected === expected ? 'PASS' : 'FAIL' });
}
const resolver = new Resolver({ timeout: 500, tries: 1 });
try { const addresses = await resolver.resolve4('example.com'); checks.push({ name: 'external-DNS-disabled', addresses, status: 'FAIL' }); }
catch (error) { checks.push({ name: 'external-DNS-disabled', error: error.code, status: 'PASS' }); }
for (const path of ['/var/run/docker.sock', '/run/docker.sock', '/app/.env', '/app/db.sqlite']) {
  let readable = true;
  try { await access(path); } catch { readable = false; }
  checks.push({ name: 'sensitive-file-not-mounted', path, readable, status: readable ? 'FAIL' : 'PASS' });
}
const sensitiveVariables = Object.keys(process.env).filter(name => /(?:SECRET|TOKEN|ACCESS_KEY|API_KEY|PASSWORD|DATABASE_URL)/i.test(name));
checks.push({ name: 'no-secret-variables', names: sensitiveVariables, status: sensitiveVariables.length ? 'FAIL' : 'PASS' });
const report = { schemaVersion: 1, environment: process.env.SPIKE_ENV || 'DOCKER', executedAt: new Date().toISOString(), uid: process.getuid(), status: checks.every(check => check.status === 'PASS') ? 'PASS' : 'FAIL', checks, resolvConf: await readFile('/etc/resolv.conf', 'utf8'), routeTable: await readFile('/proc/net/route', 'utf8'), processStatus: (await readFile('/proc/self/status', 'utf8')).split('\n').filter(line => /^(Uid|CapEff|NoNewPrivs|Seccomp):/.test(line)) };
await json('/evidence/network-boundary.json', report);
console.log(JSON.stringify(report));
process.exitCode = report.status === 'PASS' ? 0 : 1;
