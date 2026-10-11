// Tests for the pilot (SMS experiment) logic in docs/index.html.
// Run: node --test tests/
// The pure functions live in one block of index.html between the PILOT-CORE markers;
// this file extracts that block and evaluates it, so the app stays a single file.
// All data here is synthetic (fake names, 0912000xxxx-style numbers).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const m = html.match(/\/\* PILOT-CORE START \*\/([\s\S]*?)\/\* PILOT-CORE END \*\//);
assert.ok(m, 'PILOT-CORE block not found in docs/index.html');
const PC = new Function(m[1] + '\nreturn PC;')();

// ---------- synthetic fixtures ----------
const T0 = 1760000000000; // fixed timestamp
const CSV_HEAD = 'ردیف,نام مشتری,آخرین مراجعه (شمسی),آخرین مراجعه (میلادی),تعداد مراجعه,خدمت آخر,میانگین فاکتور (تومان),شماره تلفن,منبع شماره,نوبت از پیش گرفته؟,یادداشت بازبینی';
const SAMPLE_CSV = CSV_HEAD + '\n' +
  '1,نمونه یک,1405/05/17,2026-08-08,1,ترمیم,500000,,,,\n' +
  '2,نمونه دو,1405/05/31,2026-08-22,4,لاک ژل + پدیکور,415000,09120000000,گوشی,نه,\n';

// a list of n fake people, last visit spread so everybody is in the 45..90 window on DRAW_DAY
const DRAW_DAY = '2026-10-11';
function fakeRows(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const gap = 45 + (i * 7) % 46; // 45..90
    rows.push([i + 1, 'مشتری ساختگی ' + (i + 1), '', PC.addDaysIso(DRAW_DAY, -gap), 1 + (i % 3), 'پدیکور', 400000,
      '0912000' + String(i).padStart(4, '0'), 'گوشی', '', ''].join(','));
  }
  return CSV_HEAD + '\n' + rows.join('\n');
}
function lockedPilot(n, today = '2026-09-01') {
  const p = PC.newPilot(today, T0);
  const r = PC.readList(fakeRows(n));
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  PC.mergeImport(p, r.people, today, T0);
  PC.lockList(p, T0);
  return p;
}

// ---------- 1. Jalali -> Gregorian ----------
test('1. jalali to gregorian (incl. leap years and 1 Farvardin)', () => {
  const cases = [
    [1405, 1, 1, '2026-03-21'],
    [1404, 12, 29, '2026-03-20'],
    [1403, 12, 30, '2025-03-20'], // 1403 is a leap year
    [1404, 1, 1, '2025-03-21'],
    [1399, 12, 30, '2021-03-20'], // 1399 is a leap year
    [1400, 1, 1, '2021-03-21'],
    [1403, 1, 1, '2024-03-20'],
    [1405, 5, 17, '2026-08-08'],
    [1405, 5, 31, '2026-08-22'],
    [1405, 7, 19, '2026-10-11'],
  ];
  for (const [y, mo, d, iso] of cases) assert.equal(PC.jalaliToIso(y, mo, d), iso, `${y}/${mo}/${d}`);
  assert.equal(PC.jalaliToIso(1404, 12, 30), '', '1404 is not a leap year');
  assert.equal(PC.jalaliToIso(1405, 7, 31), '', 'Mehr has 30 days');
  assert.equal(PC.jalaliToIso(1405, 13, 1), '');
  // cross-check every day of 1395..1415 against the platform calendar
  const f = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {year: 'numeric', month: 'numeric', day: 'numeric'});
  let d = new Date(Date.UTC(2016, 2, 1, 12));
  for (let i = 0; i < 365 * 21; i++, d = new Date(d.getTime() + 864e5)) {
    const p = f.formatToParts(d), g = t => Number(p.find(x => x.type === t).value.replace(/\D/g, ''));
    assert.equal(PC.jalaliToIso(g('year'), g('month'), g('day')), d.toISOString().slice(0, 10));
  }
});

test('1b. parseDate accepts ISO and Shamsi, Persian digits too', () => {
  assert.equal(PC.parseDate('2026-08-08'), '2026-08-08');
  assert.equal(PC.parseDate('1405/05/17'), '2026-08-08');
  assert.equal(PC.parseDate('۱۴۰۵/۰۵/۱۷'), '2026-08-08');
  assert.equal(PC.parseDate('1405-5-17'), '2026-08-08');
  assert.equal(PC.parseDate('2026/8/8'), '2026-08-08');
  assert.equal(PC.parseDate(' 2026-08-08 '), '2026-08-08');
  assert.equal(PC.parseDate('2026-02-30'), '');
  assert.equal(PC.parseDate('دیروز'), '');
  assert.equal(PC.parseDate(''), '');
});

