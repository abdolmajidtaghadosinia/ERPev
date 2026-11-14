// Integration: evidence upload validation, access control, viewing (assessor view-only) and cleanup.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';
import { seedWorld, pdf, JPG, MP4, PK, OLE, Q, submit } from '../helpers/client.mjs';

describe('evidence files', () => {
  let srv, w; const ids = {};
  before(async () => { srv = await startServer(); w = await seedWorld(srv); });
  after(() => srv.stop());

  describe('upload validation', () => {
    it('accepts pdf, jpg, jpeg, mp4, docx, doc, zip (case-insensitive extension)', async () => {
      for (const [n, b] of [['a.pdf', pdf(3)], ['b.jpg', JPG], ['c.JPEG', JPG], ['d.mp4', MP4], ['e.docx', PK], ['f.doc', OLE], ['g.zip', PK], ['h.PDF', pdf(4)]]) {
        const r = await w.ee2.upload('x2', Q[0], n, b);
        assert.equal(r.status, 200, n); ids[n] = r.json.id;
      }
    });
    it('rejects disallowed extensions', async () => {
      for (const n of ['a.exe', 'a.html', 'a.svg', 'a.js', 'a.php', 'a.pdf.exe', 'noext', '.pdf2']) assert.equal((await w.ee2.upload('x2', Q[1], n, pdf(5))).status, 400, n);
    });
    it('rejects content whose signature does not match the extension', async () => {
      for (const [n, b] of [['a.pdf', Buffer.from('MZ\x90\x00 exe')], ['b.jpg', Buffer.from('<html><script>alert(1)</script>')], ['c.docx', Buffer.from('not a zip')], ['d.mp4', Buffer.from('hello world 123')], ['e.doc', PK]])
        assert.equal((await w.ee2.upload('x2', Q[1], n, b)).status, 400, n);
    });
    it('rejects empty body, missing name, unknown question, foreign or unknown assessment', async () => {
      assert.equal((await w.ee2.upload('x2', Q[1], 'e.pdf', Buffer.alloc(0))).status, 400);
      assert.equal((await w.ee2.req('POST', '/api/files', { body: pdf(6), headers: { 'X-Assessment': 'x2', 'X-Question': Q[1] } })).status, 400);
      assert.equal((await w.ee2.upload('x2', 'ZZZ', 'e.pdf', pdf(6))).status, 400);
      assert.equal((await w.ee2.upload('x1', Q[1], 'e.pdf', pdf(6))).status, 403);
      assert.equal((await w.ee2.upload('nope', Q[1], 'e.pdf', pdf(6))).status, 403);
    });
    it('only an assessee can upload', async () => {
      assert.equal((await w.as1.upload('x2', Q[1], 'e.pdf', pdf(7))).status, 403);
      assert.equal((await w.admin.upload('x2', Q[1], 'e.pdf', pdf(7))).status, 403);
    });
    it('boundary: 10 files per question are accepted, the 11th is refused', async () => {
      const rs = []; for (let i = 0; i < 11; i++) rs.push((await w.ee2.upload('x2', Q[2], `m${i}.pdf`, pdf(100 + i))).status);
      assert.deepEqual(rs, [200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 400]);
    });
    it('boundary: just over 50 MB is refused with 413', async () => {
      assert.equal((await w.ee2.upload('x2', Q[3], 'huge.pdf', Buffer.concat([pdf(8), Buffer.alloc(51 * 1048576)]))).status, 413);
    });
    it('sanitises file names (path traversal, CRLF) and keeps Persian names intact', async () => {
      const r = await w.ee2.upload('x2', Q[4], '../../etc/passwd\r\nX-Evil: 1.pdf', pdf(9));
      assert.equal(r.status, 200); assert.doesNotMatch(r.json.name, /[\\/\r\n]/);
      const dl = await w.ee2.req('GET', '/api/files/' + r.json.id);
      assert.doesNotMatch(dl.headers.get('content-disposition'), /[\r\n]/);
      const fa = await w.ee2.upload('x2', Q[4], 'گزارش مدرک ۱۴۰۵.pdf', pdf(10));
      const cd = (await w.ee2.req('GET', '/api/files/' + fa.json.id)).headers.get('content-disposition');
      assert.equal(decodeURIComponent(cd.split("''")[1]), 'گزارش مدرک ۱۴۰۵.pdf');
    });
    it('stored files sit in the uploads folder under random names without extension', () => {
      const names = fs.readdirSync(path.join(srv.dataDir, 'uploads'));
      assert.ok(names.length > 0); assert.ok(names.every(n => /^[0-9a-f]{48}$/.test(n)));
    });
    it('a zip/docx is accepted on its 2-byte "PK" signature alone', { todo: 'known weakness: no deeper content validation' }, async () => {
      assert.equal((await w.ee2.upload('x2', Q[1], 'fake.docx', Buffer.concat([Buffer.from('PK'), Buffer.from('<script>alert(1)</script>')]))).status, 400);
    });
  });

  describe('download and access control', () => {
    it('owner and admin can download; other company, unassigned assessor and assessor of a DRAFT cannot', async () => {
      const u = '/api/files/' + ids['a.pdf'];
      const codes = [await w.ee2.req('GET', u), await w.admin.req('GET', u), await w.ee1.req('GET', u), await w.as1.req('GET', u), await w.as2.req('GET', u)].map(r => r.status);
      assert.deepEqual(codes, [200, 200, 404, 404, 404]);
    });
    it('download is an attachment with nosniff and octet-stream, and requires login', async () => {
      const r = await w.ee2.req('GET', '/api/files/' + ids['a.pdf']);
      assert.equal(r.headers.get('content-type'), 'application/octet-stream');
      assert.match(r.headers.get('content-disposition'), /^attachment/);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal((await new w.ee2.constructor(srv.base).req('GET', '/api/files/' + ids['a.pdf'])).status, 401);
    });
    it('malformed ids are 404, never a path lookup', async () => {
      for (const id of ['..%2f..%2fserver.js', 'f0000', '%00', 'a'.repeat(300)]) assert.ok([404, 401].includes((await w.admin.req('GET', '/api/files/' + id)).status), id);
    });
    it('an assessee cannot cite another assessment\'s file as its own evidence', async () => {
      const own = await w.ee1.upload('x1', Q[0], 'ee1-private.pdf', pdf(11));
      await w.ee2.put({ assessments: [{ id: 'x2', evidence: { [Q[0]]: [{ id: own.json.id, name: 'stolen.pdf' }] } }] });
      assert.ok(!((await w.admin.assessment('x2')).evidence[Q[0]] || []).some(f => f.id === own.json.id));
    });
    it('an assessee can fabricate an evidence entry that has no file behind it', { todo: 'known weakness: "sample" entries are accepted from assessees' }, async () => {
      await w.ee2.put({ assessments: [{ id: 'x2', evidence: { [Q[5]]: [{ id: 'fake1', name: 'Audit-Report.pdf', size: 1, at: 'x', sample: true }] } }] });
      assert.ok(!((await w.admin.assessment('x2')).evidence[Q[5]] || []).some(f => f.sample));
    });
  });

  describe('viewing (assessor is view-only)', () => {
    let aid;
    before(async () => { // x1 is submitted through the API so the assessor may see it
      aid = 'x1';
      const up = await w.ee1.upload('x1', Q[0], 'review.pdf', pdf(12)); ids.review = up.json.id;
      const j = await w.ee1.upload('x1', Q[0], 'review.jpg', JPG); ids.reviewJpg = j.json.id;
      const m = await w.ee1.upload('x1', Q[0], 'review.mp4', MP4); ids.reviewMp4 = m.json.id;
      const o = await w.ee1.upload('x1', Q[0], 'review.doc', OLE); ids.reviewDoc = o.json.id;
      assert.equal((await submit(w.ee1, aid)).status, 204);
    });
    const V = { 'X-Viewer': '1' };
    it('assessor may view pdf and jpg but a plain download is 403', async () => {
      assert.equal((await w.as1.req('GET', `/api/files/${ids.review}?view=1`, { headers: V })).status, 200);
      const jpg = await w.as1.req('GET', `/api/files/${ids.reviewJpg}?view=1`);
      assert.equal(jpg.status, 200); assert.equal(jpg.headers.get('content-type'), 'image/jpeg');
      assert.equal((await w.as1.req('GET', `/api/files/${ids.review}`)).status, 403);
    });
    it('pdf/docx views require the X-Viewer header (a direct browser visit is refused)', async () => {
      assert.equal((await w.as1.req('GET', `/api/files/${ids.review}?view=1`)).status, 400);
    });
    it('pdf/docx views carry no Content-Disposition (Chrome turns such a fetch into an empty 204)', async () => {
      const r = await w.as1.req('GET', `/api/files/${ids.review}?view=1`, { headers: V });
      assert.equal(r.headers.get('content-disposition'), null);
    });
    it('types a browser cannot show (doc, zip) are 415 for everyone', async () => {
      assert.equal((await w.as1.req('GET', `/api/files/${ids.reviewDoc}?view=1`, { headers: V })).status, 415);
      assert.equal((await w.admin.req('GET', `/api/files/${ids.reviewDoc}?view=1`, { headers: V })).status, 415);
    });
    it('assessee and admin may still download', async () => {
      assert.equal((await w.ee1.req('GET', `/api/files/${ids.review}`)).status, 200);
      assert.equal((await w.admin.req('GET', `/api/files/${ids.review}`)).status, 200);
    });
    it('Range requests on mp4: partial content, suffix ranges, invalid and out-of-range are handled', async () => {
      const g = h => w.as1.req('GET', `/api/files/${ids.reviewMp4}?view=1`, { headers: { Range: h } });
      const a = await g('bytes=0-9'), b = await g('bytes=-5');
      assert.equal(a.status, 206); assert.equal(a.buf.length, 10);
      assert.equal(b.status, 206); assert.equal(b.buf.length, 5);
      assert.equal((await g('bytes=5-1')).status, 416);
      assert.equal((await g('bytes=99999-')).status, 416);
    });
  });

  describe('cleanup', () => {
    it('an unreferenced file older than 10 minutes is purged by the next save (database row and blob)', async () => {
      const r = await w.ee2.upload('x2', Q[6], 'orphan.pdf', pdf(13));
      let db = srv.db(); const stored = db.prepare('SELECT stored_name FROM files WHERE id=?').get(r.json.id).stored_name;
      db.prepare("UPDATE files SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(r.json.id); db.close();
      await w.admin.put(await w.admin.state());
      await new Promise(res => setTimeout(res, 300));
      db = srv.db(); assert.equal(db.prepare('SELECT 1 FROM files WHERE id=?').get(r.json.id), undefined); db.close();
      assert.equal(fs.existsSync(path.join(srv.dataDir, 'uploads', stored)), false);
    });
    it('a file that is referenced in evidence survives the purge', async () => {
      await w.ee2.put({ assessments: [{ id: 'x2', evidence: { [Q[0]]: [{ id: ids['a.pdf'] }] } }] });
      const db = srv.db(); db.prepare("UPDATE files SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(ids['a.pdf']); db.close();
      await w.admin.put(await w.admin.state());
      assert.equal((await w.ee2.req('GET', '/api/files/' + ids['a.pdf'])).status, 200);
    });
  });
});
