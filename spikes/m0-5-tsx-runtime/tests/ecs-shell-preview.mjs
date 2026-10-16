import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root, json, readJson, sha, runId } from '../src/shared.mjs';
import { plans } from '../src/validator/plans.mjs';

const local = process.argv.includes('--local');
const origin = local ? 'http://127.0.0.1:8091' : 'http://127.0.0.1:18091', suite = runId(local ? 'local-shell-browser' : 'ecs-ssh-shell');
const environment = local ? 'WINDOWS_BROWSER_TO_LOCAL_DOCKER' : 'WINDOWS_BROWSER_TO_ECS_VIA_SSH';
const directory = resolve(root, 'evidence', suite), index = await readJson(resolve(root, 'artifacts/fixture-index.json'));
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: true });
const results = [];
try {
  for (const presentation of ['direct', 'iframe']) for (const fixture of ['todo-good', 'todo-noop', 'counter-good', 'security-probe']) {
    const id = runId(fixture), output = resolve(directory, id), startedAt = new Date().toISOString(), unique = `ssh-${randomUUID()}`;
    await mkdir(output, { recursive: true });
    const manifest = index[fixture], path = `/builds/${manifest.versionId}/index.html`;
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, serviceWorkers: 'block', acceptDownloads: false });
    const page = await context.newPage(), logs = [], steps = [], artifacts = {}, loadedAssets = {}, pending = [];
    let status = 'ERROR', error = null, category = 'INFRASTRUCTURE', ready = false, interacted = false, exposure = null, security = null;
    page.on('console', message => { if (logs.length < 256) logs.push({ type: `console.${message.type()}`, text: message.text().slice(0, 2000) }); });
    page.on('download', () => logs.push({ type: 'download' }));
    page.on('pageerror', exception => logs.push({ type: 'pageerror', text: exception.message }));
    page.on('requestfailed', request => logs.push({ type: 'requestfailed', url: request.url(), error: request.failure()?.errorText }));
    page.on('response', response => {
      const name = response.url().startsWith(`${origin}/builds/${manifest.versionId}/`) ? response.url().split('/').at(-1) : null;
      if (response.status() === 200 && Object.hasOwn(manifest.assets, name)) {
        const promise = response.body().then(bytes => { loadedAssets[name] = { sha256: sha(bytes), status: response.status(), csp: response.headers()['content-security-policy'] }; });
        pending.push(promise); promise.catch(() => {});
      }
    });
    try {
      await context.tracing.start({ screenshots: true, snapshots: true });
      const generated = page.waitForResponse(response => response.url() === `${origin}${path}`, { timeout: 10000 }); generated.catch(() => {});
      const address = `${origin}/${presentation === 'direct' ? 'preview' : 'harness'}/${manifest.versionId}`;
      await page.goto(address, { waitUntil: 'networkidle', timeout: 15000 });
      const response = await generated;
      exposure = { requestHeaders: await response.request().allHeaders(), status: response.status() };
      assert.equal(response.status(), 200); assert.equal(exposure.requestHeaders['sec-fetch-dest'], 'iframe'); assert.equal(exposure.requestHeaders['sec-fetch-site'], 'same-origin');
      await Promise.all(pending);
      for (const [name, asset] of Object.entries(manifest.assets)) assert.equal(loadedAssets[name]?.sha256, asset.sha256, `${fixture} browser bytes ${name}`);
      const target = presentation === 'direct' ? page.frameLocator('[data-testid="preview-frame"]') : page.frameLocator('[data-testid="shell-frame"]').frameLocator('[data-testid="preview-frame"]');
      await target.locator('#root').waitFor(); ready = true;
      await page.screenshot({ path: resolve(output, 'before.png'), fullPage: true }); artifacts['before.png'] = 'before.png';
      const locator = name => name === 'task-item' ? target.getByTestId(name).filter({ hasText: unique }) : target.getByTestId(name);
      for (const step of plans[fixture].tests[0].steps) {
        const record = { ...step, status: 'RUNNING' }; steps.push(record); const element = locator(step.target), options = { timeout: 2500 };
        if (step.action === 'fill') await element.fill(unique, options);
        if (step.action === 'click') { await element.click(options); interacted = true; }
        if (step.action === 'assertCount') await expect(element).toHaveCount(step.expected, options);
        if (step.action === 'assertVisible') await expect(element).toBeVisible(options);
        if (step.action === 'assertValue') await expect(element).toHaveText(step.expected, options);
        record.status = 'PASS';
      }
      if (fixture === 'security-probe') {
        await expect(target.getByTestId('probe-output')).not.toHaveText('', { timeout: 3000 });
        const observed = JSON.parse(await target.getByTestId('probe-output').innerText()), checks = [];
        for (const name of ['parentDOM', 'cookie', 'localStorage', 'fetch', 'metadata', 'aliyunMetadata', 'mainAPI', 'websocket', 'popup']) checks.push({ name, status: observed[name]?.allowed === false ? 'PASS' : 'FAIL' });
        checks.push({ name: 'beacon', status: observed.violations.some(value => value.includes('connect-src:https://example.com/m05-beacon-marker')) ? 'PASS' : 'FAIL' });
        checks.push({ name: 'image', status: observed.violations.some(value => value.startsWith('img-src:')) ? 'PASS' : 'FAIL' });
        checks.push({ name: 'form', status: logs.some(value => value.text?.includes('Blocked form submission')) ? 'PASS' : 'FAIL' });
        checks.push({ name: 'download', status: !logs.some(value => value.type === 'download') && logs.some(value => value.text?.includes('Download is disallowed')) ? 'PASS' : 'FAIL' });
        const before = page.url();
        await target.getByTestId('top-nav').click({ noWaitAfter: true }); await new Promise(done => setTimeout(done, 400));
        checks.push({ name: 'top-navigation', status: page.url() === before ? 'PASS' : 'FAIL' });
        const raw = await context.newPage(), rejected = await raw.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
        exposure.rawTop = { status: rejected.status(), requestHeaders: await rejected.request().allHeaders(), generatedRootCount: await raw.locator('#root').count() };
        checks.push({ name: 'raw-top-denied', status: rejected.status() === 403 && exposure.rawTop.requestHeaders['sec-fetch-dest'] === 'document' && exposure.rawTop.generatedRootCount === 0 ? 'PASS' : 'FAIL' });
        await raw.screenshot({ path: resolve(output, 'raw-top-denied.png') }); artifacts['raw-top-denied.png'] = 'raw-top-denied.png'; await raw.close();
        await target.getByTestId('self-nav').click({ noWaitAfter: true }); await new Promise(done => setTimeout(done, 400));
        checks.push({ name: 'frame-external-navigation', status: page.url() === before && logs.some(value => value.text?.includes('frame-src') && value.text.includes('example.com') && value.text.includes('has been blocked')) ? 'PASS' : 'FAIL' });
        security = { observed, checks };
        if (checks.some(check => check.status !== 'PASS')) { const failure = new Error('SSH user-browser security boundary failure'); failure.name = 'SecurityBoundaryFailure'; throw failure; }
      }
      if (logs.some(value => value.type === 'pageerror')) throw new Error('Page reported an uncaught error');
      status = 'PASS'; category = null;
    } catch (exception) {
      status = exception.name === 'SecurityBoundaryFailure' || ready && interacted && exception.matcherResult && browser.isConnected() && !page.isClosed() ? 'FAIL' : 'ERROR';
      category = exception.name === 'SecurityBoundaryFailure' ? 'SECURITY_BOUNDARY' : status === 'FAIL' ? 'APP_BEHAVIOR' : 'INFRASTRUCTURE';
      error = { name: exception.name, message: exception.message.slice(0, 8000) };
      if (steps.at(-1)?.status === 'RUNNING') steps.at(-1).status = status;
    } finally {
      try { await page.screenshot({ path: resolve(output, 'after.png'), fullPage: true, timeout: 3000 }); artifacts['after.png'] = 'after.png'; } catch {}
      try { await context.tracing.stop({ path: resolve(output, 'trace.zip') }); artifacts['trace.zip'] = 'trace.zip'; } catch {}
      await json(resolve(output, 'browser-log.json'), logs); artifacts['browser-log.json'] = 'browser-log.json';
      if (['PASS', 'FAIL'].includes(status) && (!artifacts['before.png'] || !artifacts['after.png'] || !artifacts['trace.zip'])) { status = 'ERROR'; category = 'EVIDENCE_UNAVAILABLE'; }
      const artifactSha256 = {};
      for (const name of Object.keys(artifacts)) artifactSha256[name] = sha(await readFile(resolve(output, name)));
      await json(resolve(output, 'report.json'), { schemaVersion: 1, runId: id, environment, startedAt, finishedAt: new Date().toISOString(), fixture, presentation, status, failureCategory: category, error, sourceSha256: manifest.sourceSha256, buildSha256: manifest.buildSha256, versionId: manifest.versionId, unique, steps, loadedAssets, exposure, security, artifacts, artifactSha256, browserVersion: browser.version(), sandboxRequested: true, networkInterceptionUsed: false });
      const expected = fixture === 'todo-noop' ? 'FAIL' : 'PASS';
      results.push({ runId: id, fixture, presentation, expected, actual: status, status: status === expected ? 'PASS' : 'FAIL', report: `${suite}/${id}/report.json`, reportSha256: sha(await readFile(resolve(output, 'report.json'))) });
      await context.close();
    }
  }
} finally { await browser.close(); }
const summary = { environment, origin, status: results.length === 8 && results.every(result => result.status === 'PASS') ? 'PASS' : 'FAIL', results };
await json(resolve(directory, 'summary.json'), summary);
await json(resolve(root, `evidence/latest-${local ? 'local-browser' : 'ecs-ssh-preview'}.json`), { ...summary, suite });
console.log(JSON.stringify({ status: summary.status, cases: results.length, report: `evidence/${suite}/summary.json` }));
process.exitCode = summary.status === 'PASS' ? 0 : 1;