// ---------- 2. phone normalisation ----------
test('2. phone normalisation', () => {
  const want = '09120000000';
  for (const s of ['09120000000', '+989120000000', '00989120000000', '989120000000', '9120000000',
    '۰۹۱۲۰۰۰۰۰۰۰', '٠٩١٢٠٠٠٠٠٠٠', '0912 000 0000', ' +98 912-000-0000 ', '(0912) 000 0000', '+۹۸۹۱۲۰۰۰۰۰۰۰'])
    assert.equal(PC.normCustomer(s), want, s);
  assert.equal(PC.normPhone('912000000'), '', 'too short is not a mobile');
  assert.equal(PC.normPhone('02188000000'), '', 'landline is not a mobile for SMS');
  assert.equal(PC.normPhone('9120000000'), want, 'Excel dropped the leading zero');
  assert.equal(PC.normPhone(''), '');
});

// ---------- 3. eligibility ----------
test('3. eligibility: 44/45/90/91 boundaries and every exclusion rule', () => {
  const base = {key: 'k', name: 'الف', phone: '09120000001', phoneSrc: 'phone', visits: 1, lastVisit: '2026-07-01', future: false, noMsg: false};
  const ctx = {bookings: [], drawn: new Set(), listDate: '2026-09-01'};
  const on = n => PC.addDaysIso(base.lastVisit, n);
  assert.deepEqual(PC.eligibility(base, on(44), ctx), {ok: false, reason: 'window'});
  assert.deepEqual(PC.eligibility(base, on(45), ctx), {ok: true, reason: ''});
  assert.deepEqual(PC.eligibility(base, on(90), ctx), {ok: true, reason: ''});
  assert.deepEqual(PC.eligibility(base, on(91), ctx), {ok: false, reason: 'window'});
  const D = on(60);
  const why = (p, c = ctx) => PC.eligibility(Object.assign({}, base, p), D, c).reason;
  assert.equal(why({phone: ''}), 'nophone');
  assert.equal(why({phone: '', phoneSrc: 'none'}), 'notfound');
  assert.equal(why({phoneSrc: 'none'}), 'notfound');
  assert.equal(why({future: true}), 'future');
  assert.equal(why({noMsg: true}), 'nomsg');
  assert.equal(why({}, Object.assign({}, ctx, {drawn: new Set(['k'])})), 'drawn');
  // came after the list was built (re-import moved last visit past the list date)
  assert.equal(why({lastVisit: '2026-09-05'}), 'came');
  // the app shows a later visit or a booking for this phone
  const bk = (date, status) => ({customer: '09120000001', date, status});
  assert.equal(why({}, Object.assign({}, ctx, {bookings: [bk(on(10), 'done')]})), 'recent');
  assert.equal(why({}, Object.assign({}, ctx, {bookings: [bk(on(70), 'booked')]})), 'recent');
  assert.equal(why({}, Object.assign({}, ctx, {bookings: [bk(on(10), 'cancel')]})), '', 'a cancelled booking does not count');
  assert.equal(why({}, Object.assign({}, ctx, {bookings: [bk(base.lastVisit, 'done')]})), '', 'the listed visit itself does not count');
  assert.equal(why({}, Object.assign({}, ctx, {bookings: [{customer: '09120000009', date: on(10), status: 'done'}]})), '');
});

// ---------- 4. stratum on the draw day ----------
test('4. stratum is taken on the draw day and can change between days', () => {
  const p = {visits: 1, lastVisit: '2026-07-01'};
  assert.equal(PC.stratumOf(p, PC.addDaysIso(p.lastVisit, 59)), 'v1_d45');
  assert.equal(PC.stratumOf(p, PC.addDaysIso(p.lastVisit, 60)), 'v1_d60');
  assert.equal(PC.stratumOf(Object.assign({}, p, {visits: 2}), PC.addDaysIso(p.lastVisit, 45)), 'v2_d45');
  assert.equal(PC.stratumOf(Object.assign({}, p, {visits: 7}), PC.addDaysIso(p.lastVisit, 90)), 'v2_d60');
  assert.deepEqual(PC.STRATA, ['v1_d45', 'v1_d60', 'v2_d45', 'v2_d60']);
});

