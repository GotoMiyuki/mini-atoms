import { chromium, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root, json, readJson, sha } from '../shared.mjs';
import { validateJob, InvalidPlan } from './plans.mjs';
import { startStaticLoopback } from './static-loopback.mjs';

const output = '/evidence', previewOrigin = 'http://preview:8080';
const startedAt = new Date().toISOString();
const logs = [], steps = [], artifacts = {}, requirements = [];
let browser, context, page, job, manifest, sandbox, timer, security, transport, exposure, crash = false, timedOut = false, documentReady = false, beforeActions = false, faultObserved = false;
let state = 'ERROR', status = 'ERROR', failureCategory = 'INFRASTRUCTURE', error = null, target, currentStep;
const uniqueValue = `m05-${randomUUID()}`;
const log = entry => { if (logs.length < 256) logs.push({ at: new Date().toISOString(), ...entry, text: entry.text?.slice(0, 2000) }); };
async function screenshot(name) { await page.screenshot({ path: resolve(output, name), fullPage: true, timeout: 2000 }); artifacts[name] = name; }
async function metrics() {
  const data = {};
  for (const name of ['memory.peak', 'memory.current', 'memory.max', 'memory.events', 'cpu.stat', 'pids.current', 'pids.peak', 'pids.max']) {
    try { data[name] = (await readFile(`/sys/fs/cgroup/${name}`, 'utf8')).trim(); } catch { data[name] = null; }
  }
  data.nodeMaxRssKiB = process.resourceUsage().maxRSS;
  return data;
}
async function processBoundaries() {
  const result = [];
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const command = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' ');
      if (!command.includes('/ms-playwright/') || !command.includes('chrome')) continue;
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      result.push({ pid: Number(pid), command: command.slice(0, 6000), status: status.split('\n').filter(line => /^(Uid|Gid|CapEff|NoNewPrivs|Seccomp|NSpid):/.test(line)) });
    } catch {}
  }
  return result;
}

