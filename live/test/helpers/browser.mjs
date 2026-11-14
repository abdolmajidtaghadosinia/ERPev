// Minimal headless-Chrome driver over the DevTools protocol (no npm packages). Uses the Chrome already installed on the machine.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function findChrome() {
  const c = [process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return c.find(p => p && fs.existsSync(p)) || null;
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

export async function launchBrowser() {
  const exe = findChrome(); if (!exe) throw new Error('Chrome not found');
  const port = await freePort(), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-chrome-'));
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + port, '--user-data-dir=' + profile, ...(process.env.CI ? ['--no-sandbox'] : []), 'about:blank'];
  const child = spawn(exe, args, { stdio: 'ignore' });
  let tabs;
  for (let i = 0; i < 60; i++) { try { tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (tabs.length) break; } catch { /* starting */ } await sleep(250); }
  if (!tabs) { child.kill(); throw new Error('Chrome did not start'); }
  const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = {}; const logs = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend[m.id]) pend[m.id](m.result);
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 200));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('ERR ' + m.params.args.map(a => a.value || a.description).join(' ').slice(0, 200));
  };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  const ev = async x => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.value;

  const b = {
    logs, ev, send,
    size: (w, h = 800) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 }),
    async open(url) {
      await send('Network.clearBrowserCookies'); logs.length = 0; await send('Page.navigate', { url });
      await waitFor(async () => /وارد فضای کاری خود شوید/.test(await ev('document.body.innerText') || ''), 15000, 'rendered login page');
    },
    async login(user, pass) {
      await ev(`(()=>{const set=(el,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};const i=document.querySelectorAll('input');set(i[0],${JSON.stringify(user)});set(i[1],${JSON.stringify(pass)});[...document.querySelectorAll('button')].find(b=>b.textContent.includes('ورود به سامانه')).click()})()`);
      // wait for the outcome: either the app shell (login form gone) or the error message
      await waitFor(async () => { const t = await ev('document.body.innerText') || ''; return !/وارد فضای کاری خود شوید/.test(t) || /نادرست/.test(t); }, 10000, 'login result');
      await sleep(700);
    },
    // Click a visible button by its text (or aria-label/title). Returns false if not found.
    async click(label) {
      return (await ev(`(()=>{const L=${JSON.stringify(label)};const e=[...document.querySelectorAll('button')].filter(x=>x.offsetParent!==null&&(x.textContent.trim().startsWith(L)||x.getAttribute('aria-label')===L||x.title===L)).pop();if(!e)return false;e.click();return true})()`)) === true;
    },
    // Navigate through the sidebar; on narrow screens the sidebar is a drawer opened by the «منو» button.
    async nav(label) {
      if (await b.click(label)) { await sleep(900); return true; }
      await b.ev(`(()=>{const e=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||x.title)==='منو'&&x.offsetParent!==null);if(e)e.click()})()`);
      await sleep(700);
      const ok = await b.click(label); await sleep(900); return ok;
    },
    text: () => ev('document.body.innerText'),
    count: sel => ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`),
    overflow: () => ev('document.documentElement.scrollWidth>window.innerWidth+1'),
    async shot(file) { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(s.data, 'base64')); },
    async close() { try { ws.close(); } catch { /* closing */ } child.kill(); await sleep(300); try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* profile still locked */ } }
  };
  return b;
}

export async function waitFor(fn, timeout = 8000, what = 'condition') {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return true; await sleep(200); }
  throw new Error('timed out waiting for ' + what);
}
