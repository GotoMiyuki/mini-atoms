import React, { useState } from 'react';
export default function App() {
  const [output, setOutput] = useState('');
  async function run() {
    const result: Record<string, unknown> = { violations: [] };
    const violations: string[] = [];
    document.addEventListener('securitypolicyviolation', e => violations.push(`${e.effectiveDirective}:${e.blockedURI}`));
    for (const [name, action] of Object.entries({
      parentDOM: () => parent.document.getElementById('main-marker')?.textContent,
      cookie: () => document.cookie,
      localStorage: () => localStorage.getItem('m05-main-marker'),
    })) { try { result[name] = { allowed: true, value: action() }; } catch (error) { result[name] = { allowed: false, reason: String(error) }; } }
    for (const [name, url] of Object.entries({ fetch: 'https://example.com/m05-harmless-marker', metadata: 'http://169.254.169.254/m05-harmless-marker', aliyunMetadata: 'http://100.100.100.200/m05-harmless-marker', mainAPI: '/protected-api' })) {
      try { const response = await fetch(url, { credentials: 'include' }); result[name] = { allowed: true, status: response.status }; }
      catch (error) { result[name] = { allowed: false, reason: String(error) }; }
    }
    try { const ws = new WebSocket('wss://example.com/m05-harmless-marker'); ws.onerror = () => { result.websocket = { allowed: false }; }; ws.onopen = () => { result.websocket = { allowed: true }; ws.close(); }; } catch (error) { result.websocket = { allowed: false, reason: String(error) }; }
    const image = new Image(); image.src = 'https://example.com/m05-image-marker';
    try { result.beacon = { allowed: navigator.sendBeacon('https://example.com/m05-beacon-marker', 'harmless-marker') }; } catch (error) { result.beacon = { allowed: false, reason: String(error) }; }
    try { result.popup = { allowed: Boolean(window.open('https://example.com/m05-popup-marker')) }; } catch (error) { result.popup = { allowed: false, reason: String(error) }; }
    const form = document.createElement('form'); form.action = 'https://example.com/m05-form-marker'; form.method = 'POST'; document.body.append(form); try { form.submit(); result.form = { attempted: true }; } catch (error) { result.form = { allowed: false, reason: String(error) }; }
    const link = document.createElement('a'); link.download = 'm05-harmless.txt'; link.href = 'data:text/plain,harmless-marker'; document.body.append(link); link.click();
    await new Promise(resolve => setTimeout(resolve, 500));
    result.violations = violations;
    setOutput(JSON.stringify(result));
  }
  return <main><h1>Harmless boundary probes</h1><button data-testid="run-probe" onClick={run}>Run probes</button><button data-testid="top-nav" onClick={() => { try { top!.location.href = 'https://example.com/m05-top-navigation-marker'; } catch (error) { console.warn('Top navigation rejected', String(error)); } }}>Attempt top navigation</button><button data-testid="self-nav" onClick={() => { try { location.href = 'https://example.com/m05-self-navigation-marker'; } catch (error) { console.warn('Frame navigation rejected', String(error)); } }}>Attempt frame navigation</button><pre data-testid="probe-output">{output}</pre></main>;
}
