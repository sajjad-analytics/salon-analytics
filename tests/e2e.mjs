// End-to-end check of the pilot module in a real browser (Chromium via Playwright), synthetic data only.
// Run: node tests/e2e.mjs [--shots]     (--shots also writes screenshots/ at 375px, light + dark)
// Checks: old backup loads intact, full flow import → find numbers → lock → draw → send 20 → reply → export,
// no control name on Mojgan's screens, no request outside the app's own origin, no horizontal scroll.
import http from 'node:http';
import {readFileSync, existsSync, mkdirSync, statSync} from 'node:fs';
import {join, extname, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execSync} from 'node:child_process';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');
const SHOTS = process.argv.includes('--shots');
let chromium;
{ let m; try { m = await import('playwright') } catch { m = await import(join(execSync('npm root -g').toString().trim(), 'playwright', 'index.js')) }
  chromium = m.chromium || m.default.chromium }

const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json'};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = join(DOCS, p);
  if (!f.startsWith(DOCS) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end(); return }
  res.writeHead(200, {'Content-Type': TYPES[extname(f)] || 'application/octet-stream'}); res.end(readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const KEY = 'daftar-mojgan-v1';
const pad = n => String(n).padStart(2, '0');
const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const today = iso(new Date());
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d) };
const FA = '۰۱۲۳۴۵۶۷۸۹', fa = s => String(s).replace(/\d/g, d => FA[d]);

// synthetic list: 60 people, last visit 45..90 days ago, 52 with a (fake) number already
const HEAD = 'ردیف,نام مشتری,آخرین مراجعه (شمسی),آخرین مراجعه (میلادی),تعداد مراجعه,خدمت آخر,میانگین فاکتور (تومان),شماره تلفن,منبع شماره,نوبت از پیش گرفته؟,یادداشت بازبینی';
const SVCS = ['ترمیم', 'لاک ژل + پدیکور', 'پدیکور', 'ژل پا'];
const rows = [];
for (let i = 0; i < 60; i++) rows.push([i + 1, 'نمونه ' + fa(String(i + 1).padStart(3, '0')), '', daysAgo(45 + (i * 7) % 46), 1 + i % 3, SVCS[i % 4], 400000,
  i < 52 ? '912000' + String(i).padStart(4, '0') : '', i < 52 ? 'گوشی' : '', '', i % 9 === 0 ? 'اسم دوبار در دفتر' : ''].join(','));
const CSV = HEAD + '\n' + rows.join('\n') + '\n';

const browser = await chromium.launch();
const problems = [];
async function newPage(scheme = 'light') {
  const ctx = await browser.newContext({viewport: {width: 375, height: 812}, deviceScaleFactor: 2, colorScheme: scheme, serviceWorkers: 'block', acceptDownloads: true, locale: 'fa-IR'});
  const page = await ctx.newPage();
  page.on('request', r => { const u = r.url(); if (!u.startsWith(ORIGIN) && !/^(data|blob|sms):/.test(u)) problems.push('external request: ' + u) });
  page.on('pageerror', e => problems.push('page error: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/sms:|Failed to launch|scheme/i.test(m.text())) problems.push('console: ' + m.text()) });
  return page;
}
async function noHScroll(page, where) {
  const w = await page.evaluate(() => {
    const r = document.getElementById('pilotRoot'), els = [document.scrollingElement, r];
    return {vw: innerWidth, max: Math.max(...els.map(e => e ? e.scrollWidth : 0))};
  });
  if (w.max > w.vw) problems.push(`horizontal scroll on ${where}: ${w.max} > ${w.vw}`);
}
async function shot(page, name) {
  if (!SHOTS) return;
  mkdirSync(join(ROOT, 'screenshots'), {recursive: true});
  await page.evaluate(() => { document.getElementById('toast').hidden = true });
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({colorScheme: scheme});
    await page.waitForTimeout(150);
    await page.screenshot({path: join(ROOT, 'screenshots', `${name}-${scheme}.png`)});
  }
  await page.emulateMedia({colorScheme: 'light'});
}
const state = page => page.evaluate(() => window.__daftar.state());
async function back(page) { await page.click('#pilotRoot [data-pback]'); await page.waitForTimeout(80) }
// booking form: a time that may not be among today's free slots goes through «ساعت دیگر»
async function setTime(page, t) { if (await page.isHidden('#fTime')) await page.click('#fTimeOther'); await page.fill('#fTime', t) }

// ---- A. an old (pre-pilot) backup on the phone: everything still there, no pilot trace on the home screen
{
  const backup = readFileSync(join(ROOT, 'tests/fixtures/backup-v1.json'), 'utf8');
  const page = await newPage();
  await page.addInitScript(([k, v]) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem(k, v); sessionStorage.setItem('seeded', '1') } }, [KEY, backup]);
  await page.goto(ORIGIN + '/');
  const s = await state(page);
  assert.equal(s.bookings.length, JSON.parse(backup).bookings.length, 'bookings kept');
  assert.equal(s.pilot, undefined);
  assert.equal(await page.isVisible('#pilotHome'), false, 'no pilot trace before import');
  await page.click('#menuBtn');
  assert.ok(await page.isVisible('#mPilot'));
  await page.click('[data-close]');
  await shot(page, '0-home-before-import');
  console.log('A ok: old backup intact, no pilot trace');
}

