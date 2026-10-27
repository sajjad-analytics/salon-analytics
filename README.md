# دفتر نوبت (salon-analytics)

اپ گوشی (PWA) آفلاین برای ثبت نوبت‌های یک متخصص پدیکور، به‌جای دفتر کاغذی.

- **آدرس اپ مژگان:** https://sajjad-analytics.github.io/salon-analytics/
- **آدرس اپ ملیکا:** https://sajjad-analytics.github.io/salon-analytics/melika/
- **پیش‌نمایش (داده‌ی جدا، برای آزمایش):** https://sajjad-analytics.github.io/salon-analytics/preview/
- همه‌ی داده‌ها فقط روی گوشی است (`localStorage`؛ کلید مژگان `daftar-mojgan-v1`، کلید ملیکا `daftar-melika-v1`). این ریپو عمومی است: **هیچ داده‌ی مشتری، پشتیبان یا فهرستی وارد آن نمی‌شود** (`.gitignore` و `tests/repo.test.mjs` جلویش را می‌گیرند؛ داده‌ی آزمون فقط ساختگی و در `tests/fixtures/`).

## چه چیزی کجاست

| مسیر | چیست |
|---|---|
| `docs/` | همه‌ی آن‌چه منتشر می‌شود (GitHub Pages از پوشه‌ی `docs/`) |
| `docs/index.html` | کل اپ در یک فایل (HTML + CSS + JS) |
| `docs/sw.js` | service worker: کار آفلاین. نام کش `daftar-vN` |
| `docs/manifest.webmanifest`، `docs/icons/`، `docs/fonts/` | نصب روی صفحه‌ی گوشی، آیکون‌ها، فونت Vazirmatn (OFL) |
| `docs/melika/` | اپ ملیکا: همان کد با خدمت‌ها، منبع‌ها، کلید، manifest و service worker خودش؛ ساخته‌ی `node tools/build_melika.mjs` — **دستی ویرایش نشود** |
| `docs/preview/` | کپی پیش‌نمایش با کلید ذخیره و worker جدا؛ ساخته‌ی `node tools/build_preview.mjs` — **دستی ویرایش نشود** |
| `docs/README.md` | شرح کاربردی اپ و پایلوت پیامکی |
| `tools/` | `build_melika.mjs` (ساخت اپ ملیکا)، `build_preview.mjs` (ساخت پیش‌نمایش)، `verify_allocation.py` (بازتولید قرعه‌ی پایلوت) |
| `tests/` | تست‌ها (پایین‌تر) و `fixtures/` ساختگی |
| `screenshots/` | تصویرهای آخرین آزمون مرورگر |
| `.github/workflows/` | تست خودکار (CI) و بررسی آدرس زنده |

## قیدهایی که هرگز نباید شکسته شوند

اپ روی گوشی مژگان و ملیکا نصب است و داده‌ی هر کدام به همین آدرس‌ها بسته است. پس:

1. **آدرس** همین بماند: نام ریپو، نام کاربری و مسیر `docs/` عوض نشود (داده‌ی `localStorage` به دامنه بسته است).
2. **کلیدهای ذخیره** عوض نشوند: `daftar-mojgan-v1` در `docs/index.html` و `daftar-melika-v1` در `tools/build_melika.mjs`.
3. **service worker** همان `docs/sw.js` بماند و نسبی ثبت شود (`register('sw.js')`)، تا دامنه‌اش `/salon-analytics/` بماند.
4. نام کش‌ها: `daftar-vN` برای اپ مژگان (فقط بالا می‌رود)، `daftar-melika-…` و `daftar-preview-…` برای ملیکا و پیش‌نمایش. worker مژگان به `/melika/` و `/preview/` جواب نمی‌دهد و کش آن‌ها را پاک نمی‌کند.

این‌ها در `tests/repo.test.mjs` و `tests/deploy.mjs` آزموده می‌شوند.

## هر تغییر در `docs/index.html`

1. شاخه‌ی جدا؛ اول تست (قرمز)، بعد کد (سبز).
2. کش را یک واحد بالا ببر: `const CACHE = 'daftar-vN';` در `docs/sw.js`.
3. اپ ملیکا و پیش‌نمایش را دوباره بساز: `node tools/build_melika.mjs` و `node tools/build_preview.mjs` (ملیکا کش خودش را خودکار عوض می‌کند).
4. PR به `main`. CI باید سبز شود؛ ادغام فقط با سجاد.

