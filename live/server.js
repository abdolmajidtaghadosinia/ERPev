// Serves the bundled prototype with state in SQLite, real login and server-side role-based access control.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3002;
const UPLOAD_DIR = path.join(__dirname, 'uploads'); // outside any served path; files are only reachable via /api/files/:id
const MAX_FILE = 50 * 1024 * 1024;
const SESSION_MS = 12 * 3600 * 1000;
const DEFAULT_PW = 'Readiness@1405';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(__dirname, 'readiness.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY, name TEXT NOT NULL, sector TEXT, location TEXT, extra TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT, role TEXT NOT NULL, company_id TEXT, active INTEGER NOT NULL, extra TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS assessments (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL, assessor_id TEXT, status TEXT NOT NULL,
    submitted_at TEXT, finalized_at TEXT, updated_at TEXT,
    responses TEXT NOT NULL, evidence TEXT NOT NULL, reviews TEXT NOT NULL, rev_comments TEXT NOT NULL, snapshot TEXT, extra TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS credentials (username TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (sid_hash TEXT PRIMARY KEY, username TEXT NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY, assessment_id TEXT NOT NULL, question_id TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL,
    stored_name TEXT NOT NULL, uploader TEXT NOT NULL, created_at TEXT NOT NULL
  );
`);

// ---------- Question bank + scoring (taken from the bundle itself, so the server and the UI always agree) ----------
const SOURCE = fs.readFileSync(path.join(__dirname, 'source.html'), 'utf8');
function bundleAsset(uuid) {
  const tag = '<script type="__bundler/manifest">';
  const i = SOURCE.lastIndexOf(tag);
  const manifest = JSON.parse(SOURCE.slice(i + tag.length, SOURCE.indexOf('</script>', i)));
  const e = manifest[uuid];
  const raw = Buffer.from(e.data, 'base64');
  return (e.compressed ? zlib.gunzipSync(raw) : raw).toString('utf8');
}
const BANK = JSON.parse(bundleAsset('e2df9d42-6527-44d8-ade3-e860f0aea4c6'));
const QIDS = new Set(BANK.questions.map(q => q.id));
let SC; // scoring module, loaded before the server starts listening

const DECISIONS = ['YES', 'CORRECTIVE', 'NO'];
const LEVELS = ['YES', 'PARTIAL', 'NO'];
const STATUSES = ['DRAFT', 'SUBMITTED', 'IN_REVIEW', 'READY_TO_FINALIZE', 'FINALIZED'];
const ROLES = ['ADMIN', 'ASSESSOR', 'ASSESSEE'];

function computeResults(reviews) {
  const dec = {}; for (const k in reviews) dec[k] = reviews[k].decision;
  const score = SC.scoreAssessment(BANK, dec);
  const counts = { YES: 0, CORRECTIVE: 0, NO: 0 }, crit = [], lost = [];
  for (const q of BANK.questions) {
    const d = dec[q.id]; if (!d) continue; counts[d]++;
    if (q.priority === 3 && d !== 'YES') crit.push({ id: q.id, decision: d });
    const l = 3 * q.priority - SC.DECISION_POINTS[d] * q.priority;
    if (l > 0) lost.push({ id: q.id, lost: l, decision: d });
  }
  lost.sort((x, y) => y.lost - x.lost);
  return { score, counts, crit, lost };
}

// ---------- Passwords and sessions ----------
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
function setPassword(username, pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT OR REPLACE INTO credentials VALUES (?,?,?)').run(username, salt, hashPw(pw, salt));
}
function checkPassword(username, pw) {
  const r = db.prepare('SELECT salt, hash FROM credentials WHERE username = ?').get(username);
  if (!r) { hashPw(pw, 'x'.repeat(32)); return false; } // keep timing similar for unknown users
  const a = Buffer.from(hashPw(pw, r.salt), 'hex'), b = Buffer.from(r.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
if (!db.prepare("SELECT 1 FROM credentials WHERE username = 'admin'").get()) setPassword('admin', 'admin');

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const cookieOf = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]));
function newSession(username) {
  const sid = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(sha(sid), username, Date.now() + SESSION_MS);
  return sid;
}
const attempts = new Map(); // ip -> { n, until }

// ---------- State storage ----------
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const omit = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

const stateEmpty = () => !db.prepare('SELECT 1 FROM companies LIMIT 1').get() && !db.prepare('SELECT 1 FROM users LIMIT 1').get();

function load() {
  const companies = db.prepare('SELECT * FROM companies').all();
  if (!companies.length && !db.prepare('SELECT 1 FROM users LIMIT 1').get()) return null;
  return {
    companies: companies.map(r => ({ ...JSON.parse(r.extra), id: r.id, name: r.name, sector: r.sector, location: r.location })),
    users: db.prepare('SELECT * FROM users').all().map(r => ({ ...JSON.parse(r.extra), id: r.id, username: r.username, displayName: r.display_name, role: r.role, companyId: r.company_id, active: !!r.active })),
    assessments: db.prepare('SELECT * FROM assessments').all().map(r => ({
      ...JSON.parse(r.extra), id: r.id, companyId: r.company_id, assessorId: r.assessor_id, status: r.status,
      submittedAt: r.submitted_at, finalizedAt: r.finalized_at, updatedAt: r.updated_at,
      responses: JSON.parse(r.responses), evidence: JSON.parse(r.evidence), reviews: JSON.parse(r.reviews), revComments: JSON.parse(r.rev_comments),
      ...(r.snapshot ? { snapshot: JSON.parse(r.snapshot) } : {})
    }))
  };
}

function save(state) {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM companies; DELETE FROM users; DELETE FROM assessments;');
    const c = db.prepare('INSERT INTO companies VALUES (?,?,?,?,?)');
    for (const x of state.companies) c.run(x.id, x.name, x.sector ?? null, x.location ?? null, JSON.stringify(omit(x, ['id', 'name', 'sector', 'location'])));
    const u = db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)');
    for (const x of state.users) u.run(x.id, x.username, x.displayName ?? null, x.role, x.companyId ?? null, x.active ? 1 : 0, JSON.stringify(omit(x, ['id', 'username', 'displayName', 'role', 'companyId', 'active'])));
    const a = db.prepare('INSERT INTO assessments VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const x of state.assessments) a.run(
      x.id, x.companyId, x.assessorId ?? null, x.status, x.submittedAt ?? null, x.finalizedAt ?? null, x.updatedAt ?? null,
      JSON.stringify(x.responses || {}), JSON.stringify(x.evidence || {}), JSON.stringify(x.reviews || {}), JSON.stringify(x.revComments || {}),
      x.snapshot ? JSON.stringify(x.snapshot) : null,
      JSON.stringify(omit(x, ['id', 'companyId', 'assessorId', 'status', 'submittedAt', 'finalizedAt', 'updatedAt', 'responses', 'evidence', 'reviews', 'revComments', 'snapshot']))
    );
    for (const x of state.users) if (!db.prepare('SELECT 1 FROM credentials WHERE username = ?').get(x.username)) setPassword(x.username, DEFAULT_PW);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------- Who is calling ----------
// A principal is { username, role, id, companyId } or null. While the database is empty, 'admin' acts as a bootstrap admin so it can create the initial state.
function principalOf(username) {
  if (!username) return null;
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (row) return row.active ? { username, role: row.role, id: row.id, companyId: row.company_id } : null;
  if (username === 'admin' && stateEmpty()) return { username, role: 'ADMIN', id: null, companyId: null };
  return null;
}
function sessionPrincipal(req) {
  const sid = cookieOf(req).sid;
  if (!sid) return null;
  const s = db.prepare('SELECT username, expires FROM sessions WHERE sid_hash = ?').get(sha(sid));
  if (!s) return null;
  if (s.expires < Date.now()) { db.prepare('DELETE FROM sessions WHERE sid_hash = ?').run(sha(sid)); return null; }
  return principalOf(s.username);
}

// ---------- Per-role read view ----------
function viewFor(p, st) {
  if (p.role === 'ADMIN') return st;
  if (p.role === 'ASSESSEE') {
    const mine = st.assessments.filter(a => a.companyId === p.companyId).map(a =>
      a.status === 'FINALIZED' ? a : { ...omit(a, ['snapshot']), reviews: {}, revComments: {} });
    const assessorIds = new Set(mine.map(a => a.assessorId));
    return {
      companies: st.companies.filter(c => c.id === p.companyId),
      users: st.users.filter(u => u.id === p.id || assessorIds.has(u.id)),
      assessments: mine
    };
  }
  const mine = st.assessments.filter(a => a.assessorId === p.id && a.status !== 'DRAFT');
  const cids = new Set(mine.map(a => a.companyId));
  return {
    companies: st.companies.filter(c => cids.has(c.id)),
    users: st.users.filter(u => u.id === p.id || (u.role === 'ASSESSEE' && cids.has(u.companyId))),
    assessments: mine
  };
}

// ---------- Sanitizers (everything coming from the client is untrusted) ----------
function cleanResponses(inc) {
  const out = {};
  if (!isObj(inc)) return out;
  for (const [qid, r] of Object.entries(inc)) {
    if (!QIDS.has(qid) || !isObj(r)) continue;
    const o = {};
    for (const k of ['level', 'answer']) if (LEVELS.includes(r[k])) o[k] = r[k];
    if (typeof r.text === 'string') o.text = r.text.slice(0, 5000);
    if (typeof r.comment === 'string') o.comment = r.comment.slice(0, 2000);
    out[qid] = o;
  }
  return out;
}
function cleanEvidence(inc, aid, allowSample) {
  const out = {};
  if (!isObj(inc)) return out;
  const find = db.prepare('SELECT id, name, size, created_at FROM files WHERE id = ? AND assessment_id = ? AND question_id = ?');
  for (const [qid, list] of Object.entries(inc)) {
    if (!QIDS.has(qid) || !Array.isArray(list)) continue;
    const kept = [];
    for (const f of list.slice(0, 10)) {
      if (!isObj(f)) continue;
      if (f.sample === true && allowSample) kept.push({ id: str(f.id, 40), name: str(f.name, 200), size: Math.max(0, Number(f.size) | 0), at: str(f.at, 40), sample: true });
      else { const r = find.get(str(f.id, 60), aid, qid); if (r) kept.push({ id: r.id, name: r.name, size: r.size, at: r.created_at }); }
    }
    if (kept.length) out[qid] = kept;
  }
  return out;
}
function cleanReviews(inc) {
  const out = {};
  if (!isObj(inc)) return out;
  for (const [qid, r] of Object.entries(inc)) if (QIDS.has(qid) && isObj(r) && DECISIONS.includes(r.decision)) out[qid] = { decision: r.decision };
  return out;
}
function cleanComments(inc) {
  const out = {};
  if (!isObj(inc)) return out;
  for (const [qid, t] of Object.entries(inc)) if (QIDS.has(qid) && typeof t === 'string' && t.trim()) out[qid] = t.slice(0, 2000);
  return out;
}
const iso = () => new Date().toISOString();
const replaceAssessment = (st, a) => ({ ...st, assessments: st.assessments.map(x => (x.id === a.id ? a : x)) });

// ---------- Write rules per role ----------
function mergeAssessee(cur, inc, p) {
  const A = cur.assessments.find(a => a.companyId === p.companyId);
  const B = isObj(inc) && Array.isArray(inc.assessments) && A ? inc.assessments.find(a => isObj(a) && a.id === A.id) : null;
  if (!A || !B) return null;
  if (A.status !== 'DRAFT') return null; // after submission the questionnaire is read-only
  const next = { ...A, responses: cleanResponses(B.responses), evidence: cleanEvidence(B.evidence, A.id, true), updatedAt: iso() };
  if (B.status === 'SUBMITTED') {
    if (!BANK.questions.every(q => SC.isComplete(next.responses[q.id]))) throw bad('پرسش‌نامه کامل نیست؛ همه‌ی بندها باید پاسخ داده شوند', 409);
    next.status = 'SUBMITTED'; next.submittedAt = iso();
  }
  return replaceAssessment(cur, next);
}

function mergeAssessor(cur, inc, p) {
  let st = cur, changed = false;
  for (const A of cur.assessments) {
    if (A.assessorId !== p.id || !['SUBMITTED', 'IN_REVIEW', 'READY_TO_FINALIZE'].includes(A.status)) continue;
    const B = Array.isArray(inc.assessments) ? inc.assessments.find(a => isObj(a) && a.id === A.id) : null;
    if (!B) continue;
    const next = { ...A, reviews: cleanReviews(B.reviews), revComments: cleanComments(B.revComments), updatedAt: iso() };
    for (const k of Object.keys(A.reviews)) if (!next.reviews[k]) next.reviews[k] = A.reviews[k]; // decisions can be changed, never removed
    const n = Object.keys(next.reviews).length;
    if (next.status === 'SUBMITTED' && n > 0) { next.status = 'IN_REVIEW'; next.reviewStartedAt = iso(); }
    if (next.status === 'IN_REVIEW' && n === BANK.questions.length) next.status = 'READY_TO_FINALIZE';
    if (B.status === 'FINALIZED') {
      if (next.status !== 'READY_TO_FINALIZE') throw bad('برای نهایی‌سازی همه‌ی بندها باید نمره‌دهی شده باشند', 409);
      next.status = 'FINALIZED'; next.finalizedAt = iso(); next.snapshot = computeResults(next.reviews); // snapshot is computed here, never trusted from the client
    }
    st = replaceAssessment(st, next); changed = true;
  }
  return changed ? st : null;
}

function mergeAdmin(cur, inc) {
  const out = { companies: [...cur.companies], users: [...cur.users], assessments: [...cur.assessments] };
  for (const c of Array.isArray(inc.companies) ? inc.companies : []) {
    if (!isObj(c) || typeof c.id !== 'string') continue;
    const clean = { id: str(c.id, 60), name: str(c.name, 200).trim(), sector: str(c.sector, 100), location: str(c.location, 100) };
    if (!clean.name || !/^[\w-]+$/.test(clean.id)) throw bad('نام شرکت الزامی است');
    const i = out.companies.findIndex(x => x.id === clean.id);
    if (i >= 0) out.companies[i] = { ...out.companies[i], ...clean }; else out.companies.push(clean);
  }
  for (const u of Array.isArray(inc.users) ? inc.users : []) {
    if (!isObj(u) || typeof u.id !== 'string') continue;
    const i = out.users.findIndex(x => x.id === u.id);
    if (i >= 0) {
      const ex = out.users[i];
      out.users[i] = { ...ex, displayName: str(u.displayName, 200) || ex.displayName, title: str(u.title, 200) || ex.title, active: ex.username === 'admin' ? true : !!u.active };
    } else {
      const username = str(u.username, 40).trim();
      if (!/^[A-Za-z0-9_.-]{3,40}$/.test(username) || !/^[\w-]+$/.test(u.id)) throw bad('نام کاربری نامعتبر است');
      if (out.users.some(x => x.username === username)) throw bad('این نام کاربری قبلاً ثبت شده است', 409);
      if (!ROLES.includes(u.role)) throw bad('نقش نامعتبر است');
      if (u.role === 'ASSESSEE' && !out.companies.some(c => c.id === u.companyId)) throw bad('برای ارزیابی‌شونده انتخاب شرکت الزامی است');
      out.users.push({ id: u.id, username, displayName: str(u.displayName, 200).trim(), title: str(u.title, 200), role: u.role, companyId: u.role === 'ASSESSEE' ? u.companyId : null, active: true });
    }
  }
  const isAssessor = id => out.users.some(x => x.id === id && x.role === 'ASSESSOR' && x.active);
  for (const a of Array.isArray(inc.assessments) ? inc.assessments : []) {
    if (!isObj(a) || typeof a.id !== 'string') continue;
    const i = out.assessments.findIndex(x => x.id === a.id);
    if (i >= 0) {
      const ex = out.assessments[i];
      if (a.assessorId !== ex.assessorId) {
        if (ex.status === 'FINALIZED') throw bad('ارزیابی نهایی‌شده قابل تغییر نیست', 409);
        if (!isAssessor(a.assessorId)) throw bad('ارزیاب نامعتبر است');
        out.assessments[i] = { ...ex, assessorId: a.assessorId, updatedAt: iso() };
      }
    } else {
      if (!/^[\w-]+$/.test(a.id) || !out.companies.some(c => c.id === a.companyId)) throw bad('شرکت نامعتبر است');
      if (out.assessments.some(x => x.companyId === a.companyId)) throw bad('برای این شرکت قبلاً ارزیابی ایجاد شده است', 409);
      if (!isAssessor(a.assessorId)) throw bad('ارزیاب نامعتبر است');
      out.assessments.push({ id: a.id, companyId: a.companyId, assessorId: a.assessorId, status: 'DRAFT', submittedAt: null, reviewStartedAt: null, finalizedAt: null, updatedAt: iso(), responses: {}, evidence: {}, reviews: {}, revComments: {} });
    }
  }
  return out;
}

// First save into an empty database (the admin creating the initial state): accept the full state, but rebuild every assessment from validated parts.
function bootstrap(inc) {
  if (!isObj(inc) || !Array.isArray(inc.companies) || !Array.isArray(inc.users) || !Array.isArray(inc.assessments)) throw bad('ساختار داده نامعتبر است');
  const companies = inc.companies.map(c => ({ id: str(c.id, 60), name: str(c.name, 200), sector: str(c.sector, 100), location: str(c.location, 100) }));
  const users = inc.users.map(u => ({ id: str(u.id, 60), username: str(u.username, 40), displayName: str(u.displayName, 200), title: str(u.title, 200), role: u.role, companyId: u.companyId || null, active: !!u.active }));
  if (users.some(u => !ROLES.includes(u.role) || !/^[A-Za-z0-9_.-]{3,40}$/.test(u.username)) || new Set(users.map(u => u.username)).size !== users.length)
    throw bad('داده‌ی کاربران نامعتبر است');
  if (!users.some(u => u.username === 'admin' && u.role === 'ADMIN' && u.active)) throw bad('حساب admin باید وجود داشته باشد');
  const assessments = inc.assessments.map(a => {
    if (!isObj(a) || !STATUSES.includes(a.status) || !companies.some(c => c.id === a.companyId)) throw bad('داده‌ی ارزیابی نامعتبر است');
    const x = {
      id: str(a.id, 60), companyId: a.companyId, assessorId: a.assessorId || null, status: a.status,
      submittedAt: str(a.submittedAt, 40) || null, reviewStartedAt: str(a.reviewStartedAt, 40) || null, finalizedAt: str(a.finalizedAt, 40) || null, updatedAt: iso(),
      responses: cleanResponses(a.responses), evidence: cleanEvidence(a.evidence, a.id, true), reviews: cleanReviews(a.reviews), revComments: cleanComments(a.revComments)
    };
    if (x.status === 'FINALIZED') x.snapshot = computeResults(x.reviews);
    return x;
  });
  return { companies, users, assessments };
}

function applyWrite(p, inc) {
  const cur = load();
  if (p.role === 'ADMIN') {
    if (!cur) return bootstrap(inc);
    if (!isObj(inc)) throw bad('ساختار داده نامعتبر است');
    return mergeAdmin(cur, inc);
  }
  if (!cur || !isObj(inc)) return null;
  return p.role === 'ASSESSEE' ? mergeAssessee(cur, inc, p) : mergeAssessor(cur, inc, p);
}

function dropOrphanFiles() {
  const used = new Set();
  const st = load();
  if (st) for (const a of st.assessments) for (const list of Object.values(a.evidence)) for (const f of list) used.add(f.id);
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  for (const f of db.prepare('SELECT id, stored_name FROM files WHERE created_at < ?').all(old)) {
    if (used.has(f.id)) continue;
    db.prepare('DELETE FROM files WHERE id = ?').run(f.id);
    fs.rm(path.join(UPLOAD_DIR, f.stored_name), () => {});
  }
}

// ---------- Files ----------
const VIEW_TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', mp4: 'video/mp4', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
const VIEW_BY_FETCH = ['pdf', 'docx']; // rendered in the page by pdf.js / docx-preview; requires the X-Viewer header // types shown inline in the viewer
const ALLOWED_EXT = ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'mp4', 'zip'];
function magicOk(ext, b) {
  const h = (...xs) => xs.every((x, i) => b[i] === x);
  return { pdf: h(0x25, 0x50, 0x44, 0x46), jpg: h(0xFF, 0xD8, 0xFF), jpeg: h(0xFF, 0xD8, 0xFF), zip: h(0x50, 0x4B), docx: h(0x50, 0x4B), doc: h(0xD0, 0xCF, 0x11, 0xE0), mp4: b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 }[ext];
}
const readBuffer = (req, limit) => new Promise((resolve, reject) => {
  const chunks = []; let n = 0;
  req.on('data', c => { n += c.length; if (n > limit) { reject(bad('حجم فایل از ۵۰ مگابایت بیشتر است', 413)); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

function canReadAssessment(p, a) {
  if (p.role === 'ADMIN') return true;
  if (p.role === 'ASSESSEE') return a.company_id === p.companyId;
  return a.assessor_id === p.id && a.status !== 'DRAFT';
}

// ---------- Client patches ----------
// The bundled page keeps all state in the browser; these patches load/save it through the API instead. The template lives inside a JSON string, so
// injected code is JSON-escaped, and swap() replaces the first match, so order matters.
function buildPage() {
  let html = SOURCE;
  const swap = (from, to) => {
    const enc = s => JSON.stringify(s).slice(1, -1);
    const anchor = html.includes(from) ? from : enc(from); // anchors with quotes appear escaped inside the JSON string
    if (!html.includes(anchor)) throw new Error('Patch anchor not found: ' + from);
    html = html.replace(anchor, () => enc(to));
  };
  const EMPTY = '{ companies: [], users: [], assessments: [] }';
  swap('login(username, pw) {', 'loginDemo(username, pw) {');
  swap('this.setState({ ready: true, db: this.seed() });',
    `this.lastDb = ${EMPTY}; this.setState({ ready: true, db: this.lastDb });
      try { const m = await fetch('/api/me'); if (m.ok) await this.enter((await m.json()).username); } catch (e) {}`);
  swap("componentWillUnmount() { window.removeEventListener('resize', this.onResize); }",
    `componentWillUnmount() { window.removeEventListener('resize', this.onResize); }
  componentDidUpdate() { const d = this.state.db; if (d && d !== this.lastDb) { this.lastDb = d; if (this.state.userId) this.persist(d); } }
  persist(d) {
    clearTimeout(this.pT);
    this.pT = setTimeout(async () => {
      try {
        const r = await fetch('/api/db', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });
        if (r.status === 401) return this.logoutNow();
        if (!r.ok) { let m = 'ذخیره‌ی تغییرات ممکن نشد'; try { m = (await r.json()).error || m; } catch (e) {} this.toast(m, 'err'); const u = this.me(); if (u) await this.enter(u.username, true); }
      } catch (e) { this.toast('ارتباط با سرور برقرار نیست', 'err'); }
    }, 400);
  }
  logoutNow() { this.lastDb = ${EMPTY}; this.setState({ userId: null, db: this.lastDb, screen: 'login', modal: null, drawer: false }); }
  freshDb() { return { companies: [], users: [{ id: 'u-admin', username: 'admin', displayName: 'مدیر سامانه', title: 'مدیر سامانه', role: 'ADMIN', companyId: null, active: true }], assessments: [] }; }
  async enter(username, keepScreen) {
    const g = await fetch('/api/db'); if (g.status === 401) return false;
    const saved = g.status === 200 ? await g.json() : null;
    const dbState = saved || this.freshDb(); this.lastDb = dbState; if (!saved) this.persist(dbState);
    const u = dbState.users.find(x => x.username === username && x.active); if (!u) return false;
    this.compCache = new WeakMap(); this.resCache = new WeakMap();
    const home = { ASSESSEE: 'a-home', ASSESSOR: 'o-dash', ADMIN: 'm-dash' }[u.role];
    this.setState(keepScreen ? { db: dbState, userId: u.id } : { db: dbState, userId: u.id, lerr: false, lu: '', lp: '', screen: home, aid: null, indId: 'IND-01', stFilter: 'active', save: 'idle' });
    return true;
  }
  async login(username, pw) {
    try {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: (username || '').trim(), password: pw || '' }) });
      if (!r.ok || !(await this.enter((await r.json()).username))) this.setState({ lerr: true });
    } catch (e) { this.setState({ lerr: true }); }
  }
  async downloadServer(f) {
    try {
      const r = await fetch('/api/files/' + encodeURIComponent(f.id));
      if (!r.ok) { this.toast('دانلود این فایل مجاز نیست یا فایل پیدا نشد', 'err'); return; }
      const url = URL.createObjectURL(await r.blob()); const el = document.createElement('a'); el.href = url; el.download = f.name; document.body.appendChild(el); el.click(); el.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { this.toast('دانلود ناموفق بود', 'err'); }
  }
  async changePassword() {
    const oldPassword = window.prompt('رمز فعلی را وارد کنید'); if (oldPassword === null) return;
    const newPassword = window.prompt('رمز جدید را وارد کنید (حداقل ۸ نویسه)'); if (newPassword === null) return;
    try {
      const r = await fetch('/api/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldPassword, newPassword }) });
      if (r.ok) this.toast('رمز عبور تغییر کرد'); else this.toast((await r.json()).error || 'تغییر رمز ممکن نشد', 'err');
    } catch (e) { this.toast('ارتباط با سرور برقرار نیست', 'err'); }
  }`);
  swap("logout: () => this.setState({ userId: null, screen: 'login', modal: null, drawer: false }),",
    "logout: () => { fetch('/api/logout', { method: 'POST' }).catch(() => {}); this.logoutNow(); }, changePw: () => this.changePassword(),");
  swap('<button sc-camel-on-click="{{ logout }}" title="خروج"',
    '<button sc-camel-on-click="{{ changePw }}" title="تغییر رمز عبور" aria-label="تغییر رمز عبور" style="height:36px;padding:0 8px;border:none;background:transparent;border-radius:8px;cursor:pointer;color:#6b7280;font-size:12px">رمز</button><button sc-camel-on-click="{{ logout }}" title="خروج"');
  // assessee whose company has no assessment yet: show a message instead of a blank page
  swap("sMAssess: sc === 'm-assess' };", "sMAssess: sc === 'm-assess', sNoA: me.role === 'ASSESSEE' && !a };");
  swap('<!-- ASSESSEE HOME -->', '<sc-if value="{{ sNoA }}"><div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:40px 24px;text-align:center;color:#374151;font-size:14px;line-height:2"><div style="font-size:16px;font-weight:700;margin-bottom:6px">هنوز ارزیابی‌ای برای شرکت شما ایجاد نشده است</div>مدیر سامانه باید برای شرکت شما یک ارزیابی ایجاد کند. پس از آن می‌توانید پرسش‌نامه را تکمیل کنید.</div></sc-if><!-- ASSESSEE HOME -->');
  // ---- file management: viewer (no download for assessors) + per-assessment files page ----
  const EYE = '<svg width="15" height="15" sc-camel-view-box="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
  const IC_BTN = 'width:28px;height:28px;border:none;background:transparent;border-radius:6px;cursor:pointer;color:#155e75;display:flex;align-items:center;justify-content:center';
  swap('onDownload: () => this.download(f) }))', 'onDownload: () => this.download(f), onView: () => this.viewFile(f), canDownload: me.role !== \'ASSESSOR\' }))');
  swap('<button sc-camel-on-click="{{ fl.onDownload }}"',
    '<button sc-camel-on-click="{{ fl.onView }}" aria-label="مشاهده" title="مشاهده" style="' + IC_BTN + '" style-hover="background:#eaf7fa">' + EYE + '</button><sc-if value="{{ fl.canDownload }}"><button sc-camel-on-click="{{ fl.onDownload }}"');
  swap('<sc-if value="{{ fl.canRemove }}">', '</sc-if><sc-if value="{{ fl.canRemove }}">');
  swap("let activeKey = S.screen;", "if (me.role !== 'ADMIN') defs.push(['files', 'مدیریت فایل‌ها', 'Folder', !a]); let activeKey = S.screen;");
  swap("iUsers: icon === 'Users',", "iUsers: icon === 'Users', iFolder: icon === 'Folder',");
  swap('<sc-if value="{{ it.iUsers }}">', '<sc-if value="{{ it.iFolder }}"><svg width="20" height="20" sc-camel-view-box="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"></path></svg></sc-if><sc-if value="{{ it.iUsers }}">');
  swap("sNoA: me.role === 'ASSESSEE' && !a };", "sNoA: me.role === 'ASSESSEE' && !a, sFiles: sc === 'files' && !!a, viewerOn: !!S.viewer, vw: this.viewerVals() };");
  swap('if (v.sQuest) v.qv = this.questVals(me, a);', 'if (v.sQuest) v.qv = this.questVals(me, a); if (v.sFiles) v.fv = this.filesVals(me, a);');
  swap('removeFile(aid, qid, fid) {', `viewFile(f) {
    if (f.sample) { this.toast('فایل نمونه‌ی ساختگی است و محتوایی برای نمایش ندارد', 'info'); return; }
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    this.setState({ viewer: { id: f.id, name: f.name, kind: { pdf: 'doc', docx: 'doc', jpg: 'img', jpeg: 'img', mp4: 'vid' }[ext] || 'none', fmt: ext } });
    if (ext === 'pdf' || ext === 'docx') setTimeout(() => this.renderDoc(f.id, ext), 60);
  }
  loadJs(url) {
    this.jsLoaded = this.jsLoaded || {};
    return this.jsLoaded[url] = this.jsLoaded[url] || new Promise((ok, no) => { const el = document.createElement('script'); el.src = url; el.onload = ok; el.onerror = () => { delete this.jsLoaded[url]; no(new Error('load')); }; document.head.appendChild(el); });
  }
  async renderDoc(id, ext) {
    const box = document.getElementById('vw-doc'); if (!box) return;
    const live = () => this.state.viewer && this.state.viewer.id === id && document.getElementById('vw-doc') === box;
    const note = (t, c) => { box.innerHTML = ''; const d = document.createElement('div'); d.style.cssText = 'padding:24px;font-size:14px;line-height:2;color:' + (c || '#6b7280'); d.textContent = t; box.appendChild(d); };
    note('در حال بارگذاری…');
    try {
      const r = await fetch('/api/files/' + encodeURIComponent(id) + '?view=1', { headers: { 'X-Viewer': '1' } });
      if (!r.ok) { note('نمایش فایل مجاز نیست یا فایل پیدا نشد', '#b91c1c'); return; }
      const buf = await r.arrayBuffer(); if (!live()) return;
      if (ext === 'pdf') {
        await this.loadJs('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
        if (!this.pdfWorker) this.pdfWorker = URL.createObjectURL(new Blob([await (await fetch('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js')).text()], { type: 'text/javascript' }));
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = this.pdfWorker;
        const pdf = await window.pdfjsLib.getDocument({ data: buf, disableFontFace: true }).promise; if (!live()) return;
        box.innerHTML = ''; box.style.background = '#e5e7eb';
        const W = Math.max(300, Math.min(box.clientWidth - 32, 900)), N = Math.min(pdf.numPages, 60);
        for (let i = 1; i <= N; i++) {
          const pg = await pdf.getPage(i); if (!live()) return;
          const base = pg.getViewport({ scale: 1 }), vp = pg.getViewport({ scale: W / base.width * 2 });
          const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
          cv.style.cssText = 'display:block;margin:12px auto;width:' + W + 'px;max-width:100%;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.2)';
          cv.oncontextmenu = e => e.preventDefault(); box.appendChild(cv);
          await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
        }
        if (pdf.numPages > N) note('فقط ' + N + ' صفحه‌ی اول از ' + pdf.numPages + ' صفحه نمایش داده شد.');
      } else {
        await this.loadJs('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
        await this.loadJs('https://cdn.jsdelivr.net/npm/docx-preview@0.3.2/dist/docx-preview.min.js');
        box.innerHTML = ''; box.style.background = '#e5e7eb';
        await window.docx.renderAsync(buf, box, null, { inWrapper: true, ignoreWidth: false, breakPages: true });
      }
    } catch (e) { if (live()) note('پیش‌نمایش فایل ممکن نشد. اتصال اینترنت (برای بارگذاری کتابخانه‌ی نمایش) و سالم‌بودن فایل را بررسی کنید.', '#b91c1c'); }
  }
  viewerVals() {
    const v = this.state.viewer; if (!v) return {};
    const src = '/api/files/' + encodeURIComponent(v.id) + '?view=1';
    return { name: v.name, isDoc: v.kind === 'doc', isImg: v.kind === 'img', isVid: v.kind === 'vid', noPrev: v.kind === 'none', src, pdfSrc: src + '#toolbar=0&navpanes=0', close: () => this.setState({ viewer: null }), stop: e => e.stopPropagation() };
  }
  filesVals(me, a) {
    const rows = [], canDl = me.role !== 'ASSESSOR';
    for (const q of this.bank.questions) for (const f of (a.evidence[q.id] || [])) {
      rows.push({ qnum: this.n(q.order), qtext: q.text_fa.length > 90 ? q.text_fa.slice(0, 90) + '…' : q.text_fa, name: f.name, meta: this.size(f.size) + ' · ' + this.d(f.at),
        canDownload: canDl, onView: () => this.viewFile(f), onDownload: () => this.download(f), onGo: () => this.go('quest', { indId: q.indicator_id }) });
    }
    return { title: this.co(a.companyId).name, count: this.n(rows.length), rows, has: rows.length > 0, empty: rows.length === 0,
      note: canDl ? 'فایل‌های بارگذاری‌شده برای هر بند پرسش‌نامه' : 'فایل‌ها فقط برای مشاهده‌اند و دانلود برای ارزیاب غیرفعال است' };
  }
  removeFile(aid, qid, fid) {`);
  const BTN = 'style="' + IC_BTN + '" style-hover="background:#eaf7fa"';
  swap('<!-- ASSESSEE HOME -->', `<sc-if value="{{ sFiles }}"><div style="display:flex;flex-direction:column;gap:16px">
    <div style="display:flex;flex-direction:column;gap:4px"><span style="font-size:12.5px;color:#6b7280">مدیریت فایل‌ها · {{ fv.count }} فایل</span><span style="font-size:22px;font-weight:700;color:#124d62">{{ fv.title }}</span><span style="font-size:12.5px;color:#6b7280">{{ fv.note }}</span></div>
    <sc-if value="{{ fv.empty }}"><div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:40px 24px;text-align:center;color:#6b7280;font-size:14px">هنوز فایلی بارگذاری نشده است.</div></sc-if>
    <sc-if value="{{ fv.has }}"><div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
      <sc-for list="{{ fv.rows }}" as="r"><div style="display:flex;align-items:center;gap:12px;padding:10px 16px;border-top:1px solid #eef0f2;flex-wrap:wrap">
        <button sc-camel-on-click="{{ r.onGo }}" title="رفتن به بند" style="border:none;background:#eaf7fa;color:#124d62;border-radius:999px;padding:2px 10px;font-size:12px;cursor:pointer">بند {{ r.qnum }}</button>
        <div style="flex:1;min-width:200px;display:flex;flex-direction:column;gap:2px"><span style="font-size:13.5px;color:#1f2937;word-break:break-all">{{ r.name }}</span><span style="font-size:11.5px;color:#6b7280">{{ r.qtext }}</span></div>
        <span style="font-size:12px;color:#6b7280">{{ r.meta }}</span>
        <button sc-camel-on-click="{{ r.onView }}" aria-label="مشاهده" title="مشاهده" ${BTN}>${EYE}</button>
        <sc-if value="{{ r.canDownload }}"><button sc-camel-on-click="{{ r.onDownload }}" aria-label="دانلود" title="دانلود" ${BTN}><svg width="15" height="15" sc-camel-view-box="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"></path></svg></button></sc-if>
      </div></sc-for>
    </div></sc-if>
  </div></sc-if>
  <sc-if value="{{ viewerOn }}"><div sc-camel-on-click="{{ vw.close }}" style="position:fixed;inset:0;z-index:1000;background:rgba(15,23,32,.75);display:flex;align-items:center;justify-content:center;padding:20px">
    <div sc-camel-on-click="{{ vw.stop }}" style="background:#fff;border-radius:14px;width:min(1100px,100%);height:min(90vh,100%);display:flex;flex-direction:column;overflow:hidden">
      <div style="display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid #e5e7eb"><span style="flex:1;font-size:14px;font-weight:600;color:#124d62;word-break:break-all">{{ vw.name }}</span><button sc-camel-on-click="{{ vw.close }}" style="height:34px;padding:0 16px;border:1px solid #d1d5db;background:#fff;border-radius:8px;cursor:pointer;font-size:13px">بستن</button></div>
      <div style="flex:1;min-height:0;background:#f3f4f6;display:flex;align-items:center;justify-content:center">
        <sc-if value="{{ vw.isDoc }}"><div id="vw-doc" style="width:100%;height:100%;overflow:auto"></div></sc-if>
        <sc-if value="{{ vw.isImg }}"><img src="{{ vw.src }}" alt="" style="max-width:100%;max-height:100%;object-fit:contain"></sc-if>
        <sc-if value="{{ vw.isVid }}"><video src="{{ vw.src }}" controls="" controlslist="nodownload" style="max-width:100%;max-height:100%"></video></sc-if>
        <sc-if value="{{ vw.noPrev }}"><div style="padding:24px;color:#6b7280;font-size:14px;text-align:center;line-height:2">پیش‌نمایش این نوع فایل (doc، zip) ممکن نیست.</div></sc-if>
      </div>
    </div>
  </div></sc-if><!-- ASSESSEE HOME -->`);
  swap("quick: [q('assessee-draft',", "quick: [], unusedQuick: [q('assessee-draft',");
  // Remove demo-only UI: quick-login divider, demo banners/badges, demo tools, "demo" wording.
  swap('display:flex;align-items:center;gap:12px;color:#9ca3af;font-size:12.5px\\"><div style=\\"flex:1;height:1px;background:#e5e7eb\\"><\\u002Fdiv>ورود سریع (نمایشی)', 'display:none">');
  swap('نسخه نمایشی · دوره ۱۴۰۵', 'دوره ۱۴۰۵');
  swap('margin:0 14px 12px;font-size:12px;color:#8a5a0f;background:#fdf3e1;border-radius:8px;', 'display:none;');
  swap("showAutofill: mode === 'edit',", 'showAutofill: false,');
  swap("showAutoscore: mode === 'review' && scoredN < N,", 'showAutoscore: false,');
  swap('sc-camel-on-click=\\"{{ md.openReset }}\\" style=\\"height:40px', 'hidden sc-camel-on-click="{{ md.openReset }}" style="height:40px');
  swap('رمز اولیه‌ی کاربران جدید در نسخه‌ی نمایشی Demo@1234 است.', 'رمز اولیه‌ی کاربران جدید ' + DEFAULT_PW + ' است.');
  swap('کاربر افزوده شد؛ رمز اولیه: Demo@1234', 'کاربر افزوده شد؛ رمز اولیه: ' + DEFAULT_PW);
  swap('<title>Bundled Page</title>', '<title>سامانه ارزیابی آمادگی</title>');
  swap('تصویری روشن از آمادگی سازمان شما.', 'تصویری روشن از آمادگی زیرساخت های منطقه ویژه اقتصادی');
  swap("مقایسه‌ی شرکت‌ها', 'Chart'", "مقایسه زیرساخت‌ها', 'Chart'");
  swap('مقایسه‌ی شرکت‌ها', 'مقایسه زیرساخت‌ها');
  // Infrastructure comparison is an admin-panel feature covering every company, not an assessor page.
  swap(", ['o-compare', 'مقایسه زیرساخت‌ها', 'Chart']]", ']');
  swap("['m-assess', 'ارزیابی‌ها', 'List']];", "['m-assess', 'ارزیابی‌ها', 'List'], ['m-compare', 'مقایسه زیرساخت‌ها', 'Chart']];");
  swap("sOCompare: sc === 'o-compare',", "sOCompare: sc === 'm-compare',");
  swap('compareVals(me) {\\n    const S = this.state;\\n    const mine = S.db.assessments.filter(x => x.assessorId === me.id && x.status !== \'DRAFT\');',
    'compareVals(me) {\n    const S = this.state;\n    const mine = S.db.assessments.filter(x => x.status !== \'DRAFT\'); // admin sees every company\'s assessment');
  swap('return { ind: S.cmpInd, onInd:', `const inCmp = new Set(mine.map(x => x.companyId));
    const pending = S.db.companies.filter(c => !inCmp.has(c.id)).map(c => { const a = S.db.assessments.find(x => x.companyId === c.id), st = a ? this.ST[a.status] : { or: 'بدون ارزیابی', bg: '#f3f4f6', fg: '#6b7280' };
      return { name: c.name, sector: c.sector || '—', status: st.or, bg: st.bg, fg: st.fg }; });
    return { pending, hasPending: pending.length > 0, summary: this.n(bars.length) + ' از ' + this.n(S.db.companies.length) + ' شرکت در مقایسه حضور دارند', ind: S.cmpInd, onInd:`);
  swap('فضای کاری ارزیاب<\\u002Fdiv>\\n            <div style=\\"font-size:clamp(22px,2.4vw,28px);font-weight:700\\">مقایسه', 'فضای کاری مدیر سامانه · {{ cv.summary }}</div>\n            <div style="font-size:clamp(22px,2.4vw,28px);font-weight:700">مقایسه');
  swap('رتبه‌بندی رسمی فقط برای ارزیابی‌های نهایی‌شده است؛', 'مقایسه‌ی یکپارچه‌ی همه‌ی شرکت‌ها برای درک وضعیت آمادگی. رتبه‌بندی رسمی فقط برای ارزیابی‌های نهایی‌شده است؛');
  swap('<!-- ADMIN -->', `<sc-if value="{{ sOCompare }}"><sc-if value="{{ cv.hasPending }}"><div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 1px 2px rgba(16,24,40,.06)">
    <div style="padding:14px 18px;border-bottom:1px solid #eef0f2;font-size:15px;font-weight:700">شرکت‌هایی که هنوز در مقایسه نیستند</div>
    <div style="padding:6px 18px;display:flex;flex-direction:column"><sc-for list="{{ cv.pending }}" as="p"><div style="display:flex;align-items:center;gap:12px;padding:9px 0;border-top:1px solid #f3f4f6"><span style="flex:1;font-size:13.5px">{{ p.name }}</span><span style="font-size:12px;color:#6b7280">{{ p.sector }}</span><span style="font-size:12px;border-radius:999px;padding:2px 10px;background:{{ p.bg }};color:{{ p.fg }}">{{ p.status }}</span></div></sc-for></div>
  </div></sc-if></sc-if><!-- ADMIN -->`);
  // Evidence upload / download go through the server (validated, stored outside the web root, access-controlled).
  swap("const id = 'u' + Date.now() + Math.random().toString(36).slice(2, 7); this.blobs[id] = f; good.push({ id, name: f.name, size: f.size, at: new Date().toISOString() });",
    "try { const up = await fetch('/api/files', { method: 'POST', headers: { 'X-Assessment': aid, 'X-Question': qid, 'X-Name': encodeURIComponent(f.name) }, body: f }); if (up.ok) good.push(await up.json()); else { let m = 'بارگذاری «' + f.name + '» ناموفق بود'; try { m = (await up.json()).error || m; } catch (e2) {} errs.push(m); } } catch (e3) { errs.push('ارتباط با سرور برقرار نیست'); }");
  swap('const blob = this.blobs[f.id];', 'const blob = f.sample ? null : (this.blobs[f.id] || null); if (!blob && !f.sample) { this.downloadServer(f); return; }');
  swap("onReset: () => this.toast('رمز «' + u.username + '» به Demo@1234 بازنشانی شد', 'info'),",
    "onReset: () => fetch('/api/users/' + encodeURIComponent(u.username) + '/reset-password', { method: 'POST' }).then(r => this.toast(r.ok ? 'رمز «' + u.username + '» به ' + '" + DEFAULT_PW + "' + ' بازنشانی شد' : 'بازنشانی رمز ممکن نشد', r.ok ? 'info' : 'err')),");
  swap('this.setState({ db: this.seed(), modal: null });',
    "fetch('/api/reset', { method: 'POST' }).then(r => { if (r.ok) this.setState({ db: this.freshDb(), modal: null }); else this.toast('بازنشانی ممکن نشد', 'err'); });");
  return html;
}

// ---------- HTTP ----------
const readJson = async req => {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > 30e6) throw bad('درخواست بسیار بزرگ است', 413); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw bad('JSON نامعتبر است'); }
};

async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://x');
  const send = (code, body, extra = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra }); res.end(JSON.stringify(body)); };

  if (req.method === 'GET' && pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
    return res.end(page);
  }
  if (!pathname.startsWith('/api/')) return res.writeHead(404).end('Not found');

  // CSRF: browsers always send Origin on cross-site writes; refuse any that is not this host.
  if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(403, { error: 'درخواست نامعتبر است' });

  if (pathname === '/api/login' && req.method === 'POST') {
    const ip = req.socket.remoteAddress, at = attempts.get(ip) || { n: 0, until: 0 };
    if (at.until > Date.now()) return send(429, { error: 'تلاش‌های ناموفق زیاد بود؛ یک دقیقه صبر کنید' });
    const { username, password } = await readJson(req);
    if (typeof username !== 'string' || typeof password !== 'string' || !checkPassword(username, password) || !principalOf(username)) {
      at.n++; if (at.n >= 8) { at.n = 0; at.until = Date.now() + 60000; } attempts.set(ip, at);
      return send(401, { error: 'نام کاربری یا رمز عبور نادرست است' });
    }
    attempts.delete(ip);
    const p = principalOf(username);
    if (p.role !== 'ADMIN' && stateEmpty()) return send(403, { error: 'سامانه هنوز راه‌اندازی نشده است' });
    return send(200, { username, role: p.role }, { 'Set-Cookie': `sid=${newSession(username)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
  }
  if (pathname === '/api/logout' && req.method === 'POST') {
    const sid = cookieOf(req).sid;
    if (sid) db.prepare('DELETE FROM sessions WHERE sid_hash = ?').run(sha(sid));
    return send(200, {}, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }

  const p = sessionPrincipal(req);
  if (!p) return send(401, { error: 'ابتدا وارد شوید' });

  if (pathname === '/api/me' && req.method === 'GET') return send(200, { username: p.username, role: p.role });

  if (pathname === '/api/password' && req.method === 'POST') {
    const { oldPassword, newPassword } = await readJson(req);
    if (typeof newPassword !== 'string' || newPassword.length < 8) return send(400, { error: 'رمز جدید باید حداقل ۸ نویسه باشد' });
    if (typeof oldPassword !== 'string' || !checkPassword(p.username, oldPassword)) return send(403, { error: 'رمز فعلی نادرست است' });
    setPassword(p.username, newPassword);
    // End every other session of this user.
    const sid = cookieOf(req).sid;
    db.prepare('DELETE FROM sessions WHERE username = ? AND sid_hash <> ?').run(p.username, sha(sid));
    return send(200, {});
  }

  if (pathname === '/api/db' && req.method === 'GET') {
    const st = load();
    if (!st) return res.writeHead(204).end();
    return send(200, viewFor(p, st));
  }
  if (pathname === '/api/db' && req.method === 'PUT') {
    const next = applyWrite(p, await readJson(req));
    if (next) { save(next); dropOrphanFiles(); }
    return res.writeHead(204).end();
  }

  if (pathname === '/api/reset' && req.method === 'POST') {
    if (p.role !== 'ADMIN') return send(403, { error: 'فقط مدیر سامانه' });
    db.exec('DELETE FROM companies; DELETE FROM users; DELETE FROM assessments; DELETE FROM files;');
    for (const f of fs.readdirSync(UPLOAD_DIR)) fs.rmSync(path.join(UPLOAD_DIR, f), { force: true });
    return res.writeHead(204).end();
  }

  const reset = pathname.match(/^\/api\/users\/([^/]+)\/reset-password$/);
  if (reset && req.method === 'POST') {
    if (p.role !== 'ADMIN') return send(403, { error: 'فقط مدیر سامانه' });
    const name = decodeURIComponent(reset[1]);
    if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) return send(404, { error: 'کاربر پیدا نشد' });
    setPassword(name, DEFAULT_PW);
    db.prepare('DELETE FROM sessions WHERE username = ?').run(name);
    return send(200, {});
  }

  if (pathname === '/api/files' && req.method === 'POST') {
    if (p.role !== 'ASSESSEE') return send(403, { error: 'فقط ارزیابی‌شونده می‌تواند مدرک بارگذاری کند' });
    const aid = String(req.headers['x-assessment'] || ''), qid = String(req.headers['x-question'] || '');
    let name; try { name = decodeURIComponent(String(req.headers['x-name'] || '')); } catch { name = ''; }
    name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 200);
    const A = db.prepare('SELECT * FROM assessments WHERE id = ?').get(aid);
    if (!A || A.company_id !== p.companyId) return send(403, { error: 'دسترسی مجاز نیست' });
    if (A.status !== 'DRAFT') return send(409, { error: 'ارزیابی ارسال شده و قابل ویرایش نیست' });
    if (!QIDS.has(qid)) return send(400, { error: 'بند نامعتبر است' });
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (!name || !ALLOWED_EXT.includes(ext)) return send(400, { error: 'قالب فایل مجاز نیست. قالب‌های مجاز: pdf، doc، docx، jpg، jpeg، mp4، zip' });
    if (Number(req.headers['content-length'] || 0) > MAX_FILE) return send(413, { error: 'حجم فایل از ۵۰ مگابایت بیشتر است' });
    if (db.prepare('SELECT COUNT(*) AS n FROM files WHERE assessment_id = ? AND question_id = ?').get(aid, qid).n >= 10) return send(400, { error: 'حداکثر ۱۰ فایل برای هر بند مجاز است' });
    const body = await readBuffer(req, MAX_FILE);
    if (!body.length) return send(400, { error: 'فایل خالی است' });
    if (!magicOk(ext, body.subarray(0, 12))) return send(400, { error: 'محتوای فایل با پسوند آن همخوانی ندارد' });
    const id = 'f' + crypto.randomBytes(8).toString('hex'), stored = crypto.randomBytes(24).toString('hex'), at = iso();
    fs.writeFileSync(path.join(UPLOAD_DIR, stored), body);
    db.prepare('INSERT INTO files VALUES (?,?,?,?,?,?,?,?)').run(id, aid, qid, name, body.length, stored, p.username, at);
    return send(200, { id, name, size: body.length, at });
  }
  const dl = pathname.match(/^\/api\/files\/([\w-]+)$/);
  if (dl && req.method === 'GET') {
    const f = db.prepare('SELECT * FROM files WHERE id = ?').get(dl[1]);
    const A = f && db.prepare('SELECT * FROM assessments WHERE id = ?').get(f.assessment_id);
    if (!f || !A || !canReadAssessment(p, A)) return send(404, { error: 'فایل پیدا نشد' });
    const view = new URL(req.url, 'http://x').searchParams.get('view') === '1';
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (p.role === 'ASSESSOR' && !view) return send(403, { error: 'ارزیاب فقط می‌تواند فایل را مشاهده کند؛ دانلود مجاز نیست' });
    const file = path.join(UPLOAD_DIR, f.stored_name);
    if (!view) {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream', 'Content-Length': f.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`
      });
      return fs.createReadStream(file).pipe(res);
    }
    // inline view: only types a browser can show safely (content already verified by magic bytes at upload)
    const type = VIEW_TYPES[ext];
    if (!type) return send(415, { error: 'پیش‌نمایش این نوع فایل ممکن نیست' });
    if (VIEW_BY_FETCH.includes(ext) && req.headers['x-viewer'] !== '1') return send(400, { error: 'این فایل فقط از داخل سامانه قابل مشاهده است' });
    const head = { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN',
      'Accept-Ranges': 'bytes' };
    // no Content-Disposition on pdf/docx: Chrome turns such a fetch() into an empty 204 (treated as a download)
    if (!VIEW_BY_FETCH.includes(ext)) head['Content-Disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`;
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '')); // lets videos seek
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : f.size - Number(m[2]), end = m[1] && m[2] ? Number(m[2]) : f.size - 1;
      end = Math.min(end, f.size - 1);
      if (!(start >= 0 && start <= end)) { res.writeHead(416, { 'Content-Range': `bytes */${f.size}` }); return res.end(); }
      res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${f.size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...head, 'Content-Length': f.size });
    return fs.createReadStream(file).pipe(res);
  }

  return send(404, { error: 'پیدا نشد' });
}

let page;
(async () => {
  const code = bundleAsset('435712ec-76cb-45de-b1f1-56cd1a06843f');
  SC = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  page = buildPage();
  http.createServer((req, res) => {
    handle(req, res).catch(e => {
      if (e.status && e.status < 500) { if (!res.headersSent) res.writeHead(e.status, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
      console.error(e);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'خطای داخلی سرور' }));
    });
  }).listen(PORT, () => console.log('http://localhost:' + PORT));
})();