// ---- B. full flow
const page = await newPage();
await page.goto(ORIGIN + '/');
// a booking in the app for a listed person after their listed visit → "recently came"
await page.evaluate(([k]) => { const s = window.__daftar.state(); s.bookings.push({id: 'e2e1', status: 'done', date: new Date().toISOString().slice(0, 10), time: '08:00', customer: '09120000003', name: '', services: ['gel'], source: 'direct', ref: '', note: '', amount: 500000, pct: 65, created: Date.now()}); localStorage.setItem(k, JSON.stringify(s)) }, [KEY]);
await page.reload();
await page.click('#menuBtn'); await page.click('#mPilot');
await shot(page, '1-admin-empty');
await page.setInputFiles('#aCsv', {name: 'list.csv', mimeType: 'text/csv', buffer: Buffer.from('﻿' + CSV)});
await page.waitForSelector('#aImpYes');
const prevTxt = await page.textContent('#pilotRoot .dayend');
assert.ok(prevTxt.includes(fa(60)) && prevTxt.includes(fa(52)) && prevTxt.includes(fa(7)), 'import preview counts: ' + prevTxt);
await page.click('#aImpYes');
assert.equal(Object.keys((await state(page)).pilot.people).length, 60);
assert.ok(await page.evaluate(k => !!localStorage.getItem(k + '-before-pilot'), KEY), 'backup copy before migration (I6)');
await back(page);
assert.ok(await page.isVisible('#pilotHome [data-pilot="find"]'), 'find card on home');
assert.equal(await page.isVisible('#pilotHome [data-pilot="msgs"]'), false);
await shot(page, '2-home-find-card');

// find numbers: open remaining, fill 7 numbers + 1 not found, save-and-next chain
await page.click('#pilotHome [data-pilot="find"]');
await noHScroll(page, 'find');
await shot(page, '3-find');
await page.click('#flist [data-person]');
await page.waitForSelector('#pPh');
await shot(page, '4-find-sheet');
for (let i = 0; i < 8; i++) {
  if (i === 7) await page.click('#pSrc [data-k="none"]');
  else await page.fill('#pPh', '+98 912 100 00' + pad(i));
  await page.click('#pSave');
  await page.waitForTimeout(60);
}
let s = await state(page);
assert.equal(Object.values(s.pilot.people).filter(x => x.phone).length, 59);
assert.equal(Object.values(s.pilot.people).filter(x => x.phoneSrc === 'none').length, 1);
assert.equal(await page.isVisible('#pPh'), false, 'chain ends when nobody is left');
await noHScroll(page, 'find (done)');
await back(page);

// admin: settings, lock (two steps), draw
await page.click('#menuBtn'); await page.click('#mPilot');
await page.fill('#aSalon', 'سالن ساختگی');
await page.click('#aSave');
await page.click('#aLock'); await page.click('#lYes');
assert.ok((await state(page)).pilot.lockedAt);
await page.click('#aDraw');
await page.fill('#dSeed', '123456');
await noHScroll(page, 'draw sheet');
await shot(page, '5-draw');
await page.click('#dGo');
s = await state(page);
const draw = s.pilot.draws[0];
assert.equal(draw.seed, 123456);
assert.ok(!draw.eligible.some(x => s.pilot.people[x.key].phone === '09120000003'), 'recent visitor not eligible');
await shot(page, '6-draw-done');
await back(page);

