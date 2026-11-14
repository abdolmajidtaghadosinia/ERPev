// Integration: input validation, error handling, static exposure and response headers.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';
import { seedWorld } from '../helpers/client.mjs';

describe('admin input validation', () => {
  let srv, w;
  before(async () => { srv = await startServer(); w = await seedWorld(srv); });
  after(() => srv.stop());
  const put = async (mutate) => { const s = await w.admin.state(); return w.admin.put(mutate(s)); };

  it('a second assessment for the same company is 409', async () =>
    assert.equal((await put(s => ({ ...s, assessments: [...s.assessments, { id: 'x3', companyId: 'c1', assessorId: 'u-as1' }] }))).status, 409));
  it('assessment for an unknown company or with a non-assessor is 400', async () => {
    assert.equal((await put(s => ({ ...s, assessments: [...s.assessments, { id: 'x4', companyId: 'nope', assessorId: 'u-as1' }] }))).status, 400);
    assert.equal((await put(s => ({ ...s, companies: [...s.companies, { id: 'c3', name: 'Three' }], assessments: [...s.assessments, { id: 'x5', companyId: 'c3', assessorId: 'u-ee1' }] }))).status, 400);
  });
  it('users: duplicate username 409, illegal characters 400, short name 400, invalid role 400, assessee without company 400', async () => {
    const add = u => put(s => ({ ...s, users: [...s.users, u] }));
    assert.equal((await add({ id: 'u-d', username: 'ee1', displayName: 'd', role: 'ASSESSOR' })).status, 409);
    assert.equal((await add({ id: 'u-e', username: 'bad name!', displayName: 'd', role: 'ASSESSOR' })).status, 400);
    assert.equal((await add({ id: 'u-s', username: 'ab', displayName: 'd', role: 'ASSESSOR' })).status, 400);
    assert.equal((await add({ id: 'u-g', username: 'rolebad', displayName: 'd', role: 'SUPERUSER' })).status, 400);
    assert.equal((await add({ id: 'u-f', username: 'okname', displayName: 'd', role: 'ASSESSEE' })).status, 400);
  });
  it('boundary: 3-character and 40-character usernames are valid and stored exactly', async () => {
    const add = n => put(s => ({ ...s, users: [...s.users, { id: 'u-' + n.length, username: n, displayName: 'd', role: 'ASSESSOR' }] }));
    assert.equal((await add('abc')).status, 204);
    assert.equal((await add('a'.repeat(40))).status, 204);
    const names = (await w.admin.state()).users.map(u => u.username);
    assert.ok(names.includes('abc') && names.includes('a'.repeat(40)));
  });
  it('boundary: a 41-character username is rejected', { todo: 'known bug: it is silently cut to 40 characters (stored under a different name, or 409 if that exists)' }, async () => {
    assert.equal((await put(s => ({ ...s, users: [...s.users, { id: 'u-41', username: 'b'.repeat(41), displayName: 'd', role: 'ASSESSOR' }] }))).status, 400);
  });
  it('company name is required and capped at 200 characters', async () => {
    assert.equal((await put(s => ({ ...s, companies: [...s.companies, { id: 'c-long', name: 'N'.repeat(5000) }] }))).status, 204);
    assert.equal((await w.admin.state()).companies.find(c => c.id === 'c-long').name.length, 200);
    assert.equal((await put(s => ({ ...s, companies: [...s.companies, { id: 'c-empty', name: '   ' }] }))).status, 400);
    assert.equal((await put(s => ({ ...s, companies: [...s.companies, { id: 'bad id!', name: 'x' }] }))).status, 400);
  });
  it('hostile strings are stored as plain data and returned unchanged', async () => {
    const evil = '<img src=x onerror="alert(1)">';
    assert.equal((await put(s => ({ ...s, companies: [...s.companies, { id: 'c-xss', name: evil }] }))).status, 204);
    assert.equal((await w.admin.state()).companies.find(c => c.id === 'c-xss').name, evil);
  });
  it('a user name differing only by case ("Admin") is accepted', { todo: 'known weakness: look-alike accounts are possible' }, async () => {
    assert.notEqual((await put(s => ({ ...s, users: [...s.users, { id: 'u-case', username: 'Admin', displayName: 'x', role: 'ASSESSOR' }] }))).status, 204);
  });
});

describe('request handling and headers', () => {
  let srv, w;
  before(async () => { srv = await startServer(); w = await seedWorld(srv); });
  after(() => srv.stop());
  const raw = (body, ck = w.admin.cookie) => fetch(srv.base + '/api/db', { method: 'PUT', body, headers: { Cookie: ck, 'Content-Type': 'application/json', Origin: srv.base } });

  it('malformed JSON is 400', async () => assert.equal((await raw('{oops')).status, 400));
  it('non-object JSON bodies (null, array, string, number) are 400 for admin', async () => {
    for (const b of ['null', '[]', '"x"', '123']) assert.equal((await raw(b)).status, 400, b);
  });
  it('a body over 30 MB is refused with 413 or a closed connection, and the server stays up', async () => {
    let st; try { st = (await raw('{"a":"' + 'x'.repeat(31e6) + '"}')).status; } catch { st = 'closed'; }
    assert.ok(st === 413 || st === 'closed', String(st));
    assert.equal((await fetch(srv.base + '/api/health')).status, 200);
  });
  it('unknown API paths and unsupported methods are 404', async () => {
    assert.equal((await w.admin.req('GET', '/api/nope')).status, 404);
    assert.equal((await w.admin.req('DELETE', '/api/db')).status, 404);
  });
  it('source, database and git metadata are not served', async () => {
    for (const p of ['/server.js', '/source.html', '/readiness.db', '/uploads/', '/.git/config', '/package.json', '/test/helpers/server.mjs'])
      assert.equal((await fetch(srv.base + p)).status, 404, p);
  });
  it('the page is not cacheable, not frameable, nosniff, and sends no Referer', async () => {
    const r = await fetch(srv.base + '/');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  });
  it('API responses are no-store with Referrer-Policy', async () => {
    const r = await w.admin.req('GET', '/api/db');
    assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  });
  it('the served page contains the pdf.js hardening (isEvalSupported:false) and the save-failure message', async () => {
    const html = await (await fetch(srv.base + '/')).text();
    assert.match(html, /isEvalSupported: false/);
    assert.match(html, /ذخیره نشد/);
  });
  it('the page declares a Content-Security-Policy', { todo: 'known gap: no CSP (needs a decision: the page relies on inline scripts and CDNs)' }, async () => {
    assert.ok((await fetch(srv.base + '/')).headers.get('content-security-policy'));
  });
});
