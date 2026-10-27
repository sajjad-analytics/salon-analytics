// Deployment check: the app as it is served at https://sajjad-analytics.github.io/salon-analytics/,
// with its real service worker, an old backup, and no network.  Synthetic data only.
// Run: node tests/deploy.mjs [--browser=chromium|webkit] [--width=390|412]
//        serves docs/ locally under /salon-analytics/ (the same path as on GitHub Pages)
//      node tests/deploy.mjs --url=https://sajjad-analytics.github.io/salon-analytics/
//        checks the live site: every file byte-for-byte equal to docs/, then the same browser checks
// Checks: worker scope is the app folder, cache name is the one in docs/sw.js, a phone that already has the
// old backup's data keeps all of it, restoring the backup file brings back every booking, the app opens offline.
// Melika's app (melika/, key daftar-melika-v1) has its own worker and data and never touches Mojgan's.
import http from 'node:http';
import {readFileSync, existsSync, statSync} from 'node:fs';
import {join, dirname, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {engine, phone, label, touch, BROWSER} from './device.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');
const KEY = 'daftar-mojgan-v1', MKEY = 'daftar-melika-v1';
const PREFIX = '/salon-analytics/';
const SW = readFileSync(join(DOCS, 'sw.js'), 'utf8');
const CACHE = SW.match(/const CACHE = '([^']+)'/)[1];
const BACKUP_FILE = join(ROOT, 'tests/fixtures/backup-v1.json');
const BACKUP = JSON.parse(readFileSync(BACKUP_FILE, 'utf8'));
const urlArg = process.argv.find(a => a.startsWith('--url='));