// Mojgan: home card → today's messages. Never a control name on screen.
const ctlNames = draw.picked.filter(x => x.arm === 'control').map(x => s.pilot.people[x.key].name);
const msgN = draw.picked.length - ctlNames.length;
const home = await page.textContent('body');
assert.ok(home.includes(`${fa(msgN)} پیام امروز`), 'home card');
await page.click('#pilotHome [data-pilot="msgs"]');
await noHScroll(page, 'messages');
await shot(page, '7-messages');
const leak = async where => { const t = await page.evaluate(() => document.body.innerText + document.body.innerHTML); for (const n of ctlNames) if (t.includes(n)) problems.push(`control name on ${where}: ${n}`) };
await leak('messages');
const href = await page.getAttribute('#pilotRoot [data-send]', 'href');
assert.ok(href.startsWith('sms:0912') && href.includes('?body=') && decodeURIComponent(href).includes('سالن ساختگی'), href);
// send every message: tap ارسال → (SMS app) → back to the app → «بله»
const setVis = v => page.evaluate(v => { Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => v}); document.dispatchEvent(new Event('visibilitychange')) }, v);
const t0 = Date.now();
let taps = 0;
for (let i = 0; i < msgN; i++) {
  await page.evaluate(() => { const a = document.querySelector('#pilotRoot [data-send]'); a.addEventListener('click', e => e.preventDefault(), {once: true}); a.click() }); taps++;
  await setVis('hidden'); await setVis('visible');
  await page.waitForSelector('#cYes');
  if (i === 0) await shot(page, '8-did-you-send');
  await page.click('#cYes'); taps++;
}
s = await state(page);
const sentTimes = draw.picked.filter(x => x.arm === 'message').map(x => (s.pilot.sends[x.key] || {}).sentAt).filter(Boolean);
assert.equal(sentTimes.length, msgN, 'every send has a time');
assert.equal(taps, msgN * 2, 'two taps per message');
await leak('messages (all sent)');
await shot(page, '9-messages-all-sent');
// reply on the first one, then correct it (history kept)
await page.click('#pilotRoot [data-reply]');
await page.click('[data-r="stop"]');
await page.click('#pilotRoot [data-reply]');
await page.click('[data-r="booked"]');
s = await state(page);
const k0 = Object.keys(s.pilot.sends).find(k => s.pilot.sends[k].reply);
assert.equal(s.pilot.sends[k0].history.length, 3);
await back(page);
assert.equal(await page.isVisible('#pilotHome [data-pilot="msgs"]'), false, 'card hides when everything is sent');
await leak('home');

// a new booking by a message-arm person shows the pilot badge (F5)
const mPhone = s.pilot.people[draw.picked.find(x => x.arm === 'message').key].phone;
const cPhone = s.pilot.people[draw.picked.find(x => x.arm === 'control').key].phone;
await page.evaluate(([k, a, b]) => { const s = window.__daftar.state(); const d = new Date().toISOString().slice(0, 10);
  s.bookings.push({id: 'e2e2', status: 'booked', date: d, time: '18:00', customer: a, name: '', services: ['ped'], source: 'direct', ref: '', note: '', amount: null, created: Date.now()});
  s.bookings.push({id: 'e2e3', status: 'booked', date: d, time: '19:00', customer: b, name: '', services: ['ped'], source: 'direct', ref: '', note: '', amount: null, created: Date.now()});
  localStorage.setItem(k, JSON.stringify(s)) }, [KEY, mPhone, cPhone]);
await page.reload();
const badges = await page.$$eval('.item', els => els.map(e => [e.dataset.id, !!e.querySelector('.pilottag')]));
assert.deepEqual(badges.filter(b => b[0] === 'e2e2' || b[0] === 'e2e3').sort(), [['e2e2', true], ['e2e3', false]]);
await noHScroll(page, 'home');

// exports go through the app's share-or-download path
await page.click('#menuBtn'); await page.click('#mPilot');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#aExp')]);
const out = readFileSync(await dl.path(), 'utf8').replace(/^﻿/, '');
assert.equal(out.split('\n')[0], 'name,phone,visits_before,last_visit_before,stratum,arm,batch_date,seed,sent_at,delivered,reply,reply_at,opt_out,n_done_30,amount_30,profit_30,n_done_60,amount_60,profit_60');
assert.equal(out.trim().split('\n').length, 1 + draw.picked.length);
const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#aLog')]);
assert.ok(readFileSync(await dl2.path(), 'utf8').includes(',draw,'));
// second draw today is refused (button gone)
assert.equal(await page.isVisible('#aDraw'), false);
await back(page);

