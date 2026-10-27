// Repo contract: what must stay true so the app on Mojgan's phone keeps working with her data,
// and the repo layout / CI that guard it.  Run: node --test tests/*.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {execSync} from 'node:child_process';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');
const tracked = () => execSync('git ls-files', {cwd: ROOT}).toString().trim().split('\n');

// ---------- Mojgan's data and the installed app (never change these) ----------
test('storage key stays daftar-mojgan-v1', () => {
  assert.ok(read('docs/index.html').includes("const KEY='daftar-mojgan-v1';"));
});

test('worker is registered relative to the page, so its scope stays /salon-analytics/', () => {
  assert.ok(read('docs/index.html').includes("navigator.serviceWorker.register('sw.js')"));
  const m = JSON.parse(read('docs/manifest.webmanifest'));
  assert.equal(m.start_url, './'); assert.equal(m.scope, './');
});

test('cache name is daftar-vN with N >= 9 (never goes back)', () => {
  const m = read('docs/sw.js').match(/const CACHE = 'daftar-v(\d+)';/);
  assert.ok(m, 'CACHE line not found'); assert.ok(+m[1] >= 9, 'cache version went back: ' + m[1]);
});

test("Melika's app keeps its own key, worker and link, and Mojgan's worker never answers for it", () => {
  const h = read('docs/melika/index.html');
  assert.ok(h.includes("const KEY='daftar-melika-v1';") && !h.includes('daftar-mojgan-v1'));
  assert.ok(h.includes("navigator.serviceWorker.register('sw.js')"));
  assert.match(read('docs/melika/sw.js'), /const CACHE = 'daftar-melika-[0-9a-f]+';/);
  assert.ok(read('docs/sw.js').includes("url.pathname.includes('/melika/')"));
});

test('Pages serves docs/ as plain files (.nojekyll)', () => {
  assert.ok(existsSync(join(ROOT, 'docs/.nojekyll')));
});

// ---------- public repo: no customer data ----------
test('no real-looking phone number in any tracked text file', () => {
  const bad = [];
  for (const f of tracked()) {
    if (/\.(png|woff2|xlsx)$/.test(f)) continue;
    for (const n of read(f).match(/(?<!\d)(?:\+98|0)9\d{9}(?!\d)/g) || []) {
      const tail = n.slice(-7);
      // synthetic: mostly zeros (0912000xxxx) or mostly one repeated digit (09121111111, 09125555556)
      const most = Math.max(...[...'0123456789'].map(d => tail.split(d).length - 1));
      if ((tail.match(/0/g) || []).length < 4 && most < 5) bad.push(f + ': ' + n);
    }
  }
  assert.deepEqual(bad, [], 'synthetic numbers look like 0912000xxxx or 09121111111');
});

test('data files (backups, lists, exports) only as synthetic fixtures', () => {
  const bad = tracked().filter(f => /\.(json|csv|xlsx|xls)$/i.test(f) && !f.startsWith('tests/fixtures/'));
  assert.deepEqual(bad, []);
  assert.match(read('.gitignore'), /daftar-\*\.json/);
});

// ---------- layout ----------
test('root README says what is where and how it is tested', () => {
  const r = read('README.md');
  for (const s of ['https://sajjad-analytics.github.io/salon-analytics/', 'docs/index.html', 'docs/sw.js', 'docs/preview/',
    'docs/nabz/', 'docs/melika/', 'daftar-melika-v1', 'https://sajjad-analytics.github.io/salon-analytics/melika/', 'node tools/build_melika.mjs', 'node --test tests/*.test.mjs', 'node tests/e2e.mjs', 'node tests/deploy.mjs', 'node tools/build_preview.mjs', 'daftar-mojgan-v1'])
    assert.ok(r.includes(s), 'README is missing: ' + s);
});

// ---------- CI ----------
test('CI runs logic tests, preview sync, and the browser test on Chromium and WebKit at phone sizes', () => {
  const ci = read('.github/workflows/ci.yml');
  for (const s of ['pull_request', 'push', 'node --test tests/*.test.mjs', 'node tools/build_preview.mjs', 'node tools/build_melika.mjs', 'git diff --exit-code',
    'chromium', 'webkit', '390', '412', 'tests/e2e.mjs', 'tests/deploy.mjs', 'upload-artifact'])
    assert.ok(ci.includes(s), 'ci.yml is missing: ' + s);
});

test("deployment test covers Melika's app at its own address", () => {
  const d = read('tests/deploy.mjs');
  assert.ok(d.includes('melika/') && d.includes('daftar-melika-v1'));
});

test('a workflow checks the live address against docs/', () => {
  const w = read('.github/workflows/live.yml');
  for (const s of ['workflow_dispatch', 'page_build', 'https://sajjad-analytics.github.io/salon-analytics/', 'tests/deploy.mjs'])
    assert.ok(w.includes(s), 'live.yml is missing: ' + s);
});

test('browser tests take a browser and a phone width, on a touch screen', () => {
  const d = read('tests/device.mjs');
  assert.ok(d.includes('--browser') && d.includes('--width') && d.includes('hasTouch: true') && d.includes('webkit'));
  for (const f of ['tests/e2e.mjs', 'tests/deploy.mjs']) assert.ok(read(f).includes("from './device.mjs'"), f);
});
