// Unit tests: question bank invariants (PRD §5.5), scoring module against the PRD golden vectors (§6.7), completeness rule (§7.3).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BANK, SC } from '../helpers/bundle.mjs';
import { LIVE } from '../helpers/bundle.mjs';

const fx = f => JSON.parse(fs.readFileSync(path.join(LIVE, 'test', 'fixtures', f), 'utf8'));
const KIT_BANK = fx('question-bank.json');
const VECTORS = fx('scoring-test-vectors.json');
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} !== ${b} (tol ${tol})`);

describe('question bank (PRD §5.5 invariants)', () => {
  it('bundle bank is identical to the kit question-bank.json', () => assert.deepEqual(BANK, KIT_BANK));
  it('13 indicators, 108 sub-indicators, 809 questions with unique ids', () => {
    assert.equal(BANK.indicators.length, 13);
    assert.equal(BANK.sub_indicators.length, 108);
    assert.equal(BANK.questions.length, 809);
    assert.equal(new Set(BANK.questions.map(q => q.id)).size, 809);
  });
  it('every question has exactly one existing sub-indicator and sub-indicator question counts sum to 809', () => {
    const subs = new Map(BANK.sub_indicators.map(s => [s.id, s]));
    for (const q of BANK.questions) assert.ok(subs.has(q.sub_indicator_id), q.id);
    assert.equal(BANK.sub_indicators.reduce((s, x) => s + x.question_count, 0), 809);
    for (const s of BANK.sub_indicators) assert.equal(BANK.questions.filter(q => q.sub_indicator_id === s.id).length, s.question_count, s.id);
  });
  it('priority is 1..3, sum of priorities 1508, max points 4524', () => {
    assert.ok(BANK.questions.every(q => [1, 2, 3].includes(q.priority)));
    assert.equal(BANK.questions.reduce((s, q) => s + q.priority, 0), 1508);
    assert.equal(BANK.questions.reduce((s, q) => s + 3 * q.priority, 0), 4524);
  });
  it('indicator max_points equals the sum of its sub-indicators and of its questions', () => {
    for (const ind of BANK.indicators) {
      assert.equal(BANK.sub_indicators.filter(s => s.indicator_id === ind.id).reduce((s, x) => s + x.max_points, 0), ind.max_points, ind.id);
      assert.equal(BANK.questions.filter(q => q.indicator_id === ind.id).reduce((s, q) => s + 3 * q.priority, 0), ind.max_points, ind.id);
    }
  });
  it('no duplicate question text across the bank', () => {
    const texts = BANK.questions.map(q => q.text_fa.trim());
    assert.equal(new Set(texts).size, texts.length);
  });
});

// Build the decisions each golden vector describes (same rules as scripts/build_test_vectors.py in the kit).
function decisionsFor(v) {
  const r = v.rule, d = {};
  if (r.first_n) { BANK.questions.slice(0, r.first_n).forEach(q => { d[q.id] = r.decision; }); return d; }
  for (const q of BANK.questions) {
    if (r.default) d[q.id] = r.default;
    else if (r.priority_3 !== undefined) d[q.id] = q.priority === 3 ? r.priority_3 : r.otherwise;
    else if (r.decision && r.decision.startsWith('cycle')) d[q.id] = ['YES', 'CORRECTIVE', 'NO'][(q.order - 1) % 3];
    else if (r.explicit && r.explicit[q.id]) d[q.id] = r.explicit[q.id];
  }
  return d;
}

describe('scoring against PRD golden vectors (§6.7)', () => {
  for (const v of VECTORS.vectors.filter(x => x.expected)) {
    it(`vector ${v.name}: overall, 13 indicators and sub-indicators`, () => {
      const s = SC.scoreAssessment(BANK, decisionsFor(v)), e = v.expected;
      near(s.overall.points, e.overall.points);
      near(s.overall.percent, e.overall.percent, 1e-6);
      for (const [k, x] of Object.entries(e.indicators || {})) { near(s.byIndicator[k].points, x.points); near(s.byIndicator[k].percent, x.percent, 1e-6); }
      for (const [k, x] of Object.entries(e.sub_indicators || {})) near(s.bySubIndicator[k].points, x.points);
    });
  }
  const table = VECTORS.vectors.find(x => x.name === 'SINGLE_QUESTION_EXAMPLES');
  for (const row of table.table) {
    it(`single question: priority ${row.priority} + ${row.decision} = ${row.points} points`, () => {
      const q = BANK.questions.find(x => x.priority === row.priority);
      assert.equal(SC.scoreAssessment(BANK, { [q.id]: row.decision }).overall.points, row.points);
    });
  }
});

describe('scoring edge cases', () => {
  it('no decisions: 0 points, denominator stays 4524, all 809 unscored (PRD §6.4)', () => {
    const s = SC.scoreAssessment(BANK, {});
    assert.deepEqual([s.overall.points, s.overall.maxPoints, s.overall.percent, s.overall.scoredCount, s.unscoredCount], [0, 4524, 0, 0, 809]);
  });
  it('unknown question ids are ignored', () => assert.equal(SC.scoreAssessment(BANK, { NOPE: 'YES' }).overall.scoredCount, 0));
  it('critical-NO-rest-YES stays at 76.5% (PRD §6.6: not a bug)', () => {
    const d = {}; for (const q of BANK.questions) d[q.id] = q.priority === 3 ? 'NO' : 'YES';
    near(SC.scoreAssessment(BANK, d).overall.percent, 76.5, 0.05);
  });
  it('DECISION_POINTS are YES=3, CORRECTIVE=1, NO=0', () => assert.deepEqual({ ...SC.DECISION_POINTS }, { YES: 3, CORRECTIVE: 1, NO: 0 }));
  it('the scoring module does not validate decisions (NaN points) — the server must, and does (see rbac tests)', () => {
    assert.ok(Number.isNaN(SC.scoreAssessment(BANK, { A1: 'MAYBE' }).overall.points));
  });
});

describe('answer completeness (current implementation, boundaries)', () => {
  it('requires at least 20 non-blank characters of explanation', () => {
    assert.equal(SC.MIN_ANSWER_CHARS, 20);
    assert.equal(SC.isComplete({ text: 'x'.repeat(19) }), false);
    assert.equal(SC.isComplete({ text: 'x'.repeat(20) }), true);
    assert.equal(SC.isComplete({ text: ' '.repeat(40) }), false);
  });
  it('empty / missing responses are incomplete', () => {
    for (const v of [null, undefined, {}, { text: '' }]) assert.equal(SC.isComplete(v), false);
  });
  // PRD §7.3: complete(q) = answer != null AND (answer == NO OR evidence_count >= 1). Not implemented yet -> reported as TODO, not as failure.
  it('PRD §7.3: an explanation without an answer choice is NOT complete', { todo: 'known deviation from PRD §7.3 (needs product decision before changing)' }, () => {
    assert.equal(SC.isComplete({ text: 'x'.repeat(30) }, 1), false);
  });
  it('PRD §7.3: YES/PARTIAL without evidence is NOT complete', { todo: 'known deviation from PRD §7.3 (needs product decision before changing)' }, () => {
    assert.equal(SC.isComplete({ answer: 'YES', text: 'x'.repeat(30) }, 0), false);
  });
});