// restoring an old backup keeps the pilot and brings back every booking
await page.click('#menuBtn');
await page.click('details summary');
const old = readFileSync(join(ROOT, 'tests/fixtures/backup-v1.json'), 'utf8');
await page.fill('#mRestore', old);
await page.click('#mDoRestore'); await page.click('#mDoRestore');
s = await state(page);
assert.equal(s.bookings.length, JSON.parse(old).bookings.length);
assert.ok(s.pilot && s.pilot.draws.length === 1, 'pilot kept after restoring an old backup');

// empty state of today's messages (a fresh pilot with no draw today)
await page.evaluate(k => { const s = window.__daftar.state(); s.pilot.draws = []; s.pilot.sends = {}; localStorage.setItem(k, JSON.stringify(s)) }, KEY);
await page.reload();
await page.click('#menuBtn');
assert.equal(await page.isVisible('#mPilotMsgs'), false);
await page.click('[data-close]');
console.log(`B ok: ${msgN} messages sent with ${taps} taps in ${((Date.now() - t0) / 1000).toFixed(1)}s (automated), ${ctlNames.length} controls never shown`);

// C. empty state screenshot of "today's messages"
{
  const p2 = await newPage();
  await p2.goto(ORIGIN + '/');
  await p2.evaluate(([k, csv]) => { const PC = window.__daftar.PC; const s = window.__daftar.state(); const t = new Date().toISOString().slice(0, 10);
    s.pilot = PC.newPilot(t, Date.now()); PC.mergeImport(s.pilot, PC.readList(csv).people, t, Date.now()); PC.lockList(s.pilot, Date.now());
    localStorage.setItem(k, JSON.stringify(s)) }, [KEY, CSV]);
  await p2.reload();
  await p2.click('#menuBtn'); await p2.click('#mPilot');
  await p2.evaluate(() => { const b = document.createElement('button'); b.dataset.open = 'msgs'; b.id = 'x'; document.querySelector('#pilotRoot .list').append(b) });
  await p2.click('#x');
  assert.ok((await p2.textContent('#pilotRoot')).includes('امروز پیامی برای فرستادن نیست'));
  await noHScroll(p2, 'messages (empty)');
  await shot(p2, '10-messages-empty');
}