let BASE, server;
if (urlArg) {
  BASE = urlArg.slice(6).replace(/\/?$/, '/');
  // the files the installed apps depend on, plus the preview copy
  const files = ['', 'index.html', 'sw.js', 'manifest.webmanifest', ...JSON.parse(SW.match(/const FILES = (\[[^\]]+\])/)[1].replace(/'/g, '"')).filter(f => f !== './'),
    'melika/', 'melika/sw.js', 'melika/manifest.webmanifest', 'preview/', 'preview/sw.js', 'preview/manifest.webmanifest'];
  for (const f of [...new Set(files)]) {
    let res;
    for (let i = 0; i < 5; i++) { res = await fetch(BASE + f + '?nocache=' + Date.now(), {cache: 'no-store'}); if (res.ok) break; await new Promise(r => setTimeout(r, 3000)) }
    assert.equal(res.status, 200, 'live ' + (f || '/') + ' status');
    const live = Buffer.from(await res.arrayBuffer()), local = readFileSync(join(DOCS, f.endsWith('/') || !f ? f + 'index.html' : f));
    assert.ok(live.equals(local), `live ${f || '/'} differs from docs/${f} (Pages not yet rebuilt, or wrong source?)`);
  }
  console.log(`live files equal docs/ (cache ${CACHE})`);
} else {
  const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json'};
  server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!p.startsWith(PREFIX)) { res.writeHead(404); res.end(); return }
    p = p.slice(PREFIX.length - 1);
    if (p.endsWith('/')) p += 'index.html';
    const f = join(DOCS, p);
    if (!f.startsWith(DOCS) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end(); return }
    res.writeHead(200, {'Content-Type': TYPES[extname(f)] || 'application/octet-stream'}); res.end(readFileSync(f));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${server.address().port}${PREFIX}`;
}

const problems = [];
const browser = await engine.launch();
const ctx = await browser.newContext({...phone, serviceWorkers: 'allow', acceptDownloads: true, locale: 'fa-IR'});
const page = touch(await ctx.newPage());
page.on('pageerror', e => problems.push('page error: ' + e.message));
const state = () => page.evaluate(() => window.__daftar.state());
// retry across the app's one-time "new worker took over" reload
const settled = async fn => { for (let i = 0; ; i++) { try { return await fn() } catch (e) { if (i > 20 || !/context was destroyed|navigat/i.test(e.message)) throw e; await page.waitForTimeout(250) } } };
const sameBookings = (st, where) => {
  assert.equal(st.bookings.length, BACKUP.bookings.length, where + ': booking count');
  for (const b of BACKUP.bookings) {
    const got = st.bookings.find(x => x.id === b.id);
    assert.ok(got, where + ': booking ' + b.id + ' missing');
    for (const [k, v] of Object.entries(b)) assert.deepEqual(got[k], v, `${where}: booking ${b.id}.${k}`);
  }
  for (const c of Object.keys(BACKUP.customers)) assert.ok(st.customers[c], where + ': customer ' + c + ' missing');
};

// 1. a phone that already has data from an old version: the app opens at the same address and keeps all of it
await page.goto(BASE);
await page.evaluate(([k, v]) => localStorage.setItem(k, v), [KEY, JSON.stringify(BACKUP)]);
await settled(() => page.reload());
const reg = await settled(() => page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return {scope: r.scope, script: r.active.scriptURL} }));
assert.equal(reg.scope, BASE, 'worker scope is the app folder');
assert.equal(reg.script, BASE + 'sw.js');
for (let i = 0; i < 40 && !(await settled(() => page.evaluate(() => !!navigator.serviceWorker.controller))); i++) await page.waitForTimeout(250);
await page.waitForTimeout(800); await settled(() => page.reload());
assert.ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'page controlled by the worker');
assert.ok((await page.evaluate(() => caches.keys())).includes(CACHE), 'cache ' + CACHE);
assert.equal(await page.title(), 'دفتر نوبت مژگان');
sameBookings(await state(), 'existing data');
console.log(`1 ok: ${BASE} · worker scope ${reg.scope} · cache ${CACHE} · old data kept`);

// 2. restoring the old backup file from the menu (as on a new phone) brings back every booking
await page.evaluate(k => localStorage.removeItem(k), KEY);
await page.reload();
assert.equal((await state()).bookings.length, 0, 'empty phone');
await page.click('#menuBtn');
await page.setInputFiles('#mFile', BACKUP_FILE);
await page.waitForSelector('#mDoRestoreFile:not([hidden])');
await page.click('#mDoRestoreFile');
sameBookings(await state(), 'restored file');
await page.reload();
sameBookings(await state(), 'restored file after reload');
console.log('2 ok: old backup file restored completely');

// 3. Melika's app at melika/: its own worker, cache and key; Mojgan's data and worker untouched
const mojganRaw = await page.evaluate(k => localStorage.getItem(k), KEY);
await page.goto(BASE + 'melika/');
assert.equal(await settled(() => page.title()), 'دفتر نوبت ملیکا');
let mreg;
for (let i = 0; i < 40; i++) {
  mreg = await settled(() => page.evaluate(() => { const c = navigator.serviceWorker.controller; return c ? c.scriptURL : null }));
  if (mreg && mreg.endsWith('/melika/sw.js')) break;
  await page.waitForTimeout(250);
}
assert.equal(mreg, BASE + 'melika/sw.js', "Melika's page is controlled by her own worker");
await page.waitForTimeout(800); await settled(() => page.reload());
const mScope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).scope);
assert.equal(mScope, BASE + 'melika/');
await page.evaluate(([k, v]) => localStorage.setItem(k, v), [MKEY, JSON.stringify({v: 1, bookings: [], customers: {}})]);
await page.reload();
assert.ok((await page.evaluate(() => caches.keys())).some(k => k.startsWith('daftar-melika-')), 'Melika cache');
assert.equal(await page.evaluate(k => localStorage.getItem(k), KEY), mojganRaw, "Mojgan's data untouched by Melika's app");
await page.goto(BASE);
assert.equal(await settled(() => page.title()), 'دفتر نوبت مژگان');
assert.equal(await page.evaluate(() => navigator.serviceWorker.controller.scriptURL), BASE + 'sw.js', "Mojgan's page still has her worker");
sameBookings(await state(), 'after visiting Melika');
console.log(`3 ok: melika/ · worker scope ${mScope} · own key and cache · Mojgan's data and worker untouched`);

// 4. no network: the installed apps still open with their data.
// Locally the server itself is stopped (works the same on every engine); on the live site Chromium's offline mode is
// used, because WebKit's offline emulation fails navigations before the service worker can answer them.
if (server) { server.close(); server.closeAllConnections() }
else if (BROWSER === 'chromium') await ctx.setOffline(true);
if (server || BROWSER === 'chromium') {
  await page.reload();
  assert.equal(await page.title(), 'دفتر نوبت مژگان');
  sameBookings(await state(), 'offline');
  await page.goto(BASE + 'melika/');
  assert.equal(await page.title(), 'دفتر نوبت ملیکا');
  assert.ok(await page.evaluate(k => !!localStorage.getItem(k), MKEY), "Melika's data offline");
  console.log('4 ok: both apps open offline');
} else console.log('4 skipped: offline on the live site is checked with chromium');

await browser.close();
if (problems.length) { console.error('PROBLEMS:\n' + problems.join('\n')); process.exit(1) }
console.log(`deploy ok (${label})`);