try {
  const bytes = await readFile('/jobs/job.json');
  if (bytes.length > 32768) throw new InvalidPlan('Job exceeds bounded inbox entry size');
  job = JSON.parse(bytes.toString());
  validateJob(job);
  if (process.env.M05_JOB_ID && job.jobId !== process.env.M05_JOB_ID) throw new InvalidPlan('Controller and inbox job identity mismatch');
  manifest = (await readJson(resolve(root, 'artifacts/fixture-index.json')))[job.fixture];
  if (!manifest || !/^[a-f0-9]{64}$/.test(manifest.versionId)) throw new Error('Unknown immutable build manifest');
  if (process.getuid?.() === 0) throw new Error('Validator refuses to run as root');
  if (job.probe === 'preview-unavailable') {
    // Fixed closed port in this worker; the job cannot select a destination.
    try { await fetch('http://127.0.0.1:65534/healthz', { signal: AbortSignal.timeout(1000) }); }
    catch (exception) { faultObserved = exception.cause?.code === 'ECONNREFUSED'; throw exception; }
    throw new Error('Unavailable-preview probe unexpectedly connected');
  }
  const health = await fetch(`${previewOrigin}/healthz`, { signal: AbortSignal.timeout(3000) });
  if (!health.ok) throw new Error('Preview health failed');
  transport = await startStaticLoopback();
  browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: true, timeout: 15000 });
  const sandboxPage = await browser.newPage();
  await sandboxPage.goto('chrome://sandbox');
  const sandboxText = await sandboxPage.locator('body').innerText();
  sandbox = { requested: true, uid: process.getuid(), browserVersion: browser.version(), statusText: sandboxText };
  if (!/Layer 1 Sandbox\s+Namespace/.test(sandboxText) || !/PID namespaces\s+Yes/.test(sandboxText) || !/Seccomp-BPF sandbox\s+Yes/.test(sandboxText)) throw new Error('Chromium sandbox is not verified enabled');
  await json(resolve(output, 'sandbox-status.json'), sandbox); artifacts['sandbox-status.json'] = 'sandbox-status.json';
  await sandboxPage.close();
  context = await browser.newContext({ viewport: { width: 1100, height: 820 }, serviceWorkers: 'block', acceptDownloads: false });
  await context.tracing.start({ screenshots: true, snapshots: true });
  page = await context.newPage();
  page.setDefaultTimeout(2500);
  page.on('console', message => log({ type: `console.${message.type()}`, text: message.text() }));
  page.on('pageerror', exception => { crash = true; log({ type: 'pageerror', text: exception.message }); });
  page.on('crash', () => { crash = true; log({ type: 'crash', text: 'Renderer crashed' }); });
  page.on('requestfailed', request => log({ type: 'requestfailed', url: request.url(), text: request.failure()?.errorText }));
  page.on('response', response => log({ type: 'response', url: response.url(), status: response.status() }));
  page.on('download', () => log({ type: 'download', text: 'Unexpected download event' }));
  context.on('page', popup => { if (popup !== page) popup.opener().then(opener => { if (opener) log({ type: 'popup', url: popup.url() }); }).catch(() => {}); });
  // No Playwright routing interception is used as network isolation evidence.
  const path = `/builds/${manifest.versionId}/index.html`;
  const address = `${transport.origin}/${job.presentation === 'iframe' ? 'harness' : 'preview'}/${manifest.versionId}`;
  for (const name of ['app.js', 'app.css']) {
    const response = await fetch(`${previewOrigin}/builds/${manifest.versionId}/${name}`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok || sha(Buffer.from(await response.arrayBuffer())) !== manifest.assets[name].sha256) throw new Error('Preview asset integrity mismatch');
  }
  const generatedResponse = page.waitForResponse(response => response.url() === `${transport.origin}${path}` && response.request().resourceType() === 'document', { timeout: 10000 });
  generatedResponse.catch(() => {});
  await page.goto(address, { waitUntil: 'networkidle', timeout: 10000 });
  const assetResponse = await generatedResponse;
  if (!assetResponse.ok() || assetResponse.headers()['x-m0-5-build-sha256'] !== manifest.buildSha256 || sha(await assetResponse.body()) !== manifest.assets['index.html'].sha256) throw new Error('Browser-loaded Preview HTML/version integrity mismatch');
  exposure = { contract: 'trusted-shell-v1', generatedHTML: { status: assetResponse.status(), sha256: sha(await assetResponse.body()), requestHeaders: await assetResponse.request().allHeaders(), csp: assetResponse.headers()['content-security-policy'] } };
  if (exposure.generatedHTML.requestHeaders['sec-fetch-dest'] !== 'iframe' || exposure.generatedHTML.requestHeaders['sec-fetch-mode'] !== 'navigate' || exposure.generatedHTML.requestHeaders['sec-fetch-site'] !== 'same-origin') throw new Error('Real iframe Fetch Metadata not verified');
  target = job.presentation === 'iframe' ? page.frameLocator('[data-testid="shell-frame"]').frameLocator('[data-testid="preview-frame"]') : page.frameLocator('[data-testid="preview-frame"]');
  await target.locator('#root').waitFor({ state: 'attached' });
  documentReady = true;
  if (job.probe === 'browser-crash') {
    const session = await browser.newBrowserCDPSession();
    // Chromium may terminate without settling its pending CDP response. Keep a
    // bounded timer alive so the real disconnect can be recorded in Evidence.
    const disconnected = new Promise(done => {
      const deadline = setTimeout(() => done(false), 3000);
      browser.once('disconnected', () => { clearTimeout(deadline); done(true); });
    });
    session.send('Browser.crash').catch(() => {});
    faultObserved = await disconnected;
    throw new Error(faultObserved ? 'Real Chromium process disconnected after Browser.crash' : 'Browser crash probe did not disconnect Chromium');
  }
  await screenshot('before.png'); beforeActions = true;
  if (job.probe === 'preview-disconnect') {
    await json(resolve(output, 'phase.json'), { phase: 'ready-for-preview-stop' });
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise(done => setTimeout(done, 200));
      try { const response = await fetch(`${previewOrigin}/healthz`, { signal: AbortSignal.timeout(500) }); if (!response.ok) throw new Error('Preview stopped'); }
      catch { faultObserved = true; throw new Error('Preview disconnected after a real loaded browser page'); }
    }
    throw new Error('Expected preview disconnect did not occur');
  }
  timer = setTimeout(() => { timedOut = true; faultObserved = job.probe === 'resource-timeout'; browser?.close().catch(() => {}); }, job.probe === 'resource-timeout' ? 5000 : 15000);
  const locator = name => name === 'task-item' ? target.getByTestId(name).filter({ hasText: new RegExp(`^${uniqueValue}$`) }) : target.getByTestId(name);
  for (let index = 0; index < job.testPlan.tests[0].steps.length; index++) {
    const step = job.testPlan.tests[0].steps[index];
    currentStep = { index, ...step, startedAt: new Date().toISOString(), status: 'RUNNING' }; steps.push(currentStep);
    const element = locator(step.target), options = { timeout: step.timeoutMs || 2500 };
    if (step.action === 'fill') await element.fill(uniqueValue, options);
    else if (step.action === 'click') await element.click(options);
    else if (step.action === 'assertVisible') await expect(element).toBeVisible(options);
    else if (step.action === 'assertAbsent') await expect(element).toHaveCount(0, options);
    else if (step.action === 'assertCount') await expect(element).toHaveCount(step.expected, options);
    else if (step.action === 'assertValue') {
      if (step.target.endsWith('-input')) await expect(element).toHaveValue(step.expected, options);
      else await expect(element).toHaveText(step.expected, options);
    }
    currentStep.status = 'PASS'; currentStep.finishedAt = new Date().toISOString();
  }
  if (job.fixture === 'security-probe') {
    await expect(target.getByTestId('probe-output')).not.toHaveText('', { timeout: 3000 });
    const raw = await target.getByTestId('probe-output').innerText();
    if (raw.length > 16384) throw new Error('Security probe output exceeds size limit');
    const observed = JSON.parse(raw), checks = [];
    checks.push({ name: 'S2-parent-DOM', status: observed.parentDOM?.allowed === false ? 'PASS' : 'FAIL' });
    for (const name of ['cookie', 'localStorage', 'fetch', 'metadata', 'aliyunMetadata', 'mainAPI', 'websocket', 'popup']) checks.push({ name, status: observed[name]?.allowed === false ? 'PASS' : 'FAIL' });
    // sendBeacon's boolean only means the data was queued; actual CSP and network evidence decide delivery.
    checks.push({ name: 'beacon-blocked', queued: observed.beacon?.allowed, status: observed.violations?.some(value => value === 'connect-src:https://example.com/m05-beacon-marker') && logs.some(entry => entry.text?.includes('m05-beacon-marker') && entry.text.includes('has been blocked')) ? 'PASS' : 'FAIL' });
    for (const directive of ['connect-src', 'img-src']) checks.push({ name: `CSP-${directive}`, status: observed.violations?.some(value => value.startsWith(`${directive}:`)) ? 'PASS' : 'FAIL' });
    checks.push({ name: 'form-blocked-by-sandbox', status: logs.some(entry => entry.text?.includes('Blocked form submission') && entry.text.includes('sandboxed')) ? 'PASS' : 'FAIL' });
    checks.push({ name: 'download-blocked', status: !logs.some(entry => entry.type === 'download') && logs.some(entry => entry.text?.includes('Download is disallowed')) ? 'PASS' : 'FAIL' });
    const originalUrl = page.url();
    await target.getByTestId('top-nav').click({ timeout: 2500, noWaitAfter: true });
    await new Promise(done => setTimeout(done, 600));
    checks.push({ name: 'S6-top-navigation', status: page.url() === originalUrl ? 'PASS' : 'FAIL', beforeUrl: originalUrl, afterUrl: page.url() });
    const rawPage = await context.newPage();
    const rawResponse = await rawPage.goto(`${transport.origin}${path}`, { waitUntil: 'networkidle' });
    const rawHeaders = await rawResponse.request().allHeaders();
    exposure.rawTopLevel = { status: rawResponse.status(), requestHeaders: rawHeaders, generatedRootCount: await rawPage.locator('#root').count(), generatedProbeCount: await rawPage.getByTestId('run-probe').count() };
    await rawPage.screenshot({ path: resolve(output, 'raw-top-denied.png'), timeout: 2000 }); artifacts['raw-top-denied.png'] = 'raw-top-denied.png';
    checks.push({ name: 'S6-raw-top-level-denied', status: rawResponse.status() === 403 && rawHeaders['sec-fetch-dest'] === 'document' && exposure.rawTopLevel.generatedRootCount === 0 && exposure.rawTopLevel.generatedProbeCount === 0 ? 'PASS' : 'FAIL' });
    await rawPage.close();
    const missing = await fetch(`${previewOrigin}${path}`, { signal: AbortSignal.timeout(3000) });
    exposure.missingMetadataStatus = missing.status;
    checks.push({ name: 'missing-fetch-metadata-denied', status: missing.status === 403 ? 'PASS' : 'FAIL' });
    const api = await fetch(`${transport.origin}/protected-api`, { signal: AbortSignal.timeout(3000) });
    checks.push({ name: 'loopback-proxy-refuses-API', status: api.status === 403 ? 'PASS' : 'FAIL' });
    await target.getByTestId('self-nav').click({ timeout: 2500, noWaitAfter: true });
    await new Promise(done => setTimeout(done, 600));
    checks.push({ name: 'S3-child-frame-external-navigation-denied', status: page.url() === originalUrl && logs.some(entry => entry.text?.includes('frame-src') && entry.text.includes('example.com') && entry.text.includes('has been blocked')) ? 'PASS' : 'FAIL' });
    security = { observed, checks, status: checks.every(check => check.status === 'PASS') ? 'PASS' : 'FAIL' };
    await json(resolve(output, 'security-probe.json'), security); artifacts['security-probe.json'] = 'security-probe.json';
    if (security.status !== 'PASS') { const exception = new Error('A tested security boundary did not block the attempted operation'); exception.name = 'SecurityBoundaryFailure'; throw exception; }
  }
  if (crash) throw new Error('Browser page error during validation');
  requirements.push({ requirementId: 'R1', status: 'PASS', observed: 'All allowlisted operations and assertions completed' });
  state = 'COMPLETED'; status = 'PASS'; failureCategory = null;
} catch (exception) {
  error = { name: exception.name, message: exception.message.slice(0, 8000), causeCode: exception.cause?.code || exception.code || null, step: currentStep?.index ?? null };
  const appFailure = documentReady && beforeActions && browser?.isConnected() && !page?.isClosed() && !crash && !timedOut && job?.probe !== 'resource-timeout';
  if (exception.name === 'SecurityBoundaryFailure') { state = 'COMPLETED'; status = 'FAIL'; failureCategory = 'SECURITY_BOUNDARY'; }
  else if (exception instanceof InvalidPlan) { state = 'ERROR'; status = 'UNVERIFIED'; failureCategory = 'INVALID_TEST_PLAN'; }
  else if (appFailure && (exception.matcherResult || exception.name === 'TimeoutError')) { state = 'COMPLETED'; status = 'FAIL'; failureCategory = 'APP_BEHAVIOR'; }
  else { state = 'ERROR'; status = 'ERROR'; failureCategory = timedOut || job?.probe === 'resource-timeout' ? 'RESOURCE_LIMIT' : 'INFRASTRUCTURE'; }
  if (currentStep) { currentStep.status = status; currentStep.message = error.message; currentStep.finishedAt = new Date().toISOString(); }
  requirements.push({ requirementId: 'R1', status: status === 'FAIL' ? 'FAIL' : 'UNVERIFIED', observed: error.message, failureCategory });
} finally {
  clearTimeout(timer);
  if (page && !page.isClosed()) { try { await screenshot('after.png'); } catch (exception) { log({ type: 'evidence-unavailable', text: exception.message }); } }
  if (context) { try { await context.tracing.stop({ path: resolve(output, 'trace.zip') }); artifacts['trace.zip'] = 'trace.zip'; } catch (exception) { log({ type: 'trace-unavailable', text: exception.message }); } }
  const processes = await processBoundaries();
  await json(resolve(output, 'process-boundary.json'), processes); artifacts['process-boundary.json'] = 'process-boundary.json';
  if (processes.some(item => /--no-sandbox(?:\s|$)|--disable-(?:setuid|namespace|seccomp-filter)-sandbox/.test(item.command))) { status = 'ERROR'; state = 'ERROR'; failureCategory = 'SANDBOX_DISABLED'; error = { message: 'Forbidden browser sandbox flag observed' }; }
  try { await browser?.close(); } catch {}
  if (transport) { await transport.close(); await json(resolve(output, 'static-transport.json'), { exposure, requests: transport.requests }); artifacts['static-transport.json'] = 'static-transport.json'; }
  await json(resolve(output, 'browser-log.json'), logs); artifacts['browser-log.json'] = 'browser-log.json';
  if (status === 'PASS' || status === 'FAIL') {
    if (!artifacts['before.png'] || !artifacts['after.png'] || !artifacts['trace.zip']) { status = 'ERROR'; state = 'ERROR'; failureCategory = 'EVIDENCE_UNAVAILABLE'; error = { message: 'Required real evidence could not be saved' }; }
  }
  const artifactSha256 = {};
  for (const name of Object.keys(artifacts)) artifactSha256[name] = sha(await readFile(resolve(output, name)));
  const report = { schemaVersion: 1, runId: process.env.M05_JOB_ID || job?.jobId || 'invalid-job', environment: process.env.SPIKE_ENV || 'DOCKER', startedAt, finishedAt: new Date().toISOString(), fixture: job?.fixture || null, presentation: job?.presentation || null, probe: job?.probe || 'none', faultObserved, sourceSha256: manifest?.sourceSha256 || null, buildSha256: manifest?.buildSha256 || null, versionId: manifest?.versionId || null, configurationSha256: manifest?.configurationSha256 || null, testPlanId: job?.testPlan?.id || null, uniqueValue, steps, state, status, failureCategory, results: requirements, error, sandbox: sandbox || null, security: security || null, exposure: exposure || null, artifacts, artifactSha256, resourceUsage: await metrics() };
  await json(resolve(output, 'report.json'), report);
  console.log(JSON.stringify({ runId: report.runId, status, state, failureCategory, fixture: report.fixture, evidence: '/evidence/report.json' }));
  process.exitCode = status === 'PASS' ? 0 : status === 'FAIL' ? 1 : status === 'UNVERIFIED' ? 3 : 2;
}