// E. importing the Excel workbook itself (.xlsx with title rows, a sample row and summary rows)
{
  const pe = await newPage();
  await pe.goto(ORIGIN + '/');
  await pe.click('#menuBtn'); await pe.click('#mPilot');
  await pe.setInputFiles('#aCsv', join(ROOT, 'tests/fixtures/list-synthetic.xlsx'));
  await pe.waitForSelector('#aImpYes:not([disabled])');
  const txt = await pe.textContent('#pilotRoot .dayend');
  assert.ok(txt.includes('ردیف «نمونه» وارد نمی‌شود') && txt.includes('ردیف جمع'), txt);
  await pe.click('#aImpYes');
  const st = await state(pe);
  assert.equal(Object.keys(st.pilot.people).length, 4);
  // a file that is neither: clear message, import disabled
  await pe.setInputFiles('#aCsv', {name: 'x.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from('PK\x03\x04 broken')});
  await pe.waitForSelector('#aImpYes[disabled]');
  assert.ok((await pe.textContent('#pilotRoot .dayend')).includes('این فایل خوانده نشد'));
  console.log('E ok: xlsx import');
}

// F. booking fixes: back gesture closes sheets/pages, done needs an amount, a booking needs a number or name, overlapping service times, a source
{
  const pf = await newPage();
  await pf.goto(ORIGIN + '/');
  // old default service times are migrated; edited ones would be left alone
  await pf.evaluate(k => localStorage.setItem(k, JSON.stringify({v: 1, bookings: [], customers: {}, settings: {services: [
    {id: 'gel', label: 'ژل پا', min: 30, price: 600000}, {id: 'ped', label: 'پدیکور', min: 60, price: 0},
    {id: 'tar', label: 'ترمیم', min: 30, price: 0}, {id: 'pla', label: 'پلاژن', min: 90, price: 0}], dayStart: '07:00', dayEnd: '21:00', sharePct: 65, hoursV: 2}})), KEY);
  await pf.reload();
  const durs = await pf.evaluate(() => { const d = window.__daftar.dur; return [d({services: ['ped', 'pla']}), d({services: ['pla']}), d({services: ['gel', 'ped']})] });
  assert.deepEqual(durs, [80, 60, 70], 'pedicure+plazhen 80, plazhen alone 60, gel+pedicure 70');
  const url = pf.url();
  const back = async () => { await pf.evaluate(() => history.back()); await pf.waitForTimeout(150) };
  const sheetOpen = () => pf.evaluate(() => !!document.getElementById('sheetRoot').innerHTML);
  // back closes a sheet and stays in the app; closing with ✕ leaves no extra history entry
  await pf.click('#menuBtn'); assert.ok(await sheetOpen());
  await back(); assert.equal(await sheetOpen(), false, 'back closed the menu'); assert.equal(pf.url(), url);
  await pf.click('#menuBtn'); await pf.click('[data-close]'); await pf.waitForTimeout(150);
  assert.equal(await pf.evaluate(() => history.state), null, 'no stale entry after ✕');
  // menu → pilot page → back: page closes, app still open
  await pf.click('#menuBtn'); await pf.click('#mPilot');
  assert.equal(await pf.isVisible('#pilotRoot'), true);
  await back(); assert.equal(await pf.isVisible('#pilotRoot'), false, 'back closed the pilot page'); assert.equal(pf.url(), url);
  // a booking needs a number or a name; without a mobile number it asks once more
  await pf.click('#addBtn'); await setTime(pf, '20:00'); await pf.click('#fSvc [data-s="tar"]'); await pf.click('#fSrc [data-k="direct"]');
  await pf.click('#fSave'); assert.equal((await state(pf)).bookings.length, 0, 'no number, no name: not saved');
  await pf.fill('#fName', 'آزمون'); await pf.click('#fSave');
  assert.equal((await state(pf)).bookings.length, 0, 'no number: asks first');
  assert.equal((await pf.textContent('#fSave')).trim(), 'بدون شماره ثبت کن');
  await pf.click('#fSave'); assert.equal((await state(pf)).bookings.length, 1, 'saved on the second tap');
  // «انجام شد» with an empty amount does nothing
  await pf.click('#list .item'); await pf.fill('#aAmt', ''); await pf.click('#aDone');
  assert.equal((await state(pf)).bookings[0].status, 'booked', 'done without an amount refused');
  await pf.fill('#aAmt', '500000'); await pf.click('#aDone');
  let st = await state(pf); assert.equal(st.bookings[0].status, 'done'); assert.equal(st.bookings[0].amount, 500000);
  // «همه را انجام شد»: uses the default price; a booking with no price stays booked
  await pf.click('#addBtn'); await setTime(pf, '19:00'); await pf.fill('#fCust', '09120000009'); await pf.click('#fSvc [data-s="gel"]'); await pf.click('#fSrc [data-k="direct"]'); await pf.fill('#fAmt', ''); await pf.click('#fSave');
  await pf.click('#addBtn'); await setTime(pf, '18:00'); await pf.fill('#fCust', '09120000008'); await pf.click('#fSvc [data-s="tar"]'); await pf.click('#fSrc [data-k="direct"]'); await pf.click('#fSave');
  await pf.click('#allDone');
  st = await state(pf);
  const by = c => st.bookings.find(b => b.customer === c);
  assert.equal(by('09120000009').status, 'done'); assert.equal(by('09120000009').amount, 600000);
  assert.equal(by('09120000008').status, 'booked', 'no default price: stays booked');
  assert.ok(st.bookings.every(b => b.status !== 'done' || b.amount > 0), 'no done booking without an amount');
  // «از کجا آمد؟» is required: nothing preselected on a new booking; saving is refused and the row is marked until one is chosen
  await pf.click('#addBtn');
  assert.equal(await pf.locator('#fSrc .chip.on').count(), 0, 'no source preselected on a new booking');
  await setTime(pf, '17:00'); await pf.fill('#fCust', '09120000007'); await pf.click('#fSvc [data-s="tar"]');
  const before = (await state(pf)).bookings.length;
  await pf.click('#fSave'); assert.equal((await state(pf)).bookings.length, before, 'no source: not saved');
  assert.ok(await pf.evaluate(() => document.getElementById('fSrc').classList.contains('need')), 'source row marked');
  await pf.click('#fSrc [data-k="insta"]');
  assert.equal(await pf.evaluate(() => document.getElementById('fSrc').classList.contains('need')), false, 'mark cleared');
  await pf.click('#fSave');
  st = await state(pf); assert.equal(st.bookings.find(b => b.customer === '09120000007').source, 'insta');
  await noHScroll(pf, 'booking fixes');
  console.log('F ok: back gesture, amounts, booking identity, service times, required source');
}

// G. short booking form (one screen at 390×844): day, half-hour times, recent customers, referrer list, new service, reschedule
{
  const pg = await newPage();
  await pg.setViewportSize({width: 390, height: 844});
  await pg.goto(ORIGIN + '/');
  const tmr = daysAgo(-1), after = daysAgo(-2);
  await pg.evaluate(([k, d]) => localStorage.setItem(k, JSON.stringify({v: 1, customers: {'09121111111': {name: 'سارا'}}, bookings: [
    {id: 'a', date: d, time: '10:00', customer: '09121111111', name: 'سارا', services: ['ped'], source: 'mani', ref: 'فاطی', status: 'done', amount: 900000, pct: 65, created: 1},
    {id: 'b', date: d, time: '12:00', customer: '09122222222', name: '', services: ['gel'], source: 'mani', ref: 'فاطی', status: 'done', amount: 500000, pct: 65, created: 2},
    {id: 'c', date: d, time: '14:00', customer: '09123333333', name: '', services: ['gel'], source: 'mani', ref: 'مریم', status: 'done', amount: 500000, pct: 65, created: 3}]})), [KEY, daysAgo(10)]);
  await pg.reload();
  assert.deepEqual((await state(pg)).settings.refs, ['فاطی', 'مریم'], 'referrers migrated, most used first');
  await pg.click('#addBtn'); await pg.waitForTimeout(300); // sheet slide-in
  const box = await pg.locator('#fSave').boundingBox();
  assert.ok(box && box.y + box.height <= 844, 'save button visible without scrolling: ' + JSON.stringify(box));
  assert.equal(await pg.isVisible('#fCal'), false, 'calendar folded');
  await pg.click('#fDayBtn'); await pg.click(`#fCal [data-d="${tmr}"]`);
  assert.equal(await pg.isVisible('#fCal'), false, 'calendar folds after picking');
  assert.ok((await pg.textContent('#fDayTxt')).includes('فردا'));
  assert.equal(await pg.locator('#fTimes [data-t]').count(), 28, 'half-hour times 07:00–20:30 on an empty day');
  await pg.click('#fTimes [data-t="10:00"]');
  assert.equal(await pg.inputValue('#fTime'), '10:00');
  await pg.click('#fRecent [data-c="09121111111"]');
  assert.equal(await pg.inputValue('#fCust'), '09121111111'); assert.equal(await pg.inputValue('#fName'), 'سارا');
  assert.equal(await pg.isVisible('#fRecent'), false, 'recent list hides once a number is in');
  await pg.click('#fSvc [data-s="ped"]');
  assert.equal(await pg.isVisible('#fRefBox'), false);
  await pg.click('#fSrc [data-k="mani"]'); await pg.click('#fRefs [data-r="فاطی"]');
  await pg.click('#fSave');
  let st = await state(pg); let nb = st.bookings.find(b => b.date === tmr);
  assert.ok(nb && nb.time === '10:00' && nb.ref === 'فاطی' && nb.customer === '09121111111', 'booked in a few taps');
  // a new service from the form: saved to settings, selected, its price fills the amount
  await pg.click('#addBtn'); await pg.click('#fSvcAdd');
  await pg.fill('#fSvcName', 'لاک'); await pg.fill('#fSvcMin', '20'); await pg.fill('#fSvcPrice', '300000'); await pg.click('#fSvcOk');
  st = await state(pg); const lak = st.settings.services.find(x => x.label === 'لاک');
  assert.ok(lak && lak.min === 20 && lak.price === 300000, 'service added to settings');
  assert.equal(await pg.locator(`#fSvc [data-s="${lak.id}"].on`).count(), 1, 'and selected');
  assert.equal(await pg.inputValue('#fAmt'), '300000', 'its price fills the amount');
  // a new referrer typed once joins the list
  await pg.click('#fSrc [data-k="recep"]'); await pg.click('#fRefAdd'); await pg.fill('#fRef', 'نگار');
  await setTime(pg, '16:00'); await pg.fill('#fCust', '09124444444'); await pg.click('#fSave');
  assert.ok((await state(pg)).settings.refs.includes('نگار'), 'new referrer saved to the list');
  // reschedule keeps where it came from
  await pg.click('#todayBtn'); await pg.click('#nextDay'); await pg.click(`#list .item[data-id="${nb.id}"]`);
  await pg.click('#aMove');
  assert.equal(await pg.isVisible('#fCal'), true, 'reschedule opens the calendar');
  await pg.click(`#fCal [data-d="${after}"]`); await pg.click('#fTimes [data-t="11:00"]'); await pg.click('#fSave');
  st = await state(pg); nb = st.bookings.find(b => b.id === nb.id);
  assert.equal(nb.date, after); assert.equal(nb.time, '11:00'); assert.equal(nb.status, 'booked');
  assert.deepEqual(nb.moves.map(m => [m.date, m.time]), [[tmr, '10:00']], 'move history kept');
  assert.ok((await pg.textContent('#list')).includes('جابه‌جا از'), 'shown on the timeline');
  assert.ok((await pg.evaluate(() => window.__daftar.csv())).split('\n')[0].endsWith('moved_from'));
  // settings: remove a duplicate referrer
  await pg.click('#menuBtn'); await pg.click('#mRefs [data-rfdel="1"]'); await pg.click('#mSaveSet');
  assert.deepEqual((await state(pg)).settings.refs, ['فاطی', 'نگار']);
  await noHScroll(pg, 'short booking form');
  await pg.click('#addBtn'); await shot(pg, '11-booking-form');
  console.log('G ok: one-screen form, half-hour times, recent customers, referrer list, new service, reschedule');
}

// H. Melika's app: same code, own link, name, services, sources, storage and worker; no pilot menu
{
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, serviceWorkers: 'allow', locale: 'fa-IR'});
  const pm = await ctx.newPage();
  pm.on('pageerror', e => problems.push('melika page error: ' + e.message));
  pm.on('request', r => { const u = r.url(); if (!u.startsWith(ORIGIN) && !/^(data|blob):/.test(u)) problems.push('external request: ' + u) });
  const settled = async fn => { for (let i = 0; ; i++) { try { return await fn() } catch (e) { if (i > 20 || !/context was destroyed|navigat/i.test(e.message)) throw e; await pm.waitForTimeout(250) } } };
  await pm.goto(ORIGIN + '/');
  await pm.evaluate(() => navigator.serviceWorker.ready);
  const realBefore = await pm.evaluate(() => localStorage.getItem('daftar-mojgan-v1'));
  await pm.goto(ORIGIN + '/melika/');
  assert.equal(await settled(() => pm.title()), 'دفتر نوبت ملیکا');
  let mine = false;
  for (let i = 0; i < 40 && !mine; i++) {
    try { mine = await pm.evaluate(() => !!(navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL.includes('/melika/sw.js'))) } catch (_) {}
    if (!mine) await pm.waitForTimeout(250);
  }
  assert.ok(mine, 'Melika page is controlled by its own worker');
  await pm.waitForTimeout(800); await settled(() => pm.reload());
  await pm.click('#addBtn');
  const labels = await pm.locator('#fSvc [data-s]').allTextContents();
  assert.deepEqual(labels, ['کاشت', 'ترمیم', 'لمینت', 'ژلیش', 'ریموو', 'مانیکور']);
  assert.deepEqual(await pm.locator('#fSrc [data-k]').allTextContents(), ['مستقیم', 'اینستاگرام', 'معرفی همکار', 'پذیرش سالن']);
  await pm.click('#fSvc [data-s="kasht"]');
  assert.equal(await pm.inputValue('#fAmt'), '', 'amount stays empty');
  assert.equal(await pm.getAttribute('#fAmt', 'placeholder'), '۹۵۰,۰۰۰', 'default price only as a faint hint');
  await pm.fill('#fAmt', '1100000');
  await setTime(pm, '20:30'); await pm.fill('#fCust', '09125555555'); await pm.click('#fSrc [data-k="mate"]');
  assert.equal(await pm.isVisible('#fRefBox'), true, 'معرفی همکار asks who');
  await pm.click('#fSave');
  // a booking with no amount: «انجام شد» needs the real one, «همه را انجام شد» leaves it booked
  await pm.click('#addBtn'); await setTime(pm, '20:00'); await pm.fill('#fCust', '09125555556'); await pm.click('#fSvc [data-s="tarmim"]'); await pm.click('#fSrc [data-k="direct"]'); await pm.click('#fSave');
  const tid = (await pm.evaluate(() => window.__daftar.state().bookings.find(b => b.customer === '09125555556').id));
  await pm.click(`#list .item[data-id="${tid}"]`);
  assert.equal(await pm.inputValue('#aAmt'), ''); assert.equal(await pm.getAttribute('#aAmt', 'placeholder'), '۷۵۰,۰۰۰');
  await pm.click('#aDone'); await pm.click('[data-close]');
  await pm.click('#allDone');
  const mb = await pm.evaluate(() => window.__daftar.state().bookings);
  assert.equal(mb.find(b => b.id === tid).status, 'booked', 'no amount typed: never done at the list price');
  assert.equal(mb.find(b => b.customer === '09125555555').status, 'done', 'typed amount: done');
  await pm.click('#menuBtn');
  assert.equal(await pm.locator('#mPilot').count(), 0, 'no pilot menu');
  const ls = await pm.evaluate(() => ({m: JSON.parse(localStorage.getItem('daftar-melika-v1') || '{}'), real: localStorage.getItem('daftar-mojgan-v1')}));
  assert.equal(ls.m.bookings.length, 2); assert.equal(ls.m.bookings.find(b => b.customer === '09125555555').amount, 1100000); assert.equal(ls.m.settings.sharePct, 65);
  assert.equal(ls.real, realBefore, 'Mojgan\'s data untouched');
  assert.ok(!(await pm.content()).includes('مژگان'), 'no «مژگان» anywhere');
  await pm.goto(ORIGIN + '/');
  assert.equal(await settled(() => pm.title()), 'دفتر نوبت مژگان', 'the real app still answers its own link');
  const keys = await pm.evaluate(() => caches.keys());
  assert.ok(keys.some(k => k.startsWith('daftar-melika-')) && keys.includes(readFileSync(join(DOCS, 'sw.js'), 'utf8').match(/const CACHE = '([^']+)'/)[1]), 'both caches survive: ' + keys);
  await ctx.close();
  console.log('H ok: Melika app isolated (link, name, services, sources, storage, worker), no pilot');
}

// D. preview copy: own storage key and service worker; the real app's worker never answers for it
{
  const ctx = await browser.newContext({viewport: {width: 375, height: 812}, serviceWorkers: 'allow', acceptDownloads: true});
  const pg = await ctx.newPage();
  pg.on('pageerror', e => problems.push('preview page error: ' + e.message));
  pg.on('request', r => { const u = r.url(); if (!u.startsWith(ORIGIN) && !/^(data|blob):/.test(u)) problems.push('external request: ' + u) });
  await pg.goto(ORIGIN + '/');
  await pg.evaluate(() => navigator.serviceWorker.ready);
  await pg.reload();
  assert.ok(await pg.evaluate(() => !!navigator.serviceWorker.controller), 'real app is controlled by its worker');
  const realBefore = await pg.evaluate(() => localStorage.getItem('daftar-mojgan-v1'));
  // retry across the app's one-time "new worker took over" reload
  const settled = async fn => { for (let i = 0; ; i++) { try { return await fn() } catch (e) { if (i > 20 || !/context was destroyed|navigat/i.test(e.message)) throw e; await pg.waitForTimeout(250) } } };
  await pg.goto(ORIGIN + '/preview/');
  assert.ok((await settled(() => pg.title())).includes('پیش‌نمایش'), 'preview page, not the cached real app');
  // the preview's own worker claims the page (the app then reloads once, as on any worker change)
  let mine = false;
  for (let i = 0; i < 40 && !mine; i++) {
    try { mine = await pg.evaluate(() => !!(navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL.includes('/preview/sw.js'))) } catch (_) {}
    if (!mine) await pg.waitForTimeout(250);
  }
  assert.ok(mine, 'preview page is controlled by the preview worker');
  await pg.waitForTimeout(800); await settled(() => pg.reload());
  await pg.click('#menuBtn'); await pg.click('#mSample');
  const ls = await pg.evaluate(() => ({pv: JSON.parse(localStorage.getItem('daftar-preview') || '{}'), real: localStorage.getItem('daftar-mojgan-v1')}));
  assert.ok(ls.pv.bookings && ls.pv.bookings.length > 0, 'preview writes its own key');
  assert.equal(ls.real, realBefore, 'real key untouched by the preview');
  pg.once('dialog', d => d.accept('09120000000'));
  const [dl] = await Promise.all([pg.waitForEvent('download'), pg.click('#pvCsv')]);
  const csv = readFileSync(await dl.path(), 'utf8');
  assert.equal(csv.trim().split('\n').length, 61);
  await pg.goto(ORIGIN + '/');
  assert.equal(await pg.title(), 'دفتر نوبت مژگان');
  const keys = await pg.evaluate(() => caches.keys());
  assert.ok(keys.includes(readFileSync(join(DOCS, 'sw.js'), 'utf8').match(/const CACHE = '([^']+)'/)[1]) && keys.some(k => k.startsWith('daftar-preview-')), 'both caches survive: ' + keys);
  await ctx.close();
  console.log('D ok: preview isolated (storage, worker, cache)');
}

await browser.close();
server.close();
if (problems.length) { console.error('PROBLEMS:\n' + problems.join('\n')); process.exit(1) }
console.log('e2e ok' + (SHOTS ? ' (screenshots written to screenshots/)' : ''));
