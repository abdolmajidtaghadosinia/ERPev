// Integration: environment configuration (HOST, DATA_DIR, COOKIE_SECURE) and backup/restore of the data folder.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';
import { Client, seedWorld, pdf, Q } from '../helpers/client.mjs';
import { LIVE } from '../helpers/bundle.mjs';

describe('configuration', () => {
  it('uses DATA_DIR for the database and uploads and leaves live/readiness.db alone', async () => {
    const liveDb = path.join(LIVE, 'readiness.db');
    const before = fs.existsSync(liveDb) ? fs.statSync(liveDb).mtimeMs : null;
    const srv = await startServer();
    try {
      await seedWorld(srv);
      assert.ok(fs.existsSync(path.join(srv.dataDir, 'readiness.db')));
      assert.ok(fs.existsSync(path.join(srv.dataDir, 'uploads')));
    } finally { await srv.stop(); }
    assert.equal(fs.existsSync(liveDb) ? fs.statSync(liveDb).mtimeMs : null, before, 'the real database was modified by a test run');
  });

  it('session cookie has no Secure flag by default', async () => {
    const srv = await startServer(); await seedWorld(srv);
    try { assert.doesNotMatch((await new Client(srv.base).login('ee1')).setCookie[0], /;\s*Secure/i); } finally { await srv.stop(); }
  });
  it('COOKIE_SECURE=1 adds Secure to the session cookie and to its removal on logout', async () => {
    const srv = await startServer({ env: { COOKIE_SECURE: '1' } }); await seedWorld(srv);
    try {
      const c = new Client(srv.base, 'ee1'); const r = await c.login();
      assert.match(r.setCookie[0], /;\s*Secure/i);
      assert.match((await c.req('POST', '/api/logout')).setCookie[0], /;\s*Secure/i);
    } finally { await srv.stop(); }
  });

  it('listens on loopback only by default (not reachable through a LAN address)', async (t) => {
    const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal);
    if (!lan) return t.skip('BLOCKED: no non-loopback network interface on this machine');
    const srv = await startServer();
    try {
      await assert.rejects(fetch(`http://${lan.address}:${srv.port}/api/health`, { signal: AbortSignal.timeout(3000) }));
      assert.equal((await fetch(srv.base + '/api/health')).status, 200);
    } finally { await srv.stop(); }
  });
});

describe('backup and restore', () => {
  let srv, restored, copyDir, w;
  before(async () => {
    srv = await startServer(); w = await seedWorld(srv);
    const up = await w.ee2.upload('x2', Q[0], 'proof.pdf', pdf(42));
    await w.ee2.put({ assessments: [{ id: 'x2', responses: { [Q[0]]: { answer: 'YES', text: 'پاسخ پیش از پشتیبان‌گیری ثبت شد' } }, evidence: { [Q[0]]: [{ id: up.json.id }] } }] });
  });
  after(async () => { await restored?.stop(); await srv.stop(); if (copyDir) fs.rmSync(copyDir, { recursive: true, force: true }); });

  it('a plain copy of the data folder starts a second instance with identical data, files and logins', async () => {
    const stateBefore = await w.admin.state();
    const evId = stateBefore.assessments.find(a => a.id === 'x2').evidence[Q[0]]?.[0]?.id;
    copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-restore-'));
    fs.cpSync(srv.dataDir, copyDir, { recursive: true });
    restored = await startServer({ dataDir: copyDir });

    const db = restored.db(); assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get())[0], 'ok'); db.close();
    const ee2 = new Client(restored.base, 'ee2'); assert.equal((await ee2.login()).status, 200);
    const admin = new Client(restored.base, 'admin'); assert.equal((await admin.login('admin', 'admin')).status, 200);
    assert.deepEqual(await admin.state(), stateBefore);
    assert.ok(evId, 'evidence id expected');
    const original = await w.ee2.req('GET', '/api/files/' + evId), copy = await ee2.req('GET', '/api/files/' + evId);
    assert.equal(copy.status, 200); assert.ok(copy.buf.equals(original.buf));
  });
});
