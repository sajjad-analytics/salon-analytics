// Receiver for the weekly automatic backup of دفتر نوبت مژگان.
// Runs as a Google Apps Script web app in Sajjad's Google account; each backup becomes one JSON file
// in the Drive folder «daftar-backups». The file is the app state itself: restore it from ☰ → «انتخاب فایل پشتیبان».
// Deploy: script.google.com → New project → paste this file → Deploy → New deployment → Web app,
//         Execute as: Me, Who has access: Anyone → copy the /exec URL into AUTO_BACKUP_URL in docs/index.html.
// The token is not a secret (the app's code is public); it only keeps random requests out.
// Tested by tests/backup.test.mjs (handle() with fake Drive).
var TOKEN = '1b7Lk3UTGo5BbUox';
var APPS = ['mojgan'];
var FOLDER = 'daftar-backups';
var MAX_BYTES = 5000000;

function handle(body, now) {
  if (!body) return {ok: false, err: 'empty'};
  if (body.length > MAX_BYTES) return {ok: false, err: 'size'};
  var p;
  try { p = JSON.parse(body) } catch (e) { return {ok: false, err: 'json'} }
  if (!p || p.kind !== 'daftar-backup') return {ok: false, err: 'kind'};
  if (p.token !== TOKEN) return {ok: false, err: 'token'};
  if (APPS.indexOf(p.app) < 0) return {ok: false, err: 'app'};
  if (!p.data || !Array.isArray(p.data.bookings)) return {ok: false, err: 'data'};
  var it = DriveApp.getFoldersByName(FOLDER);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER);
  var name = 'daftar-' + p.app + '-' + Utilities.formatDate(now, 'Asia/Tehran', 'yyyy-MM-dd_HHmm') + '.json';
  folder.createFile(name, JSON.stringify(p.data), 'application/json');
  return {ok: true, name: name};
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function doPost(e) {
  var r;
  try { r = handle(e && e.postData && e.postData.contents, new Date()) } catch (err) { r = {ok: false, err: 'drive'} }
  return json(r);
}
function doGet() { return json({ok: true, ping: 'daftar-backup'}) }