// ---------- 5 + 6. reproducibility and balance ----------
const elig = n => Array.from({length: n}, (_, i) => ({key: 'p' + String(i).padStart(3, '0'), stratum: PC.STRATA[i % 4]}));
test('5. same input + seed gives the same allocation; another seed differs', () => {
  const a = PC.drawBatch(elig(150), 123456, 40), b = PC.drawBatch(elig(150).reverse(), 123456, 40);
  assert.deepEqual(a, b, 'input order must not matter (keys are sorted first)');
  const c = PC.drawBatch(elig(150), 654321, 40);
  assert.notDeepEqual(a.map(x => x.key + x.arm), c.map(x => x.key + x.arm));
  assert.equal(a.length, 40);
  // mulberry32 is deterministic and in [0,1)
  const r1 = PC.mulberry32(42), r2 = PC.mulberry32(42);
  for (let i = 0; i < 100; i++) { const v = r1(); assert.equal(v, r2()); assert.ok(v >= 0 && v < 1) }
  // whole pilot draw is reproducible from the stored record
  const p = lockedPilot(120);
  const d = PC.commitDraw(p, DRAW_DAY, 777777, [], T0);
  assert.equal(d.inputHash, PC.fnv1a(d.eligible.map(x => x.key + '|' + x.stratum).join('\n')));
  assert.deepEqual(PC.drawBatch(d.eligible, d.seed, d.n), d.picked);
});

test('6. balance: |message - control| <= 1 in every stratum', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const n = 5 + (seed % 60), out = PC.drawBatch(elig(7 + seed % 90), seed * 7919, n);
    for (const s of PC.STRATA) {
      const g = out.filter(x => x.stratum === s);
      const msg = g.filter(x => x.arm === 'message').length, ctl = g.filter(x => x.arm === 'control').length;
      assert.ok(Math.abs(msg - ctl) <= 1, `seed ${seed} stratum ${s}: ${msg}/${ctl}`);
    }
    assert.equal(new Set(out.map(x => x.key)).size, out.length, 'nobody twice');
  }
  // smaller batch than requested is allowed
  assert.equal(PC.drawBatch(elig(9), 5, 40).length, 9);
  assert.equal(PC.drawBatch([], 5, 40).length, 0);
});

test('6b. one draw per day, only after lock, and never the same person twice', () => {
  const p = PC.newPilot('2026-09-01', T0);
  PC.mergeImport(p, PC.readList(fakeRows(60)).people, '2026-09-01', T0);
  assert.throws(() => PC.commitDraw(p, DRAW_DAY, 1, [], T0), /lock/);
  PC.lockList(p, T0);
  const d1 = PC.commitDraw(p, DRAW_DAY, 1, [], T0);
  assert.throws(() => PC.commitDraw(p, DRAW_DAY, 2, [], T0), /today/);
  const d2 = PC.commitDraw(p, PC.addDaysIso(DRAW_DAY, 1), 2, [], T0);
  const k1 = new Set(d1.picked.map(x => x.key));
  assert.ok(d2.picked.every(x => !k1.has(x.key)));
});

// ---------- 7. no control member on Mojgan's screen ----------
test('7. today view holds message arm only (I1)', () => {
  const p = lockedPilot(120);
  p.settings.salon = 'سالن ساختگی';
  const d = PC.commitDraw(p, DRAW_DAY, 31337, [], T0);
  const v = PC.todayView(p, DRAW_DAY);
  const ctl = d.picked.filter(x => x.arm === 'control').map(x => p.people[x.key]);
  const json = JSON.stringify(v);
  assert.ok(ctl.length > 0);
  for (const c of ctl) { assert.ok(!json.includes(c.name), 'control name leaked'); assert.ok(!json.includes(c.phone), 'control phone leaked'); assert.ok(!json.includes(c.key)) }
  assert.equal(v.controlCount, ctl.length);
  assert.equal(v.items.length, d.picked.length - ctl.length);
  assert.ok(v.items.every(it => it.text.includes('سالن ساختگی')));
  assert.deepEqual(PC.todayView(p, '2030-01-01'), {date: '2030-01-01', items: [], controlCount: 0, sent: 0, total: 0});
  // sending to a control key is refused
  assert.throws(() => PC.recordSent(p, ctl[0].key, T0), /message/);
});

