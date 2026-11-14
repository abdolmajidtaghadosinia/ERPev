// Integration: login, sessions, cookies, CSRF, password change/reset, deactivation. Isolated server + temp database.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';
import { Client, seedWorld } from '../helpers/client.mjs';
import { DEFAULT_PW } from '../helpers/bundle.mjs';

describe('fresh database', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(() => srv.stop());

  it('health endpoint answers without authentication', async () => {
    const r = await new Client(srv.base).req('GET', '/api/health');
    assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true });
  });
  it('before the first setup only "admin" can log in; other users are refused', async () => {
    assert.ok([401, 403].includes((await new Client(srv.base).login('ee1')).status));
  });
});

describe('authentication and sessions', () => {
  let srv, w;
  before(async () => { srv = await startServer(); w = await seedWorld(srv); });
  after(() => srv.stop());

  it('API without a cookie is 401', async () => assert.equal((await new Client(srv.base).req('GET', '/api/db')).status, 401));
  it('garbage cookie is 401', async () => { const c = new Client(srv.base); c.cookie = 'sid=' + 'a'.repeat(64); assert.equal((await c.req('GET', '/api/db')).status, 401); });
  it('wrong password and unknown user give the same status and message (no user enumeration)', async () => {
    const a = await new Client(srv.base).login('ee1', 'wrong-password'), b = await new Client(srv.base).login('nobody-here', 'wrong-password');
    assert.equal(a.status, 401); assert.equal(b.status, 401); assert.equal(a.json.error, b.json.error);
  });
  it('empty, non-string and malformed credentials never crash the server', async () => {
    const c = new Client(srv.base);
    assert.equal((await c.req('POST', '/api/login', { json: {} })).status, 401);
    assert.equal((await c.req('POST', '/api/login', { json: { username: { $ne: 1 }, password: [] } })).status, 401);
    assert.equal((await c.req('POST', '/api/login', { json: { username: '', password: '' } })).status, 401);
    assert.equal((await c.req('POST', '/api/login', { body: '{bad', headers: { 'Content-Type': 'application/json' } })).status, 400);
    assert.equal((await new Client(srv.base).req('GET', '/api/health')).status, 200);
  });
  it('session cookie is HttpOnly, SameSite=Strict, Path=/ with a 12h lifetime', async () => {
    const sc = (await new Client(srv.base).login('ee1')).setCookie[0];
    assert.match(sc, /HttpOnly/i); assert.match(sc, /SameSite=Strict/i); assert.match(sc, /Path=\//); assert.match(sc, /Max-Age=43200/);
  });
  it('logout invalidates the session on the server', async () => {
    const c = new Client(srv.base, 'ee1'); await c.login();
    const old = c.cookie; await c.req('POST', '/api/logout');
    const d = new Client(srv.base); d.cookie = old;
    assert.equal((await d.req('GET', '/api/me')).status, 401);
  });
  it('an expired session is refused', async () => {
    const c = new Client(srv.base, 'ee1'); await c.login();
    const db = srv.db(); db.prepare('UPDATE sessions SET expires = 1').run(); db.close();
    assert.equal((await c.req('GET', '/api/me')).status, 401);
    for (const k of ['ee1', 'ee2', 'as1', 'as2', 'admin']) await w[k].login(k === 'admin' ? 'admin' : undefined, k === 'admin' ? 'admin' : undefined);
  });
  it('CSRF: writes carrying a foreign Origin are refused', async () => {
    const a = await w.ee1.req('PUT', '/api/db', { json: {}, headers: { Origin: 'http://evil.example' } });
    const b = await w.ee1.req('POST', '/api/password', { json: { oldPassword: DEFAULT_PW, newPassword: 'x'.repeat(12) }, headers: { Origin: 'http://evil.example' } });
    const c = await w.ee1.req('POST', '/api/logout', { headers: { Origin: 'http://evil.example' } });
    assert.deepEqual([a.status, b.status, c.status], [403, 403, 403]);
  });

  describe('password change', () => {
    it('wrong current password is 403; too-short new password is 400', async () => {
      assert.equal((await w.ee1.req('POST', '/api/password', { json: { oldPassword: 'nope', newPassword: 'LongEnough123' } })).status, 403);
      assert.equal((await w.ee1.req('POST', '/api/password', { json: { oldPassword: DEFAULT_PW, newPassword: 'short' } })).status, 400);
      assert.equal((await w.ee1.req('POST', '/api/password', { json: { oldPassword: DEFAULT_PW, newPassword: 'x'.repeat(7) } })).status, 400);
    });
    it('an 8-character password is the accepted minimum', async () => {
      const c = new Client(srv.base, 'ee2'); await c.login();
      assert.equal((await c.req('POST', '/api/password', { json: { oldPassword: DEFAULT_PW, newPassword: 'abcd1234' } })).status, 200);
      assert.equal((await c.req('POST', '/api/password', { json: { oldPassword: 'abcd1234', newPassword: DEFAULT_PW } })).status, 200);
    });
    it("changing it ends the user's other sessions but keeps the current one", async () => {
      const s1 = new Client(srv.base, 'assr2'), s2 = new Client(srv.base, 'assr2'); await s1.login(); await s2.login();
      assert.equal((await s1.req('POST', '/api/password', { json: { oldPassword: DEFAULT_PW, newPassword: 'Changed-Pass-1' } })).status, 200);
      assert.equal((await s1.req('GET', '/api/me')).status, 200);
      assert.equal((await s2.req('GET', '/api/me')).status, 401);
      assert.equal((await new Client(srv.base).login('assr2', DEFAULT_PW)).status, 401);
      assert.equal((await s1.req('POST', '/api/password', { json: { oldPassword: 'Changed-Pass-1', newPassword: DEFAULT_PW } })).status, 200);
      await w.as2.login();
    });
  });

  describe('admin-only account actions', () => {
    it('non-admin cannot reset another user\'s password', async () => {
      assert.equal((await w.ee1.req('POST', '/api/users/ee2/reset-password')).status, 403);
      assert.equal((await w.as1.req('POST', '/api/users/ee2/reset-password')).status, 403);
    });
    it('admin reset: unknown user is 404; a known user\'s sessions are ended', async () => {
      assert.equal((await w.admin.req('POST', '/api/users/nobody/reset-password')).status, 404);
      const x = new Client(srv.base, 'assr2'); await x.login();
      assert.equal((await w.admin.req('POST', '/api/users/assr2/reset-password')).status, 200);
      assert.equal((await x.req('GET', '/api/me')).status, 401);
      await w.as2.login();
    });
    it('a deactivated user loses the session immediately and cannot log in', async () => {
      const s = await w.admin.state();
      assert.equal((await w.admin.put({ ...s, users: s.users.map(u => u.username === 'assr2' ? { ...u, active: false } : u) })).status, 204);
      assert.equal((await w.as2.req('GET', '/api/me')).status, 401);
      assert.equal((await new Client(srv.base).login('assr2')).status, 401);
      const s2 = await w.admin.state();
      await w.admin.put({ ...s2, users: s2.users.map(u => u.username === 'assr2' ? { ...u, active: true } : u) });
      assert.equal((await w.as2.login()).status, 200);
    });
    it('the admin account cannot be deactivated', async () => {
      const s = await w.admin.state();
      await w.admin.put({ ...s, users: s.users.map(u => u.username === 'admin' ? { ...u, active: false } : u) });
      assert.equal((await w.admin.req('GET', '/api/me')).status, 200);
    });
  });
});
