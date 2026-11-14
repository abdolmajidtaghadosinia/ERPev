// HTTP client with a cookie, plus helpers that build a small "world" (companies, users, assessments) through the public API.
import { DEFAULT_PW, QIDS } from './bundle.mjs';

export class Client {
  constructor(base, username) { this.base = base; this.username = username; this.cookie = ''; }
  async req(method, url, { json, body, headers = {} } = {}) {
    const h = { ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    let b = body;
    if (json !== undefined) { b = JSON.stringify(json); h['Content-Type'] = 'application/json'; }
    if (method !== 'GET' && !h.Origin) h.Origin = this.base;
    const r = await fetch(this.base + url, { method, headers: h, body: b });
    const buf = Buffer.from(await r.arrayBuffer());
    let j = null; try { j = JSON.parse(buf.toString('utf8')); } catch { /* not JSON */ }
    return { status: r.status, headers: r.headers, buf, json: j, setCookie: r.headers.getSetCookie?.() || [] };
  }
  async login(username = this.username, password = DEFAULT_PW) {
    const r = await this.req('POST', '/api/login', { json: { username, password } });
    if (r.status === 200) this.cookie = r.setCookie.map(x => x.split(';')[0]).join('; ');
    return r;
  }
  async state() { return (await this.req('GET', '/api/db')).json; }
  put(state, headers) { return this.req('PUT', '/api/db', { json: state, headers }); }
  async assessment(id) { return (await this.state()).assessments.find(a => a.id === id); }
  upload(assessmentId, questionId, name, body, headers = {}) {
    return this.req('POST', '/api/files', { body, headers: { 'X-Assessment': assessmentId, 'X-Question': questionId, 'X-Name': encodeURIComponent(name), ...headers } });
  }
}

// ---- file fixtures (valid magic bytes, tiny)
export const pdf = (n = 0) => Buffer.concat([Buffer.from(`%PDF-1.4\n% ${n}\n`), Buffer.alloc(200, 0x20), Buffer.from('\n%%EOF')]);
export const JPG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
export const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]), Buffer.alloc(64, 1)]);
export const PK = Buffer.concat([Buffer.from([0x50, 0x4B, 3, 4]), Buffer.alloc(40)]); // zip / docx signature
export const OLE = Buffer.concat([Buffer.from([0xD0, 0xCF, 0x11, 0xE0]), Buffer.alloc(40)]); // legacy .doc signature

export const Q = QIDS;
export const answerAll = (answer = 'YES', text = 'پاسخ تشریحی کامل برای این بند ثبت شد.') =>
  Object.fromEntries(Q.map(q => [q, { answer, level: answer, text }]));
export const decideAll = decisions => Object.fromEntries(Q.map((q, i) => [q, { decision: decisions[i % decisions.length] }]));

// Fresh DB: only admin can log in; the first PUT by admin bootstraps the state.
export async function seedWorld(srv, { extraAssessments = true } = {}) {
  const admin = new Client(srv.base, 'admin');
  const first = await admin.login('admin', 'admin');
  if (first.status !== 200) throw new Error('first-run admin login failed: ' + first.status);
  const seed = {
    companies: [{ id: 'c1', name: 'Company One', sector: 'x', location: 'y' }, { id: 'c2', name: 'Company Two', sector: 'x', location: 'y' }],
    users: [
      { id: 'u-admin', username: 'admin', displayName: 'Admin', role: 'ADMIN', active: true },
      { id: 'u-as1', username: 'assr1', displayName: 'Assessor One', role: 'ASSESSOR', active: true },
      { id: 'u-as2', username: 'assr2', displayName: 'Assessor Two', role: 'ASSESSOR', active: true },
      { id: 'u-ee1', username: 'ee1', displayName: 'Assessee One', role: 'ASSESSEE', companyId: 'c1', active: true },
      { id: 'u-ee2', username: 'ee2', displayName: 'Assessee Two', role: 'ASSESSEE', companyId: 'c2', active: true }],
    assessments: extraAssessments ? [
      { id: 'x1', companyId: 'c1', assessorId: 'u-as1', status: 'DRAFT', responses: {}, evidence: {}, reviews: {}, revComments: {} },
      { id: 'x2', companyId: 'c2', assessorId: 'u-as2', status: 'DRAFT', responses: {}, evidence: {}, reviews: {}, revComments: {} }] : []
  };
  const r = await admin.put(seed);
  if (r.status !== 204) throw new Error('bootstrap failed: ' + r.status + ' ' + r.buf);
  const w = { admin, ee1: new Client(srv.base, 'ee1'), ee2: new Client(srv.base, 'ee2'), as1: new Client(srv.base, 'assr1'), as2: new Client(srv.base, 'assr2') };
  for (const k of ['ee1', 'ee2', 'as1', 'as2']) await w[k].login();
  return w;
}

export async function submit(ee, aid) {
  return ee.put({ assessments: [{ id: aid, status: 'SUBMITTED', responses: answerAll() }] });
}
export async function scoreAndFinalize(as, aid, decisions = ['YES', 'CORRECTIVE', 'NO']) {
  const reviews = decideAll(decisions);
  await as.put({ assessments: [{ id: aid, reviews }] });
  return as.put({ assessments: [{ id: aid, status: 'FINALIZED', reviews }] });
}
