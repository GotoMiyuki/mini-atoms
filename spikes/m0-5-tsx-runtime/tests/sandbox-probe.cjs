const { chromium } = require('/app/node_modules/@playwright/test');
(async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true, chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    await page.goto('chrome://sandbox');
    const status = await page.locator('body').innerText();
    console.log(JSON.stringify({ uid: process.getuid(), chromiumSandboxRequested: true, browserVersion: browser.version(), status }));
    if (!/Layer 1 Sandbox\s+Namespace/.test(status) || !/PID namespaces\s+Yes/.test(status) || !/Seccomp-BPF sandbox\s+Yes/.test(status)) {
      throw new Error('Required Chromium namespace and seccomp sandbox are not reported as enabled');
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 2; });
