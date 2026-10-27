// Shared by the browser tests: which engine and which phone to emulate.
//   --browser=chromium|webkit   (webkit stands in for Safari on iPhone)       default chromium
//   --width=390|412             (390 = iPhone, 412 = Android; any width works) default 390
import {join} from 'node:path';
import {execSync} from 'node:child_process';

const arg = (name, def) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.split('=')[1] : def };
export const BROWSER = arg('browser', 'chromium');
export const WIDTH = +arg('width', '390');
const HEIGHTS = {390: 844, 412: 915};

let m;
try { m = await import('playwright') } catch { m = await import(join(execSync('npm root -g').toString().trim(), 'playwright', 'index.js')) }
export const engine = m[BROWSER] || (m.default && m.default[BROWSER]);
if (!engine || !['chromium', 'webkit'].includes(BROWSER)) throw new Error('unknown --browser: ' + BROWSER);

// a phone: touch screen, mobile viewport (2x pixels keeps screenshots small)
export const phone = {viewport: {width: WIDTH, height: HEIGHTS[WIDTH] || 844}, deviceScaleFactor: 2, hasTouch: true, isMobile: true};
export const label = `${BROWSER} ${WIDTH}px`;

// every page.click(selector) in the tests becomes a finger tap, as on the phone
export function touch(page) { page.click = (sel, opts) => page.tap(sel, opts); return page }
