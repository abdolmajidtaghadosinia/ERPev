// Integration: login throttling. Own server because the lock applies to the whole client IP.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';
import { Client, seedWorld } from '../helpers/client.mjs';

describe('login lockout', () => {
  let srv;
  before(async () => { srv = await startServer(); await seedWorld(srv); });
  after(() => srv.stop());

  it('7 failures do not lock; the 8th failure locks and then even the correct password gets 429', async () => {
    const c = new Client(srv.base);
    for (let i = 0; i < 7; i++) assert.equal((await c.login('ee1', 'bad' + i)).status, 401);
    assert.equal((await c.login('ee1', 'bad7')).status, 401);
    assert.equal((await new Client(srv.base).login('ee1')).status, 429);
  });
  it('a lock on one username must not block other users', { todo: 'known weakness: the lock is per IP (PRD FR-AUTH-06 asks for IP + username)' }, async () => {
    assert.notEqual((await new Client(srv.base).login('assr1')).status, 429);
  });
  it('the lock lifts after one minute', { skip: 'BLOCKED: needs a 60 s wait and the server has no injectable clock' }, () => {});
});