## تست‌ها

همه روی GitHub Actions با هر push و PR اجرا می‌شوند (`.github/workflows/ci.yml`)؛ روی کامپیوتر نصب چیزی لازم نیست.

| دستور | چه می‌آزماید |
|---|---|
| `node --test tests/*.test.mjs` | منطق پایلوت + قرارداد ریپو (کلید، کش، دامنه‌ی worker، نبود داده‌ی مشتری) |
| `node tests/e2e.mjs --browser=chromium --width=390 --shots` | اپ در مرورگر واقعی، گوشی لمسی: پشتیبان قدیمی، پایلوت کامل، فرم نوبت، پیش‌نمایش جدا |
| `node tests/deploy.mjs --browser=webkit --width=412` | اپ زیر مسیر `/salon-analytics/` با service worker واقعی: دامنه، کش، داده‌ی قبلی، بازگردانی `tests/fixtures/backup-v1.json`، اپ ملیکا در `melika/` با worker و داده‌ی جدا، هر دو آفلاین |
| `node tests/deploy.mjs --url=https://sajjad-analytics.github.io/salon-analytics/` | همان، روی آدرس زنده؛ اول همه‌ی فایل‌ها را بایت‌به‌بایت با `docs/` مقایسه می‌کند |
| `node tools/build_preview.mjs`، `node tools/build_melika.mjs` و بعد `git diff --exit-code` | پیش‌نمایش و اپ ملیکا با اپ اصلی هم‌خوان‌اند |

CI این‌ها را روی **Chromium** (کروم اندروید) و **WebKit** (Safari آیفون)، در عرض **۳۹۰** (آیفون) و **۴۱۲** (اندروید) اجرا می‌کند و اسکرین‌شات‌ها را به‌صورت artifact نگه می‌دارد. گردش‌کار «Live site» (`.github/workflows/live.yml`) بعد از هر انتشار Pages، و با دکمه‌ی Run workflow، آدرس زنده را می‌آزماید.

## ابزارهای بعدی (مثلاً `docs/nabz/`)

هر ابزار تازه یک پوشه زیر `docs/` می‌گیرد، مثلاً `docs/nabz/` ← `https://sajjad-analytics.github.io/salon-analytics/nabz/`. (هنوز ساخته نشده.)

مهم: `docs/sw.js` همه‌ی درخواست‌های زیر `/salon-analytics/` را جواب می‌دهد، جز `/preview/` و `/melika/`. ابزار تازه پیش از انتشار باید (مثل `docs/melika/`):

- در `docs/sw.js` مثل `/melika/` مستثنا شود (هم در fetch و هم در پاک کردن کش‌ها) (و کش اپ یک واحد بالا برود)، وگرنه گوشی مژگان به‌جای آن ابزار، دفتر نوبت را نشان می‌دهد؛
- کلید `localStorage`، manifest و (اگر لازم است) service worker خودش را داشته باشد و هرگز به `daftar-mojgan-v1` دست نزند؛
- در `tests/deploy.mjs` آزمونی بگیرد که جدا بودنش را نشان دهد (مثل بخش D در `tests/e2e.mjs` برای پیش‌نمایش).

## شاخه‌ها

- `main`: کد اصلی و منبع انتشار (GitHub Pages ← `main` / `docs`).
- `pages`: منبع انتشار قبلی؛ تاریخچه‌اش کامل در `main` است. بعد از جابه‌جایی منبع Pages و سبز شدن «Live site» بازنشسته می‌شود.
- `feature/pilot`، `feature/pilot-preview`، `fix/pilot-xlsx-import`: محتوای هر کدام دقیقاً همان کامیت ادغام PRشان (۱ تا ۳) در تاریخچه‌ی `main` است؛ قابل حذف.
- `feature/source-required`، `claude/happy-brown-lg734n`: نوکشان خودش در تاریخچه‌ی `main` است (هیچ کامیت جدایی ندارند)؛ قابل حذف.
