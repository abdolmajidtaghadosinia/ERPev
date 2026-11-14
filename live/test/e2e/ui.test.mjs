// End-to-end: real browser (headless Chrome) against an isolated server. Skipped with a BLOCKED reason when Chrome is not available.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';
import { Client, seedWorld, pdf, JPG, Q, submit } from '../helpers/client.mjs';
import { DEFAULT_PW } from '../helpers/bundle.mjs';
import { findChrome, launchBrowser, waitFor, sleep } from '../helpers/browser.mjs';

const chrome = findChrome();
const skip = chrome ? false : 'BLOCKED: Chrome/Edge not found (set CHROME_PATH)';
const EVIL = '<img src=x onerror="window.__xss=1">';

describe('browser', { skip }, () => {
  let srv, w, b;
  const asUser = async (user, pass = DEFAULT_PW, width = 1280) => { await b.size(width, width < 500 ? 740 : 860); await b.open(srv.base + '/'); await b.login(user, pass); };

  before(async () => {
    srv = await startServer(); w = await seedWorld(srv);
    // x1: submitted with two files (assessor view); x2: draft; c3/ee3: company without an assessment; hostile strings for the XSS check
    const up1 = await w.ee1.upload('x1', Q[0], 'review.pdf', pdf(1)); const up2 = await w.ee1.upload('x1', Q[0], 'review.jpg', JPG);
    await w.ee1.put({ assessments: [{ id: 'x1', evidence: { [Q[0]]: [{ id: up1.json.id }, { id: up2.json.id }] } }] });
    assert.equal((await submit(w.ee1, 'x1')).status, 204);
    const s = await w.admin.state();
    s.companies.push({ id: 'c3', name: 'No Assessment Co', sector: 'x', location: 'y' }, { id: 'cxss', name: EVIL, sector: 'x', location: 'y' });
    s.users.push({ id: 'u-ee3', username: 'ee3', displayName: 'Assessee Three', role: 'ASSESSEE', companyId: 'c3', active: true }, { id: 'u-xss', username: 'xssuser', displayName: EVIL, role: 'ASSESSOR' });
    assert.equal((await w.admin.put(s)).status, 204);
    b = await launchBrowser();
  });
  after(async () => { await b?.close(); await srv?.stop(); });

  it('login page: Persian UI, wrong password shows the error and stays on the login page', async () => {
    await b.size(1280, 860); await b.open(srv.base + '/');
    assert.match(await b.text(), /ورود به سامانه/);
    await b.login('ee1', 'definitely-wrong');
    assert.match(await b.text(), /نام کاربری یا رمز عبور نادرست است/);
    assert.ok(await b.count('input[type=password]') > 0, 'still on the login form');
  });

  it('login form fields have accessible labels and a Persian placeholder', { todo: 'known gap: inputs have no label/aria-label and the placeholder is the English word "username"' }, async () => {
    await b.size(1280, 860); await b.open(srv.base + '/');
    const bad = await b.ev(`[...document.querySelectorAll('input')].filter(i=>!(i.labels&&i.labels.length)&&!i.getAttribute('aria-label')||/^[a-z]+$/i.test(i.placeholder)).length`);
    assert.equal(bad, 0);
  });

  it('assessee: lands on the dashboard of their own company only', async () => {
    await asUser('ee2');
    const t = await b.text();
    assert.match(t, /Company Two/); assert.doesNotMatch(t, /Company One/); assert.match(t, /پرسش‌نامه ارزیابی/);
    assert.deepEqual(b.logs, []);
  });

  it('assessee without an assessment sees an explanation instead of a blank page', async () => {
    await asUser('ee3');
    assert.match(await b.text(), /هنوز ارزیابی‌ای برای شرکت شما ایجاد نشده است/);
  });

  it('assessee: typing an answer autosaves it to the server', async () => {
    await asUser('ee2');
    assert.ok(await b.nav('پرسش‌نامه ارزیابی'));
    const marker = 'متن آزمون ذخیره‌ی خودکار ' + Date.now();
    await b.ev(`(()=>{const t=[...document.querySelectorAll('textarea')].find(x=>x.offsetParent!==null);const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;s.call(t,${JSON.stringify(marker)});t.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await waitFor(async () => Object.values((await w.admin.assessment('x2')).responses).some(r => r.text === marker), 8000, 'autosave on the server');
    assert.match(await b.text(), /ذخیره شد/);
  });

  it('assessor: no "compare" page, files page is view-only (view buttons, no download), viewer opens and closes', async () => {
    await asUser('assr1');
    const nav = await b.text();
    assert.doesNotMatch(nav, /مقایسه زیرساخت/);
    assert.ok(await b.nav('ارزیابی‌ها')); assert.ok(await b.click('شروع بررسی'));
    await sleep(1200);
    assert.ok(await b.nav('مدیریت فایل‌ها'));
    const t = await b.text();
    assert.match(t, /review\.pdf/); assert.match(t, /review\.jpg/);
    assert.equal(await b.count('button[aria-label="دانلود"]'), 0, 'assessor must not get download buttons');
    assert.ok(await b.count('button[aria-label="مشاهده"]') >= 2);
    // open the jpg viewer (second row) and close it
    await b.ev(`document.querySelectorAll('button[aria-label="مشاهده"]')[1].click()`);
    await waitFor(async () => (await b.text()).includes('بستن'), 5000, 'viewer');
    assert.ok(await b.count('img[src*="view=1"]') === 1, 'image element points at the view endpoint');
    assert.ok(await b.click('بستن'));
    await sleep(400); assert.equal(await b.count('img[src*="view=1"]'), 0);
    assert.deepEqual(b.logs, []);
  });

  it('assessor is refused the file download endpoint even with a valid session (server-side)', async () => {
    const files = (await w.as1.state()).assessments[0].evidence[Q[0]];
    assert.equal((await w.as1.req('GET', '/api/files/' + files[0].id)).status, 403);
  });

  it('admin: comparison page lists every company (ranked or "not yet in comparison")', async () => {
    await asUser('admin', 'admin');
    assert.ok(await b.nav('مقایسه زیرساخت‌ها'));
    const t = await b.text();
    assert.match(t, /Company One/);                               // submitted -> in the chart
    assert.match(t, /شرکت‌هایی که هنوز در مقایسه نیستند/);       // drafts / no assessment
    assert.match(t, /Company Two/); assert.match(t, /No Assessment Co/);
  });

  it('stored HTML in company/user names is shown as text and never executed', async () => {
    await asUser('admin', 'admin');
    for (const n of ['شرکت‌ها', 'کاربران', 'ارزیابی‌ها']) { assert.ok(await b.nav(n), n); }
    assert.equal(await b.ev('String(window.__xss)'), 'undefined');
    await b.nav('شرکت‌ها');
    assert.match(await b.text(), /<img src=x/);
  });

  for (const [role, user, pass, navs] of [
    ['assessee', 'ee1', DEFAULT_PW, ['داشبورد', 'پرسش‌نامه ارزیابی', 'مدیریت فایل‌ها']],
    ['assessor', 'assr1', DEFAULT_PW, ['داشبورد', 'ارزیابی‌ها']],
    ['admin', 'admin', 'admin', ['داشبورد', 'شرکت‌ها', 'کاربران', 'ارزیابی‌ها', 'مقایسه زیرساخت‌ها']]]) {
    it(`responsive: every ${role} screen fits the viewport at 360, 768 and 1280 px (no horizontal scroll)`, async () => {
      for (const width of [360, 768, 1280]) {
        await asUser(user, pass, width);
        assert.equal(await b.overflow(), false, `${role} home @${width}`);
        for (const n of navs) {
          assert.ok(await b.nav(n), `${role} nav "${n}" reachable @${width}`);
          assert.equal(await b.overflow(), false, `${role} "${n}" @${width}`);
        }
      }
      assert.deepEqual(b.logs, [], 'console errors');
    });
  }

  // Last: stops and restarts the server.
  it('server down while editing: the page says "not saved" (not "saved") and retries until the data arrives', async () => {
    await asUser('ee2');
    assert.ok(await b.nav('پرسش‌نامه ارزیابی'));
    await srv.kill();
    const marker = 'متن آزمون قطع ارتباط ' + Date.now();
    await b.ev(`(()=>{const t=[...document.querySelectorAll('textarea')].find(x=>x.offsetParent!==null);const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;s.call(t,${JSON.stringify(marker)});t.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await waitFor(async () => (await b.text()).includes('ذخیره نشد'), 5000, '"not saved" message');
    await sleep(3500); // the red toast is gone by now; the indicator must still tell the truth
    const t = await b.text();
    assert.match(t, /ذخیره نشد/); assert.doesNotMatch(t, /ذخیره شد ✓/);
    await srv.start();                                              // same port + same data folder
    await waitFor(async () => (await b.text()).includes('ذخیره شد'), 15000, 'automatic retry succeeded');
    const admin = new Client(srv.base, 'admin'); await admin.login('admin', 'admin');
    assert.ok(Object.values((await admin.assessment('x2')).responses).some(r => r.text === marker), 'the edit reached the server after the retry');
  });
});