test('7b. message text, first name, first service, sms links', () => {
  const t = PC.fillTemplate(PC.DEFAULT_TEMPLATE, {name: 'نمونه دو', service: 'لاک ژل + پدیکور', salon: 'آینه'});
  assert.ok(t.startsWith('سلام نمونه جان، مژگان هستم از سالن آینه. از آخرین لاک ژلت '), t);
  assert.equal(PC.firstName('خانم نمونه دو'), 'نمونه');
  assert.equal(PC.firstService('ترمیم'), 'ترمیم');
  assert.equal(PC.firstService('ژل، پدیکور'), 'ژل');
  assert.equal(PC.smsHref('09120000000', 'سلام & بله?', false), 'sms:09120000000?body=' + encodeURIComponent('سلام & بله?'));
  assert.equal(PC.smsHref('09120000000', 'a', true), 'sms:09120000000&body=a');
});

// ---------- 8. drawn rows are permanent (I4) ----------
test('8. a drawn row is never removed or changed by re-import or labels', () => {
  const p = lockedPilot(60);
  const d = PC.commitDraw(p, DRAW_DAY, 4242, [], T0);
  const k = d.picked[0].key, before = JSON.stringify(p.people[k]);
  // re-import a list that no longer has this person, and one with a changed last visit
  const rows = PC.readList(fakeRows(60)).people.map(r => Object.assign(r, {lastVisit: '2026-10-01'}));
  const s = PC.mergeImport(p, rows.filter(r => r.key !== k), '2026-10-12', T0);
  assert.equal(JSON.stringify(p.people[k]), before);
  assert.ok(s.skippedDrawn >= d.picked.length - 1);
  // re-import that includes the drawn person: still untouched
  PC.mergeImport(p, rows, '2026-10-12', T0);
  assert.equal(JSON.stringify(p.people[k]), before);
  // "do not message" is only a label
  PC.setNoMsg(p, k, true, T0);
  assert.ok(p.people[k] && p.people[k].noMsg);
  assert.deepEqual(p.draws[0].picked, d.picked);
  assert.equal(PC.removePerson(p, k), false);
  assert.ok(p.people[k]);
  // phone edits are closed after lock
  assert.throws(() => PC.setPhone(p, k, {phone: '09129999999'}, T0), /lock/);
});

// ---------- 9. re-import merge ----------
test('9. re-import keeps phones and flags entered in the app', () => {
  const p = PC.newPilot('2026-09-01', T0);
  const r1 = PC.readList(SAMPLE_CSV);
  assert.equal(r1.errors.length, 0);
  const s1 = PC.mergeImport(p, r1.people, '2026-09-01', T0);
  assert.deepEqual([s1.total, s1.added, s1.withPhone, s1.withNote], [2, 2, 1, 0]);
  const k1 = PC.normName('نمونه یک');
  PC.setPhone(p, k1, {phone: '+98 912 000 0001', phoneSrc: 'book', future: true}, T0);
  assert.equal(p.people[k1].phone, '09120000001');
  // same people, new last visit, empty phone column; plus one new person
  const csv2 = SAMPLE_CSV.replace('1405/05/17,2026-08-08', '1405/06/01,2026-08-23') + '3,نمونه سه,1405/04/01,2026-06-22,2,پدیکور,300000,,,,بررسی شود\n';
  const s2 = PC.mergeImport(p, PC.readList(csv2).people, '2026-09-02', T0);
  assert.equal(p.people[k1].phone, '09120000001');
  assert.equal(p.people[k1].phoneSrc, 'book');
  assert.equal(p.people[k1].future, true);
  assert.equal(p.people[k1].lastVisit, '2026-08-23');
  assert.equal(s2.added, 1);
  assert.equal(s2.withNote, 1);
  assert.equal(s2.total, 3);
  // name keys tolerate Arabic letters and extra spaces / ZWNJ
  assert.equal(PC.normName(' نمونه  يك '), k1);
  assert.equal(PC.normName('زهرا‌سادات'), PC.normName('زهرا سادات'));
  // after lock: only last visit of undrawn people moves; nobody is added
  PC.lockList(p, T0);
  const csv3 = csv2.replace('1405/06/01,2026-08-23', '1405/06/20,2026-09-11') + '4,نمونه چهار,1405/04/01,2026-06-22,2,پدیکور,300000,09120000004,گوشی,,\n';
  const s3 = PC.mergeImport(p, PC.readList(csv3).people, '2026-09-12', T0);
  assert.equal(p.people[k1].lastVisit, '2026-09-11');
  assert.equal(p.people[PC.normName('نمونه چهار')], undefined);
  assert.equal(s3.skippedNew, 1);
});

