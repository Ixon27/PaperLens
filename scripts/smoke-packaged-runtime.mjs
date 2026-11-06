// Run with the packaged executable in ELECTRON_RUN_AS_NODE mode, never the host's Node:
//   macOS:   ELECTRON_RUN_AS_NODE=1 "PaperLens.app/Contents/MacOS/PaperLens" scripts/smoke-packaged-runtime.mjs
//   Windows: ELECTRON_RUN_AS_NODE=1 "win-unpacked/PaperLens.exe" scripts/smoke-packaged-runtime.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

assert.ok(process.versions.electron, 'Use the packaged Electron executable');
const isMac = process.platform === 'darwin';
// The packaged app's resources sit next to the executable running this script.
const resources = isMac ? join(dirname(process.execPath), '..', 'Resources') : join(dirname(process.execPath), 'resources');
const root = join(resources, 'app.asar');
const require = createRequire(join(root, 'package.json'));
const db = new DatabaseSync(':memory:');
try {
  db.exec("CREATE VIRTUAL TABLE papers USING fts5(title); INSERT INTO papers VALUES('Portable paper reader')");
  assert.equal(db.prepare("SELECT title FROM papers WHERE papers MATCH 'portable'").get().title, 'Portable paper reader');
} finally {
  db.close();
}

const { createCanvas } = require('@napi-rs/canvas');
const ctx = createCanvas(1, 1).getContext('2d');
ctx.fillStyle = '#2a64c8';
ctx.fillRect(0, 0, 1, 1);
assert.deepEqual([...ctx.getImageData(0, 0, 1, 1).data], [42, 100, 200, 255]);

// Generated public-domain fixture: actual PDF parsing, worker loading and native-addon resolution.
const stream = 'BT /F1 12 Tf 72 720 Td (Paper Reader) Tj ET';
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
];
let source = '%PDF-1.4\n';
const offsets = [];
for (let i = 0; i < objects.length; i++) {
  offsets.push(Buffer.byteLength(source));
  source += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
}
const xref = Buffer.byteLength(source);
source += `xref\n0 6\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const { getDocument } = await import(pathToFileURL(join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
const loading = getDocument({ data: new TextEncoder().encode(source), useSystemFonts: true, isEvalSupported: false });
try {
  const pdf = await loading.promise;
  assert.equal(pdf.numPages, 1);
  const page = await pdf.getPage(1);
  const text = await page.getTextContent();
  assert.deepEqual(text.items.filter(item => 'str' in item).map(item => item.str), ['Paper Reader']);
} finally {
  await loading.destroy();
}
console.log(JSON.stringify({ electron: process.versions.electron, node: process.versions.node, arch: process.arch, sqliteFts: 'ok', nativeCanvas: 'ok', pdfText: 'Paper Reader' }));

// Regression: PDF.js treats Electron utility processes differently from plain Node.
// Exercise the actual packaged window, authenticated backend and PDF viewer as a new user.
const home = mkdtempSync(join(tmpdir(), 'paper-reader-release-'));
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const debugPort = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const env = { ...process.env, HOME: home, PAPER_READER_USER_DATA: join(home, 'data'), PAPER_READER_DEBUG_PORT: String(debugPort) };
// macOS: no developer tools on PATH, as when the app starts from Finder.
if (isMac) env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'PAPER_READER_DB_DIR', 'PAPER_READER_FILES', 'PAPER_READER_VAULT']) delete env[key];
const child = spawn(process.execPath, [], { cwd: home, env, stdio: 'ignore' });
const exited = once(child, 'exit');
let socket;
const commands = new Map();
let commandId = 0;

async function within(promise) {
  const timeout = Promise.withResolvers();
  const timer = setTimeout(() => timeout.reject(new Error('Packaged app smoke timed out')), 30_000);
  try { return await Promise.race([promise, timeout.promise]); }
  finally { clearTimeout(timer); }
}

async function until(read) {
  const end = Date.now() + 30_000;
  let lastError;
  do {
    if (child.exitCode !== null) throw new Error(`App exited early (${child.exitCode})`);
    try { const value = await read(); if (value) return value; }
    catch (error) { lastError = error; }
    await delay(100);
  } while (Date.now() < end);
  throw new Error('Packaged app did not become ready', { cause: lastError });
}

async function evaluate(expression) {
  const id = ++commandId;
  const result = Promise.withResolvers();
  commands.set(id, result);
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  try {
    const reply = await within(result.promise);
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
    return reply.result.value;
  } finally { commands.delete(id); }
}

try {
  const target = await until(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    return targets.find(target => target.type === 'page' && target.url.startsWith('http://127.0.0.1:'));
  });
  socket = new WebSocket(target.webSocketDebuggerUrl);
  const opened = Promise.withResolvers();
  socket.addEventListener('open', () => opened.resolve(), { once: true });
  socket.addEventListener('error', error => opened.reject(error), { once: true });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    const command = commands.get(message.id);
    if (message.error) command?.reject(new Error(message.error.message));
    else command?.resolve(message.result);
  });
  await within(opened.promise);
  await until(() => evaluate('typeof window.paperReaderDesktop?.getInfo === \"function\"'));
  const result = await evaluate(`(async () => {
    const form = new FormData();
    form.append('file', new File([new TextEncoder().encode(${JSON.stringify(source)})], 'portable.pdf', { type: 'application/pdf' }));
    const [upload] = await (await fetch('/api/papers/upload', { method: 'POST', body: form })).json();
    if (upload.error) throw new Error(upload.error);
    const paper = await (await fetch('/api/papers/' + upload.paperId)).json();
    const blocks = await (await fetch('/api/papers/' + upload.paperId + '/blocks')).json();
    return { id: upload.paperId, pages: paper.pageCount, blocks: blocks.map(b => b.text), info: await window.paperReaderDesktop.getInfo(), nodeAccess: typeof window.require };
  })()`);
  assert.equal(result.pages, 1);
  assert.deepEqual(result.blocks, ['Paper Reader']);
  assert.equal(result.nodeAccess, 'undefined');
  assert.equal(result.info.dataDir, join(home, 'data'));
  assert.equal((await fetch(new URL('/api/settings', target.url))).status, 401);
  await evaluate(`location.href = '/paper/${result.id}'; true`);
  await until(() => evaluate('document.querySelector(\"canvas\")?.width > 0 && document.querySelector(\".textLayer\")?.textContent.trim() === \"Paper Reader\"'));
  if (isMac) {
    socket.close();
    execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
      `ObjC.import('AppKit'); if (!$.NSRunningApplication.runningApplicationWithProcessIdentifier(${child.pid}).terminate) throw new Error('Could not quit smoke app');`]);
  } else {
    // Windows: closing the only window quits the app, as when a user closes it.
    socket.send(JSON.stringify({ id: ++commandId, method: 'Runtime.evaluate', params: { expression: 'window.close()' } }));
  }
  const [code] = await within(exited);
  assert.equal(code, 0);
  await assert.rejects(() => fetch(new URL('/api/settings', target.url)));
  console.log(JSON.stringify({ packagedUpload: 'Paper Reader', pdfViewer: 'rendered', freshUser: true, nativeQuit: 'backend stopped' }));
} catch (error) {
  const logFile = isMac ? join(home, 'Library/Logs/paper-reader/desktop.log') : join(process.env.APPDATA ?? '', 'paper-reader', 'logs', 'desktop.log');
  try { console.error(readFileSync(logFile, 'utf8')); } catch {}
  throw error;
} finally {
  socket?.close();
  if (child.exitCode === null) { child.kill('SIGTERM'); await within(exited); }
  rmSync(home, { recursive: true, force: true });
}
