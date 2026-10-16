import { chromium, expect } from '@playwright/test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const playwrightVersion = require('@playwright/test/package.json').version;
export const scenarios = ['normal', 'fault'];

// Only createPreview supplies origin. No HTTP request field can override it.
export async function validate({ origin, version, scenario, evidenceRoot }) {
  if (!scenarios.includes(scenario)) throw new Error('Unsupported scenario');
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replace(/[:.]/g, '-')}-${scenario}-${randomUUID()}`;
  const directory = resolve(evidenceRoot, runId);
  await mkdir(directory, { recursive: true });
  const taskName = `m0-task-${randomUUID()}`;
  const previewUrl = `${origin}/${scenario === 'fault' ? '?fault=add-noop' : ''}`;
  const steps = [];
  const logs = [];
  const artifacts = { report: 'report.json', browserLog: 'browser-log.json', beforeScreenshot: null, screenshot: null, trace: null };
  let browser, context, page, currentStep, browserVersion;
  let status = 'ERROR', failure = null, taskCountBefore = null, taskCountAfter = null;
  let interactionCompleted = false;

  async function step(name, action) {
    currentStep = name;
    const record = { name, startedAt: new Date().toISOString(), status: 'RUNNING' };
    steps.push(record);
    try { await action(); record.status = 'PASS'; }
    catch (error) { record.status = 'ERROR'; record.message = error.message; throw error; }
    finally { record.finishedAt = new Date().toISOString(); }
  }

  try {
    await step('preview-health', async () => {
      const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok || (await response.json()).appVersion !== version.appVersion) {
        throw new Error('Preview unavailable or build version mismatch');
      }
    });
    await step('launch-chromium', async () => {
      browser = await chromium.launch({ headless: true, timeout: 30000 });
      browserVersion = browser.version();
      context = await browser.newContext({ viewport: { width: 1100, height: 760 }, serviceWorkers: 'block' });
      // Trusted fixture only. Block any attempted request outside the fixed preview origin.
      await context.route('**/*', (route) => {
        const allowed = new URL(route.request().url()).origin === origin;
        return allowed ? route.continue() : route.abort('blockedbyclient');
      });
      await context.tracing.start({ screenshots: true, snapshots: true });
      page = await context.newPage();
      page.setDefaultTimeout(5000);
      page.on('console', (message) => logs.push({ at: new Date().toISOString(), type: `console.${message.type()}`, text: message.text() }));
      page.on('pageerror', (error) => logs.push({ at: new Date().toISOString(), type: 'pageerror', text: error.message }));
      page.on('crash', () => logs.push({ at: new Date().toISOString(), type: 'crash', text: 'Chromium page crashed' }));
      page.on('requestfailed', (request) => logs.push({ at: new Date().toISOString(), type: 'requestfailed', url: request.url(), text: request.failure()?.errorText }));
      page.on('response', (response) => logs.push({ at: new Date().toISOString(), type: 'response', url: response.url(), status: response.status() }));
    });
    await step('open-preview-and-check-version', async () => {
      const response = await page.goto(previewUrl, { waitUntil: 'networkidle', timeout: 15000 });
      if (!response?.ok()) throw new Error(`Preview HTTP ${response?.status()}`);
      await expect(page.getByTestId('app-version')).toHaveText(version.appVersion);
      await expect(page.getByTestId('mode')).toHaveText(scenario === 'fault' ? 'Mode: fault / Add no-op' : 'Mode: normal');
    });
    const matchingTask = () => page.getByTestId('task-item').filter({ hasText: new RegExp(`^${taskName}$`) });
    await step('assert-unique-task-absent', async () => {
      taskCountBefore = await matchingTask().count();
      await expect(matchingTask()).toHaveCount(0);
      await page.screenshot({ path: resolve(directory, 'before.png'), fullPage: true });
      artifacts.beforeScreenshot = 'before.png';
    });
    await step('fill-task-name', () => page.getByTestId('task-input').fill(taskName));
    await step('click-add', async () => {
      await page.getByTestId('add-button').click();
      interactionCompleted = true;
    });
    await step('assert-task-visible', async () => {
      await expect(matchingTask()).toHaveCount(1, { timeout: 2500 });
      await expect(matchingTask()).toBeVisible({ timeout: 2500 });
    });
    if (logs.some((entry) => entry.type === 'pageerror')) throw new Error('Browser reported an uncaught page error');
    status = 'PASS';
  } catch (error) {
    // FAIL requires actual input/click plus an executed product assertion.
    status = interactionCompleted && currentStep === 'assert-task-visible' && error.matcherResult &&
      browser?.isConnected() && !page?.isClosed() && !logs.some((entry) => ['pageerror', 'crash'].includes(entry.type)) ? 'FAIL' : 'ERROR';
    if (steps.at(-1)) steps.at(-1).status = status;
    failure = { step: currentStep, name: error.name, message: error.message, stack: error.stack };
  } finally {
    if (page) {
      try {
        taskCountAfter = await page.getByTestId('task-item').filter({ hasText: new RegExp(`^${taskName}$`) }).count();
        await page.screenshot({ path: resolve(directory, 'after.png'), fullPage: true, timeout: 5000 });
        artifacts.screenshot = 'after.png';
      } catch (error) { logs.push({ type: 'evidence-error', text: error.message }); }
    }
    if (context) {
      try { await context.tracing.stop({ path: resolve(directory, 'trace.zip') }); artifacts.trace = 'trace.zip'; }
      catch (error) { logs.push({ type: 'evidence-error', text: error.message }); }
    }
    try { await browser?.close(); }
    catch (error) { logs.push({ type: 'cleanup-error', text: error.message }); }
  }
  if (status !== 'ERROR' && (!artifacts.screenshot || !artifacts.beforeScreenshot || !artifacts.trace)) {
    status = 'ERROR';
    failure = { step: 'save-evidence', message: 'Browser test ran but required evidence could not be saved' };
  }
  let container = false;
  try { await access('/.dockerenv'); container = true; } catch {}
  const report = {
    schemaVersion: 1, runId, startedAt, finishedAt: new Date().toISOString(),
    environment: {
      label: process.env.TEST_ENVIRONMENT || 'local', platform: os.platform(), architecture: os.arch(),
      nodeVersion: process.version, playwrightVersion, browser: 'Chromium', browserVersion: browserVersion || null,
      container, cloudService: process.env.K_SERVICE || null, cloudRevision: process.env.K_REVISION || null,
    },
    app: { ...version, previewUrl }, scenario, taskName, steps,
    actualResult: { taskCountBefore, taskCountAfter, interactionCompleted },
    status, failure, evidenceDirectory: directory, artifacts,
  };
  await writeFile(resolve(directory, artifacts.browserLog), JSON.stringify(logs, null, 2) + '\n');
  report.artifactSha256 = {};
  for (const name of Object.values(artifacts).filter((name) => name && name !== 'report.json')) {
    report.artifactSha256[name] = createHash('sha256').update(await readFile(resolve(directory, name))).digest('hex');
  }
  await writeFile(resolve(directory, artifacts.report), JSON.stringify(report, null, 2) + '\n');
  return report;
}