test('9b. CSV reading: columns by name, BOM, quotes, duplicates, bad dates', () => {
  const shuffled = '﻿نام مشتری,شماره تلفن,آخرین مراجعه (شمسی),تعداد مراجعه,خدمت آخر\n"نمونه, ویرگول",912 000 0007,1405/05/17,2,"ژل ""ویژه"""\n';
  const r = PC.readList(shuffled);
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.deepEqual([r.people[0].name, r.people[0].phone, r.people[0].lastVisit, r.people[0].visits, r.people[0].lastSvc],
    ['نمونه, ویرگول', '09120000007', '2026-08-08', 2, 'ژل "ویژه"']);
  const dup = PC.readList(SAMPLE_CSV + '3,نمونه يك,1405/05/17,,1,ترمیم,,,,,\n');
  assert.equal(dup.dupes.length, 1);
  const bad = PC.readList(CSV_HEAD + '\n1,بی‌تاریخ,فردا,,1,ژل,,,,,\n');
  assert.equal(bad.errors.length, 1);
  assert.ok(PC.readList('a,b\n1,2').missing.length > 0, 'missing required columns are reported');
  assert.equal(PC.readList(SAMPLE_CSV).people[1].phoneSrc, 'phone');
  assert.equal(PC.readList(SAMPLE_CSV).people[1].future, false);
});

// ---------- 10. linking returns and 30/60-day outcomes ----------
test('10. returns link by phone; 30/60-day windows; open window is blank', () => {
  const p = lockedPilot(80);
  const d = PC.commitDraw(p, DRAW_DAY, 99, [], T0);
  const msg = p.people[d.picked.find(x => x.arm === 'message').key];
  const ctl = p.people[d.picked.find(x => x.arm === 'control').key];
  const B = (c, off, status, amount) => ({customer: c.phone, date: PC.addDaysIso(DRAW_DAY, off), status, amount});
  const bookings = [B(msg, -3, 'done', 999), B(msg, 0, 'done', 100000), B(msg, 29, 'done', 200000), B(msg, 30, 'done', 400000),
    B(msg, 59, 'done', 1000000), B(msg, 60, 'done', 5), B(msg, 10, 'cancel', 7), B(msg, 12, 'booked', 8), B(ctl, 5, 'done', 300000)];
  // badge only on the message arm, from the draw day on
  assert.equal(PC.badgeFor(p, bookings[1]), true);
  assert.equal(PC.badgeFor(p, bookings[0]), false, 'before the draw');
  assert.equal(PC.badgeFor(p, bookings[8]), false, 'control arm gets no badge');
  assert.equal(PC.badgeFor(p, {customer: '09129999999', date: DRAW_DAY, status: 'done'}), false);
  // windows still open
  let o = PC.outcomes(msg, DRAW_DAY, bookings, PC.addDaysIso(DRAW_DAY, 29));
  assert.deepEqual(o, {n30: null, amount30: null, profit30: null, n60: null, amount60: null, profit60: null});
  o = PC.outcomes(msg, DRAW_DAY, bookings, PC.addDaysIso(DRAW_DAY, 30));
  assert.deepEqual([o.n30, o.amount30, o.profit30, o.n60], [2, 300000, 165750, null]);
  o = PC.outcomes(msg, DRAW_DAY, bookings, PC.addDaysIso(DRAW_DAY, 60));
  assert.deepEqual([o.n60, o.amount60, o.profit60], [4, 1700000, 939250]);
  assert.deepEqual(PC.outcomes(ctl, DRAW_DAY, bookings, '2027-01-01').amount30, 300000);
});

// ---------- 11. migration / restore keeps every booking (I6) ----------
test('11. an old (pre-pilot) backup restores intact and does not wipe pilot data', () => {
  const old = JSON.parse(readFileSync(new URL('./fixtures/backup-v1.json', import.meta.url), 'utf8'));
  assert.equal(old.pilot, undefined);
  const DEF = {services: [], dayStart: '07:00', dayEnd: '21:00', sharePct: 65};
  // fresh phone, no pilot
  let s = PC.restoreState(null, old, DEF);
  assert.equal(s.bookings.length, old.bookings.length);
  assert.deepEqual(s.bookings.map(b => b.id), old.bookings.map(b => b.id));
  assert.deepEqual(s.customers, old.customers);
  assert.equal(s.pilot, undefined, 'no pilot appears by itself');
  // phone already running the pilot: restoring an old backup keeps the pilot
  const cur = {v: 1, bookings: [], customers: {}, settings: DEF, pilot: lockedPilot(10)};
  s = PC.restoreState(cur, old, DEF);
  assert.equal(s.bookings.length, old.bookings.length);
  assert.deepEqual(s.pilot, cur.pilot);
  // a backup that has a pilot brings its own
  const withPilot = Object.assign({}, old, {pilot: lockedPilot(5)});
  assert.deepEqual(PC.restoreState(cur, JSON.parse(JSON.stringify(withPilot)), DEF).pilot, withPilot.pilot);
  // amounts lock their share %
  assert.ok(s.bookings.filter(b => b.amount).every(b => b.pct != null));
});

