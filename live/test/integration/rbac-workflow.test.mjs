// Integration: who can see/change what, and the DRAFT -> SUBMITTED -> IN_REVIEW -> READY_TO_FINALIZE -> FINALIZED workflow.
// The tests in each describe run in order and build on the previous state (that is the workflow being tested).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';
import { seedWorld, pdf, Q, answerAll, decideAll } from '../helpers/client.mjs';
import { BANK, SC } from '../helpers/bundle.mjs';

describe('roles and workflow', () => {
  let srv, w;
  before(async () => { srv = await startServer(); w = await seedWorld(srv); });
  after(() => srv.stop());

  describe('read views (what each role is allowed to see)', () => {
    it('assessee sees only own company and own assessment', async () => {
      const d = await w.ee1.state();
      assert.deepEqual(d.companies.map(c => c.id), ['c1']);
      assert.deepEqual(d.assessments.map(a => a.id), ['x1']);
      assert.ok(!d.users.some(u => u.id === 'u-ee2'));
    });
    it('assessor sees no DRAFT assessments and nothing assigned to others', async () => {
      assert.equal((await w.as1.state()).assessments.length, 0);
      assert.equal((await w.as2.state()).assessments.length, 0);
    });
    it('admin sees everything', async () => {
      const d = await w.admin.state();
      assert.equal(d.assessments.length, 2); assert.equal(d.companies.length, 2); assert.equal(d.users.length, 5);
    });
    it('non-admins cannot wipe the system', async () => {
      assert.equal((await w.ee1.req('POST', '/api/reset')).status, 403);
      assert.equal((await w.as1.req('POST', '/api/reset')).status, 403);
    });
    it('assessee view exposes the assessor user object of own assessment', { todo: 'observation: login username of the assessor is visible to the assessee' }, async () => {
      assert.ok(!(await w.ee1.state()).users.some(u => u.role === 'ASSESSOR'));
    });
  });

  describe('assessee write rules', () => {
    it('cannot modify another company\'s assessment', async () => {
      await w.ee1.put({ assessments: [{ id: 'x2', responses: { [Q[0]]: { answer: 'YES', text: 'HACKED HACKED HACKED' } } }] });
      assert.equal(Object.keys((await w.admin.assessment('x2')).responses).length, 0);
    });
    it('mass-assignment of status / assessor / company / reviews / snapshot is ignored', async () => {
      await w.ee1.put({ assessments: [{ id: 'x1', status: 'FINALIZED', assessorId: 'u-as2', companyId: 'c2', reviews: { [Q[0]]: { decision: 'YES' } }, snapshot: { hack: 1 }, responses: {} }] });
      const x = await w.admin.assessment('x1');
      assert.equal(x.status, 'DRAFT'); assert.equal(x.assessorId, 'u-as1'); assert.equal(x.companyId, 'c1');
      assert.deepEqual(x.reviews, {}); assert.equal(x.snapshot, undefined);
    });
    it('cannot create users or companies, nor escalate a role', async () => {
      await w.ee1.put({ users: [{ id: 'u-new', username: 'pwned', role: 'ADMIN', active: true }], companies: [{ id: 'c9', name: 'X' }], assessments: [] });
      const s = await w.admin.state();
      assert.ok(!s.users.some(u => u.username === 'pwned')); assert.ok(!s.companies.some(c => c.id === 'c9'));
    });
    it('sanitises answers: invalid level dropped, unknown question dropped, text capped at 5000, __proto__ ignored', async () => {
      await w.ee1.put({ assessments: [{ id: 'x1', responses: { [Q[0]]: { answer: 'HACK', level: 'BAD', text: 'a'.repeat(9000) }, NOPE: { text: 'x' }, ['__proto__']: { text: 'p' } } }] });
      const x = await w.admin.assessment('x1');
      const r = x.responses[Q[0]];
      assert.equal(r.answer, undefined); assert.equal(r.level, undefined); assert.equal(r.text.length, 5000);
      assert.equal(x.responses.NOPE, undefined);
    });
    it('submitting an incomplete questionnaire is refused (409) and the status does not change', async () => {
      assert.equal((await w.ee1.put({ assessments: [{ id: 'x1', status: 'SUBMITTED', responses: {} }] })).status, 409);
      assert.equal((await w.admin.assessment('x1')).status, 'DRAFT');
    });
    it('boundary: 808 answered questions is still incomplete, 809 submits', async () => {
      const all = answerAll();
      const missingOne = { ...all }; delete missingOne[Q[808]];
      assert.equal((await w.ee1.put({ assessments: [{ id: 'x1', status: 'SUBMITTED', responses: missingOne }] })).status, 409);
      const shortText = { ...all, [Q[0]]: { answer: 'YES', text: 'x'.repeat(19) } };
      assert.equal((await w.ee1.put({ assessments: [{ id: 'x1', status: 'SUBMITTED', responses: shortText }] })).status, 409);
      const ev = await w.ee1.upload('x1', Q[0], 'ee1-evidence.pdf', pdf(1));
      assert.equal(ev.status, 200);
      assert.equal((await w.ee1.put({ assessments: [{ id: 'x1', status: 'SUBMITTED', responses: all, evidence: { [Q[0]]: [{ id: ev.json.id }] } }] })).status, 204);
      const x = await w.admin.assessment('x1');
      assert.equal(x.status, 'SUBMITTED'); assert.ok(x.submittedAt);
    });
    it('after submission the questionnaire and uploads are read-only', async () => {
      await w.ee1.put({ assessments: [{ id: 'x1', responses: Object.fromEntries(Q.map(q => [q, { answer: 'NO', text: 'CHANGED AFTER SUBMIT 12345678' }])) }] });
      assert.ok((await w.admin.assessment('x1')).responses[Q[5]].text.startsWith('پاسخ'));
      assert.equal((await w.ee1.upload('x1', Q[1], 'late.pdf', pdf(2))).status, 409);
    });
  });

  describe('assessor rules', () => {
    it('assigned assessor sees the submitted assessment; others do not', async () => {
      assert.deepEqual((await w.as1.state()).assessments.map(a => a.id), ['x1']);
      assert.equal((await w.as2.state()).assessments.length, 0);
    });
    it('the assessee sees no reviews, comments or snapshot before FINALIZED', async () => {
      const a = (await w.ee1.state()).assessments[0];
      assert.deepEqual(a.reviews, {}); assert.deepEqual(a.revComments, {}); assert.equal(a.snapshot, undefined);
    });
    it('another assessor cannot score it', async () => {
      await w.as2.put({ assessments: [{ id: 'x1', reviews: { [Q[0]]: { decision: 'YES' } } }] });
      assert.deepEqual((await w.admin.assessment('x1')).reviews, {});
    });
    it('finalizing with nothing scored is 409', async () => {
      assert.equal((await w.as1.put({ assessments: [{ id: 'x1', status: 'FINALIZED', reviews: {} }] })).status, 409);
    });
    it('invalid decisions are dropped; the first valid score moves SUBMITTED -> IN_REVIEW', async () => {
      await w.as1.put({ assessments: [{ id: 'x1', reviews: { [Q[0]]: { decision: 'MAYBE' }, [Q[1]]: { decision: 'YES' } } }] });
      const x = await w.admin.assessment('x1');
      assert.equal(x.status, 'IN_REVIEW'); assert.equal(x.reviews[Q[0]], undefined); assert.equal(x.reviews[Q[1]].decision, 'YES');
    });
    it('decisions can be changed but never removed', async () => {
      await w.as1.put({ assessments: [{ id: 'x1', reviews: { [Q[1]]: { decision: 'NO' } } }] });
      assert.equal((await w.admin.assessment('x1')).reviews[Q[1]].decision, 'NO');
      await w.as1.put({ assessments: [{ id: 'x1', reviews: {} }] });
      assert.ok((await w.admin.assessment('x1')).reviews[Q[1]]);
    });
    it('cannot change answers, evidence, assessor or company', async () => {
      await w.as1.put({ assessments: [{ id: 'x1', responses: { [Q[2]]: { answer: 'NO', text: 'ASSESSOR WROTE THIS 12345' } }, assessorId: 'u-as2', companyId: 'c2', evidence: {} }] });
      const x = await w.admin.assessment('x1');
      assert.ok(x.responses[Q[2]].text.startsWith('پاسخ')); assert.equal(x.assessorId, 'u-as1'); assert.equal(x.companyId, 'c1');
      assert.ok((x.evidence[Q[0]] || []).length >= 1, 'evidence must survive');
    });
    it('a reviewer comment cannot be erased by leaving it out of a later save', { todo: 'known deviation: CLAUDE.md says comments are never removed, but only decisions are protected' }, async () => {
      await w.as1.put({ assessments: [{ id: 'x1', revComments: { [Q[3]]: 'یادداشت ارزیاب' } }] });
      await w.as1.put({ assessments: [{ id: 'x1', revComments: {} }] });
      assert.equal((await w.admin.assessment('x1')).revComments[Q[3]], 'یادداشت ارزیاب');
    });
    it('all 809 scored -> READY_TO_FINALIZE; a tampered snapshot is ignored and recomputed on finalize', async () => {
      const reviews = decideAll(['YES', 'CORRECTIVE', 'NO']), revComments = { [Q[0]]: 'نظر ارزیاب' };
      await w.as1.put({ assessments: [{ id: 'x1', reviews, revComments }] });
      assert.equal((await w.admin.assessment('x1')).status, 'READY_TO_FINALIZE');
      await w.as1.put({ assessments: [{ id: 'x1', status: 'FINALIZED', reviews, revComments, snapshot: { score: { overall: { percent: 100 } } } }] });
      const x = await w.admin.assessment('x1');
      const expected = SC.scoreAssessment(BANK, Object.fromEntries(Q.map(q => [q, reviews[q].decision])));
      assert.equal(x.status, 'FINALIZED'); assert.ok(x.finalizedAt);
      assert.ok(Math.abs(x.snapshot.score.overall.points - expected.overall.points) < 1e-9);
      assert.ok(x.snapshot.score.overall.percent < 100);
    });
    it('FINALIZED is immutable: assessor edits are ignored and the admin cannot reassign it', async () => {
      const before = JSON.stringify((await w.admin.assessment('x1')).reviews);
      await w.as1.put({ assessments: [{ id: 'x1', reviews: decideAll(['NO']) }] });
      assert.equal(JSON.stringify((await w.admin.assessment('x1')).reviews), before);
      const s = await w.admin.state();
      assert.equal((await w.admin.put({ ...s, assessments: s.assessments.map(a => a.id === 'x1' ? { ...a, assessorId: 'u-as2' } : a) })).status, 409);
    });
    it('after FINALIZED the assessee sees reviews, comments and the snapshot', async () => {
      const a = (await w.ee1.state()).assessments[0];
      assert.equal(Object.keys(a.reviews).length, 809); assert.ok(a.snapshot); assert.equal(a.revComments[Q[0]], 'نظر ارزیاب');
    });
  });

  describe('admin rules', () => {
    it('cannot edit answers or reviews', async () => {
      const s = await w.admin.state();
      await w.admin.put({ ...s, assessments: s.assessments.map(a => a.id === 'x2' ? { ...a, responses: { [Q[0]]: { answer: 'YES', text: 'ADMIN WROTE THIS 123456' } }, reviews: { [Q[0]]: { decision: 'YES' } } } : a) });
      const x = await w.admin.assessment('x2');
      assert.deepEqual(x.responses, {}); assert.deepEqual(x.reviews, {});
    });
    it('a stale admin save does not overwrite answers the assessee saved meanwhile (no lost update)', async () => {
      const stale = await w.admin.state();
      await w.ee2.put({ assessments: [{ id: 'x2', responses: { [Q[0]]: { answer: 'YES', text: 'fresh answer from the assessee 123' } } }] });
      await w.admin.put(stale);
      assert.ok((await w.admin.assessment('x2')).responses[Q[0]].text.startsWith('fresh'));
    });
    it('the assessor of a not-yet-finalized assessment can be changed to another active assessor', async () => {
      const s = await w.admin.state();
      assert.equal((await w.admin.put({ ...s, assessments: s.assessments.map(a => a.id === 'x2' ? { ...a, assessorId: 'u-as1' } : a) })).status, 204);
      assert.equal((await w.admin.assessment('x2')).assessorId, 'u-as1');
    });
  });

  describe('concurrency and integrity', () => {
    it('30 parallel autosaves all succeed and leave valid JSON behind', async () => {
      const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => w.ee2.put({ assessments: [{ id: 'x2', responses: { [Q[i]]: { answer: 'YES', text: 'parallel write number ' + i + ' xxxxxxxx' } } }] })));
      assert.ok(rs.every(r => r.status === 204));
      assert.equal(typeof (await w.admin.assessment('x2')).responses, 'object');
    });
    it('two tabs saving at once: the last writer replaces the whole answer map', { todo: 'known limitation: last-write-wins (a stale tab erases the other tab\'s answers)' }, async () => {
      await Promise.all([
        w.ee2.put({ assessments: [{ id: 'x2', responses: { [Q[10]]: { answer: 'YES', text: 'writer A xxxxxxxxxxxxxxx' } } }] }),
        w.ee2.put({ assessments: [{ id: 'x2', responses: { [Q[11]]: { answer: 'YES', text: 'writer B xxxxxxxxxxxxxxx' } } }] })]);
      assert.ok(Object.keys((await w.admin.assessment('x2')).responses).length >= 2);
    });
    it('database passes SQLite integrity_check', () => {
      const db = srv.db(); const r = db.prepare('PRAGMA integrity_check').get(); db.close();
      assert.equal(Object.values(r)[0], 'ok');
    });
    it('one assessment per company is enforced by the database itself', { todo: 'known gap: enforced only by application code (no UNIQUE constraint)' }, () => {
      const db = srv.db(); const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='assessments'").get().sql; db.close();
      assert.match(sql, /UNIQUE/i);
    });
  });

  // Last on purpose: today this submits x2 (the known deviation), which would affect any test that runs after it.
  describe('PRD §7.3 completeness', () => {
    it('submission without any answer choice and without evidence is refused', { todo: 'known deviation: only the explanation length is checked (needs product decision)' }, async () => {
      const r = await w.ee2.put({ assessments: [{ id: 'x2', status: 'SUBMITTED', responses: Object.fromEntries(Q.map(q => [q, { text: 'x'.repeat(25) }])) }] });
      assert.notEqual((await w.admin.assessment('x2')).status, 'SUBMITTED', 'submitted with status ' + r.status);
    });
  });
});
