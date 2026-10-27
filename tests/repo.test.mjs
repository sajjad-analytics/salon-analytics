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
      if ((tail.match(/0/g) || []).length < 4 && tail !== '9999999') bad.push(f + ': ' + n);
    }
  }
  assert.deepEqual(bad, [], 'synthetic numbers look like 0912000xxxx');
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
    'docs/nabz/', 'node --test tests/*.test.mjs', 'node tests/e2e.mjs', 'node tests/deploy.mjs', 'node tools/build_preview.mjs', 'daftar-mojgan-v1'])
    assert.ok(r.includes(s), 'README is missing: ' + s);
});

// ---------- CI ----------
test('CI runs logic tests, preview sync, and the browser test on Chromium and WebKit at phone sizes', () => {
  const ci = read('.github/workflows/ci.yml');
  for (const s of ['pull_request', 'push', 'node --test tests/*.test.mjs', 'node tools/build_preview.mjs', 'git diff --exit-code',
    'chromium', 'webkit', '390', '412', 'tests/e2e.mjs', 'tests/deploy.mjs', 'upload-artifact'])
    assert.ok(ci.includes(s), 'ci.yml is missing: ' + s);
});

test('a workflow checks the live address against docs/', () => {
  const w = read('.github/workflows/live.yml');
  for (const s of ['workflow_dispatch', 'page_build', 'https://sajjad-analytics.github.io/salon-analytics/', 'tests/deploy.mjs'])
    assert.ok(w.includes(s), 'live.yml is missing: ' + s);
});

test('browser tests take a browser and a phone width', () => {
  for (const f of ['tests/e2e.mjs', 'tests/deploy.mjs']) {
    const t = read(f);
    assert.ok(t.includes('--browser') && t.includes('--width') && t.includes('hasTouch'), f);
  }
});