// ---------- 12. CSV exports ----------
test('12. pilot CSV columns, order and values; log CSV', () => {
  assert.deepEqual(PC.PILOT_COLS, ['name', 'phone', 'visits_before', 'last_visit_before', 'stratum', 'arm', 'batch_date', 'seed',
    'sent_at', 'delivered', 'reply', 'reply_at', 'opt_out', 'n_done_30', 'amount_30', 'profit_30', 'n_done_60', 'amount_60', 'profit_60']);
  const p = lockedPilot(40);
  const d = PC.commitDraw(p, DRAW_DAY, 2024, [], T0);
  const m1 = d.picked.find(x => x.arm === 'message');
  PC.recordOpen(p, m1.key, T0 + 1000);
  PC.recordSent(p, m1.key, Date.UTC(2026, 9, 11, 7, 0, 0));
  PC.recordReply(p, m1.key, 'stop', Date.UTC(2026, 9, 11, 9, 0, 0));
  PC.recordReply(p, m1.key, 'booked', Date.UTC(2026, 9, 11, 9, 5, 0)); // correction keeps history
  assert.equal(p.sends[m1.key].history.length, 3);
  const person = p.people[m1.key];
  const bookings = [{customer: person.phone, date: PC.addDaysIso(DRAW_DAY, 3), status: 'done', amount: 415000}];
  const text = PC.pilotCsv(p, bookings, PC.addDaysIso(DRAW_DAY, 40));
  const lines = text.split('\n');
  assert.equal(lines[0], PC.PILOT_COLS.join(','));
  assert.equal(lines.length, 1 + d.picked.length);
  const row = PC.parseCsv(text).find(r => r[0] === person.name);
  const o = Object.fromEntries(PC.PILOT_COLS.map((c, i) => [c, row[i]]));
  assert.deepEqual(o, {name: person.name, phone: person.phone, visits_before: String(person.visits), last_visit_before: person.lastVisit,
    stratum: m1.stratum, arm: 'message', batch_date: DRAW_DAY, seed: '2024', sent_at: '2026-10-11T07:00:00.000Z', delivered: 'yes',
    reply: 'booked', reply_at: '2026-10-11T09:05:00.000Z', opt_out: '0', n_done_30: '1', amount_30: '415000', profit_30: '229287.5',
    n_done_60: '', amount_60: '', profit_60: ''});
  // control rows: never sent
  const c1 = d.picked.find(x => x.arm === 'control');
  const crow = PC.parseCsv(text).find(r => r[0] === p.people[c1.key].name);
  assert.equal(crow[5], 'control'); assert.equal(crow[8], '');
  // log: import, lock, draw (with seed + input id + eligible list), sends, replies, correction
  const log = PC.parseCsv(PC.logCsv(p));
  assert.deepEqual(log[0], ['at', 'event', 'person', 'detail']);
  const ev = log.slice(1).map(r => r[1]);
  for (const e of ['import', 'lock', 'draw', 'open', 'sent', 'reply', 'correct']) assert.ok(ev.includes(e), e);
  const dr = JSON.parse(log.find(r => r[1] === 'draw')[3]);
  assert.equal(dr.seed, 2024); assert.equal(dr.inputHash, d.inputHash); assert.equal(dr.eligible.length, d.eligible.length);
});

test('12b. a sent mark is corrected, never deleted (I2)', () => {
  const p = lockedPilot(40);
  const d = PC.commitDraw(p, DRAW_DAY, 5, [], T0);
  const k = d.picked.find(x => x.arm === 'message').key;
  PC.recordSent(p, k, T0);
  PC.recordUnsent(p, k, T0 + 5);
  assert.equal(p.sends[k].sentAt, null);
  assert.equal(p.sends[k].history.length, 2);
  assert.ok(p.log.some(e => e.event === 'correct' && e.person === k));
});
