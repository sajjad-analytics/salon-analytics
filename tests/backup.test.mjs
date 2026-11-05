// Tests for the weekly automatic backup: the app side (BACKUP-CORE block of docs/index.html)
// and the receiver that runs as a Google Apps Script web app (tools/backup_receiver.gs).
// Run: node --test tests/*.test.mjs        All data here is synthetic.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const m = html.match(/\/\* BACKUP-CORE START \*\/([\s\S]*?)\/\* BACKUP-CORE END \*\//);
assert.ok(m, 'BACKUP-CORE block not found in docs/index.html');
const BC = new Function(m[1] + '\nreturn BC;')();
const pm = html.match(/\/\* PILOT-CORE START \*\/([\s\S]*?)\/\* PILOT-CORE END \*\//);
const PC = new Function(pm[1] + '\nreturn PC;')();

const DAY = 864e5, HOUR = 36e5, NOW = 1793836800000;
const booking = i => ({id: 'b' + i, date: '2026-10-1' + (i % 10), time: '10:00', customer: '0912000' + String(i).padStart(4, '0'), status: 'done', amount: 530000});
const state = n => ({v: 1, bookings: [...Array(n)].map((_, i) => booking(i)), customers: {}, settings: {}, lastBackup: null});

// ---------- when to send ----------
test('due: never sent and has bookings → send', () => {
  assert.equal(BC.due(state(5), {on: true}, NOW), true);
});
test('due: an empty phone never sends (no junk files from a fresh install)', () => {
  assert.equal(BC.due(state(0), {on: true}, NOW), false);
});
test('due: weekly — not before 7 days, yes at 7 days', () => {
  assert.equal(BC.due(state(5), {on: true, last: NOW - 6 * DAY - 23 * HOUR}, NOW), false);
  assert.equal(BC.due(state(5), {on: true, last: NOW - 7 * DAY}, NOW), true);
});
test('due: after a failed try, wait an hour before trying again', () => {
  const ab = {on: true, last: NOW - 9 * DAY, lastTry: NOW - 20 * 60e3, fails: 1};
  assert.equal(BC.due(state(5), ab, NOW), false);
  assert.equal(BC.due(state(5), Object.assign({}, ab, {lastTry: NOW - HOUR}), NOW), true);
});
test('due: switched off by Mojgan → never', () => {
  assert.equal(BC.due(state(5), {on: false}, NOW), false);
});
test('due: missing state counts as on (first run after the update)', () => {
  assert.equal(BC.due(state(5), undefined, NOW), true);
});
test('due: a manual "send now" ignores the week but not the off switch or empty data', () => {
  assert.equal(BC.due(state(5), {on: true, last: NOW - HOUR}, NOW, true), true);
  assert.equal(BC.due(state(5), {on: false}, NOW, true), false);
  assert.equal(BC.due(state(0), {on: true}, NOW, true), false);
});

// ---------- what is sent ----------
test('payload: full state, app name, token, counts; parses back exactly', () => {
  const S = state(3); S.pilot = {people: {a: 1}};
  const p = JSON.parse(BC.payload(S, {app: 'mojgan', token: 'tkn', sentAt: NOW, ver: 'daftar-v11'}));
  assert.equal(p.kind, 'daftar-backup');
  assert.equal(p.app, 'mojgan'); assert.equal(p.token, 'tkn'); assert.equal(p.sentAt, NOW); assert.equal(p.ver, 'daftar-v11');
  assert.equal(p.count, 3);
  assert.deepEqual(p.data, S);
});

// ---------- reading the answer ----------
test('parseResponse: ok answer with a file name', () => {
  assert.deepEqual(BC.parseResponse('{"ok":true,"name":"daftar-mojgan-2026-11-05_0930.json"}'), {ok: true, name: 'daftar-mojgan-2026-11-05_0930.json'});
});
test('parseResponse: refused, HTML login page, empty → not ok, short reason', () => {
  assert.deepEqual(BC.parseResponse('{"ok":false,"err":"token"}'), {ok: false, err: 'token'});
  const h = BC.parseResponse('<!DOCTYPE html><html>Sign in</html>');
  assert.equal(h.ok, false); assert.ok(h.err.length <= 40, h.err);
  assert.equal(BC.parseResponse('').ok, false);
  assert.equal(BC.parseResponse('{"ok":true}').ok, false, 'ok without a file name is not trusted');
});

// ---------- remembering the result ----------
test('record: success sets last, clears failures', () => {
  const ab = BC.record({on: true, fails: 3, lastErr: 'net'}, NOW, {ok: true, name: 'f.json'});
  assert.deepEqual(ab, {on: true, fails: 0, lastErr: '', last: NOW, lastTry: NOW, lastName: 'f.json'});
});
test('record: failure keeps the last good send and counts', () => {
  const ab = BC.record({on: true, last: NOW - 8 * DAY, fails: 1}, NOW, {ok: false, err: 'offline'});
  assert.equal(ab.last, NOW - 8 * DAY); assert.equal(ab.fails, 2); assert.equal(ab.lastErr, 'offline'); assert.equal(ab.lastTry, NOW);
});
test('record: never mutates its input', () => {
  const ab = {on: true, fails: 0}; BC.record(ab, NOW, {ok: false, err: 'x'}); assert.deepEqual(ab, {on: true, fails: 0});
});

// ---------- the warning bar ----------
test('warn: auto on and working → no nagging even after 3+ days', () => {
  const S = state(10); S.lastBackup = NOW - 6 * DAY;
  assert.equal(BC.warn(S, {on: true, last: NOW - 6 * DAY}, NOW, true), null);
});
test('warn: auto on but nothing reached Sajjad for 8 days → ask for a manual backup', () => {
  const S = state(10); S.lastBackup = NOW - 9 * DAY;
  assert.deepEqual(BC.warn(S, {on: true, last: NOW - 9 * DAY, fails: 4}, NOW, true), {kind: 'auto-failing', days: 9});
});
test('warn: auto never succeeded, installed 2 days ago → quiet; 8 days with no backup at all → warn', () => {
  const S = state(10);
  assert.equal(BC.warn(S, {on: true, since: NOW - 2 * DAY}, NOW, true), null);
  assert.deepEqual(BC.warn(S, {on: true, since: NOW - 8 * DAY}, NOW, true), {kind: 'auto-failing', days: null});
});
test('warn: a recent manual backup also counts', () => {
  const S = state(10); S.lastBackup = NOW - DAY;
  assert.equal(BC.warn(S, {on: true, last: NOW - 20 * DAY}, NOW, true), null);
});
test('warn: auto off (or Melika build) → the old 3-day rule, unchanged', () => {
  const S = state(10); S.lastBackup = NOW - 3 * DAY;
  assert.deepEqual(BC.warn(S, {on: false}, NOW, true), {kind: 'manual', days: 3});
  assert.deepEqual(BC.warn(S, undefined, NOW, false), {kind: 'manual', days: 3});
  S.lastBackup = NOW - 2 * DAY; assert.equal(BC.warn(S, undefined, NOW, false), null);
  assert.deepEqual(BC.warn(state(10), undefined, NOW, false), {kind: 'manual', days: null});
  assert.equal(BC.warn(state(2), undefined, NOW, false), null, 'fewer than 3 bookings: no warning, as before');
});

// ---------- restoring an old backup keeps this phone's auto-backup state ----------
test('restoreState: an older backup does not switch auto-backup back or rewind its clock', () => {
  const cur = state(5); cur.autoBackup = {on: false, last: NOW};
  const inc = state(2); inc.autoBackup = {on: true, last: NOW - 30 * DAY};
  assert.deepEqual(PC.restoreState(cur, inc, {}).autoBackup, {on: false, last: NOW});
  const inc2 = state(2); assert.equal(PC.restoreState(state(1), inc2, {}).autoBackup, undefined);
});

// ---------- the receiver (Google Apps Script) ----------
const gs = readFileSync(new URL('../tools/backup_receiver.gs', import.meta.url), 'utf8');
function receiver() {
  const files = [];
  const folder = {createFile: (name, body, mime) => { files.push({name, body, mime}); return {getName: () => name} }};
  const DriveApp = {getFoldersByName: () => ({hasNext: () => files.folderMade, next: () => folder}),
    createFolder: () => { files.folderMade = true; return folder }};
  const Utilities = {formatDate: (d, tz, f) => { assert.equal(tz, 'Asia/Tehran'); assert.equal(f, 'yyyy-MM-dd_HHmm'); return '2026-11-05_0930' }};
  const ContentService = {MimeType: {JSON: 'json'}, createTextOutput: t => ({t, setMimeType() { return this }})};
  const api = new Function('DriveApp', 'Utilities', 'ContentService', gs + '\nreturn {handle, doPost, doGet, TOKEN};')(DriveApp, Utilities, ContentService);
  return {api, files};
}
const body = (over = {}) => JSON.stringify(Object.assign({kind: 'daftar-backup', app: 'mojgan', token: receiver().api.TOKEN, sentAt: NOW, count: 2, data: state(2)}, over));

test('receiver: token in the .gs matches the one in the app', () => {
  const t = receiver().api.TOKEN; assert.ok(t && t.length >= 12);
  assert.ok(html.includes(`const AUTO_BACKUP_TOKEN='${t}';`), 'index.html AUTO_BACKUP_TOKEN differs from tools/backup_receiver.gs');
});
test('receiver: a good backup is saved as one JSON file named by app and Tehran time', () => {
  const {api, files} = receiver();
  assert.deepEqual(api.handle(body(), new Date(NOW)), {ok: true, name: 'daftar-mojgan-2026-11-05_0930.json'});
  assert.equal(files.length, 1); assert.equal(files[0].name, 'daftar-mojgan-2026-11-05_0930.json');
  assert.deepEqual(JSON.parse(files[0].body), state(2), 'the file holds the app state itself, restorable from ☰');
});
test('receiver: refuses wrong token, other apps, wrong kind, broken data, oversize — and saves nothing', () => {
  const {api, files} = receiver();
  assert.deepEqual(api.handle(body({token: 'nope'}), new Date(NOW)), {ok: false, err: 'token'});
  assert.deepEqual(api.handle(body({app: 'melika'}), new Date(NOW)), {ok: false, err: 'app'});
  assert.deepEqual(api.handle(body({kind: 'x'}), new Date(NOW)), {ok: false, err: 'kind'});
  assert.deepEqual(api.handle(body({data: {bookings: 'no'}}), new Date(NOW)), {ok: false, err: 'data'});
  assert.deepEqual(api.handle('not json', new Date(NOW)), {ok: false, err: 'json'});
  assert.deepEqual(api.handle(undefined, new Date(NOW)), {ok: false, err: 'empty'});
  assert.deepEqual(api.handle('x'.repeat(5e6 + 1), new Date(NOW)), {ok: false, err: 'size'});
  assert.equal(files.length, 0);
});
test('receiver: doPost answers JSON; doGet is a harmless ping', () => {
  const {api} = receiver();
  assert.deepEqual(JSON.parse(api.doPost({postData: {contents: body()}}).t), {ok: true, name: 'daftar-mojgan-2026-11-05_0930.json'});
  assert.deepEqual(JSON.parse(api.doGet().t), {ok: true, ping: 'daftar-backup'});
});

// ---------- builds: only Mojgan's app sends ----------
test('builds: Melika and preview switch auto-backup off', () => {
  assert.ok(html.includes('const AUTO_BACKUP_ON=true;'), 'flag present in index.html');
  for (const f of ['build_melika.mjs', 'build_preview.mjs'])
    assert.ok(readFileSync(new URL('../tools/' + f, import.meta.url), 'utf8').includes("'const AUTO_BACKUP_ON=true;', 'const AUTO_BACKUP_ON=false;'"), f + ' must turn it off');
});
