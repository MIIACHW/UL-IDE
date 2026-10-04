// Startup & instance-discovery tests (run: node test/startup.test.js, or npm test)
// Spawns real `node server.js` / `node launch.mjs` processes on 127.0.0.1 — no mocks
// for the transport layer. Contract under test:
//   - server.js owns port selection (UL_IDE_PORT → 8899, auto-increment when busy)
//   - /api/health identifies the service (service === "UL-IDE")
//   - .runtime/instance.json mirrors the real listening port
//   - stale / foreign instance files are never trusted (verified via /api/health)
//   - the launcher reuses a healthy instance and never guesses a port
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IDE_ROOT = path.resolve(HERE, '..');
const SERVER = path.join(IDE_ROOT, 'server.js');
const LAUNCHER = path.join(IDE_ROOT, 'launch.mjs');
const RUNTIME_DIR = path.join(IDE_ROOT, '.runtime');
const INSTANCE_FILE = path.join(RUNTIME_DIR, 'instance.json');

let passed = 0, failed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; failures.push({ name, e }); console.error('  ✗ ' + name + '\n      ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'eq') + ` — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('Undead Legacy Tech Tree IDE — startup tests');
console.log(`ide root: ${IDE_ROOT}`);

// ------------------------------------------------------------------ helpers
function httpRequest(host, port, reqPath, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.get({ host, port, path: reqPath, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 64 * 1024 * 1024) res.destroy(); });
      res.on('end', () => finish({ status: res.statusCode, body }));
      res.on('error', () => finish(null));
    });
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.on('error', () => finish(null));
  });
}
async function getHealth(port) {
  const res = await httpRequest('127.0.0.1', port, '/api/health');
  if (!res || res.status !== 200) return null;
  try { return JSON.parse(res.body); } catch { return null; }
}
async function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}
async function findFreePort(start = 9100) {
  for (let p = start; p < 20000; p++) if (await portFree(p)) return p;
  throw new Error('no free port found');
}
async function findConsecutiveFreePort(start = 9100) {
  for (let p = start; p < 19999; p++) if (await portFree(p) && await portFree(p + 1)) return p;
  throw new Error('no consecutive free ports found');
}
function readInstanceSafe() {
  try { return JSON.parse(fs.readFileSync(INSTANCE_FILE, 'utf8')); } catch { return null; }
}
function writeInstance(obj) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(INSTANCE_FILE, JSON.stringify(obj));
}
function removeRuntime() {
  try { fs.rmSync(INSTANCE_FILE, { force: true }); fs.rmdirSync(RUNTIME_DIR); } catch { /* gone */ }
}

const children = new Set(); // every process we spawn — killed by the final sweep
function spawnNode(arg, env = {}) {
  const full = { ...process.env };
  // never let ambient UL_IDE_PORT / UL_NO_BROWSER leak into a test's expectation
  if ('UL_IDE_PORT' in env) full.UL_IDE_PORT = env.UL_IDE_PORT; else delete full.UL_IDE_PORT;
  if ('UL_NO_BROWSER' in env) full.UL_NO_BROWSER = env.UL_NO_BROWSER; else delete full.UL_NO_BROWSER;
  const child = spawn(process.execPath, arg, { cwd: IDE_ROOT, env: full, stdio: ['ignore', 'pipe', 'pipe'] });
  child.__out = [];
  child.stdout.on('data', (c) => child.__out.push(c));
  child.stderr.on('data', (c) => child.__out.push(c));
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}
function output(child) { return Buffer.concat(child.__out).toString('utf8'); }
async function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((res) => { child.once('exit', res); child.kill(); });
}
function waitExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve();
    const t = setTimeout(() => reject(new Error('process did not exit in time. Output:\n' + output(child))), timeoutMs);
    child.once('exit', () => { clearTimeout(t); resolve(); });
  });
}
// wait until the server declared its port in instance.json AND /api/health confirms it
async function waitHealthy(child, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited before becoming healthy. Output:\n' + output(child));
    const inst = readInstanceSafe();
    if (inst && Number.isInteger(inst.port)) {
      const health = await getHealth(inst.port);
      if (health && health.service === 'UL-IDE') return { health, inst };
    }
    await sleep(250);
  }
  throw new Error('server did not become healthy within ' + timeoutMs + 'ms');
}

// ------------------------------------------------------------------ tests
async function main() {
  const is8899Free = await portFree(8899);

  await test('default port 8899 + /api/health contract + instance.json mirrors it', async () => {
    removeRuntime();
    const child = spawnNode(['server.js']);
    try {
      const { health, inst } = await waitHealthy(child);
      if (is8899Free) eq(health.port, 8899, 'default preferred port');
      else {
        console.log('      (note: 8899 is busy on this machine — asserting an incremented port instead)');
        assert(Number.isInteger(health.port) && health.port > 8899, 'incremented port ' + health.port);
      }
      eq(health.ok, true, 'health.ok');
      eq(health.service, 'UL-IDE', 'health.service');
      eq(health.host, '127.0.0.1', 'health.host');
      eq(health.pid, child.pid, 'health.pid is the server process');
      assert(typeof health.version === 'string' && health.version.length > 0, 'health.version present');
      assert(inst, 'instance file written on listen');
      eq(inst.port, health.port, 'instance.port === real listening port');
      eq(inst.pid, child.pid, 'instance.pid');
      eq(inst.host, '127.0.0.1', 'instance.host');
      eq(inst.url, `http://127.0.0.1:${health.port}`, 'instance.url');
      assert(!Number.isNaN(Date.parse(inst.startedAt)), 'instance.startedAt parses as a date');
    } finally { await killChild(child); removeRuntime(); }
  });

  await test('/api/defaults reports the resolved modsDir (+ detection source)', async () => {
    removeRuntime();
    const p = await findFreePort();
    const child = spawnNode(['server.js'], { UL_IDE_PORT: String(p) });
    try {
      const { health } = await waitHealthy(child);
      const res = await httpRequest('127.0.0.1', health.port, '/api/defaults', 60000);
      assert(res && res.status === 200, '/api/defaults reachable');
      const d = JSON.parse(res.body);
      assert(typeof d.modsDir === 'string' && d.modsDir.length > 0, 'modsDir present: ' + JSON.stringify(d.modsDir));
      assert(typeof d.modsDirSource === 'string' && d.modsDirSource.length > 0, 'modsDirSource present');
      eq(d.modsDir, path.resolve(IDE_ROOT, '..'), 'defaults to the folder containing the IDE');
      eq(d.ok, true, 'scan ok on this machine');
      assert(Array.isArray(d.mods) && d.mods.length > 0, 'mods found in the detected folder');
    } finally { await killChild(child); removeRuntime(); }
  });

  await test('UL_IDE_PORT really controls the preferred port', async () => {
    removeRuntime();
    const p = await findFreePort();
    const child = spawnNode(['server.js'], { UL_IDE_PORT: String(p) });
    try {
      const { health } = await waitHealthy(child);
      eq(health.port, p, 'server listens on UL_IDE_PORT');
    } finally { await killChild(child); removeRuntime(); }
  });

  await test('occupied preferred port → server moves to the next free port (instance file follows)', async () => {
    removeRuntime();
    const p = await findConsecutiveFreePort();
    const blocker = net.createServer();
    await new Promise((res, rej) => { blocker.once('error', rej); blocker.listen(p, '127.0.0.1', res); });
    const child = spawnNode(['server.js'], { UL_IDE_PORT: String(p) });
    try {
      const { health, inst } = await waitHealthy(child);
      assert(health.port > p, `port ${p} occupied → actual port ${health.port} must be higher`);
      eq(inst.port, health.port, 'instance file tracks the moved port');
      eq(health.service, 'UL-IDE', 'still identifies as UL-IDE');
    } finally { await killChild(child); await new Promise((res) => blocker.close(res)); removeRuntime(); }
  });

  const launcher = await import(pathToFileURL(LAUNCHER).href); // module main is guarded — safe to import

  await test('stale instance file is not trusted and gets removed', async () => {
    // dead port
    const dead = await findFreePort();
    writeInstance({ pid: 999999999, host: '127.0.0.1', port: dead, url: `http://127.0.0.1:${dead}`, startedAt: new Date().toISOString() });
    const r1 = await launcher.checkExistingInstance();
    eq(r1.running, false, 'dead port not reported running');
    assert(!fs.existsSync(INSTANCE_FILE), 'stale file removed after dead-port check');
    // garbage file
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(INSTANCE_FILE, '{not json at all');
    const r2 = await launcher.checkExistingInstance();
    eq(r2.running, false, 'garbage file not reported running');
    assert(!fs.existsSync(INSTANCE_FILE), 'garbage file removed');
    // unusable shape
    writeInstance({ pid: 1, port: 'not-a-port' });
    const r3 = await launcher.checkExistingInstance();
    eq(r3.running, false, 'shape-invalid file not reported running');
    assert(!fs.existsSync(INSTANCE_FILE), 'shape-invalid file removed');
  });

  await test('a foreign HTTP service is never mistaken for UL-IDE', async () => {
    // JSON responder with a wrong service name
    const p1 = await findFreePort();
    const foreign1 = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, service: 'NotUL-IDE', pid: process.pid, port: p1 })); });
    await new Promise((res, rej) => { foreign1.once('error', rej); foreign1.listen(p1, '127.0.0.1', res); });
    try {
      writeInstance({ pid: process.pid, host: '127.0.0.1', port: p1, url: `http://127.0.0.1:${p1}` });
      const r = await launcher.checkExistingInstance();
      eq(r.running, false, 'wrong service name is not UL-IDE');
      assert(!fs.existsSync(INSTANCE_FILE), 'instance file for a foreign service removed');
    } finally { await new Promise((res) => foreign1.close(res)); }
    // plain non-JSON responder
    const p2 = await findFreePort();
    const foreign2 = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><body>hello</body></html>'); });
    await new Promise((res, rej) => { foreign2.once('error', rej); foreign2.listen(p2, '127.0.0.1', res); });
    try {
      writeInstance({ pid: process.pid, host: '127.0.0.1', port: p2, url: `http://127.0.0.1:${p2}` });
      const r = await launcher.checkExistingInstance();
      eq(r.running, false, 'non-JSON responder is not UL-IDE');
      assert(!fs.existsSync(INSTANCE_FILE), 'instance file for a foreign service removed');
    } finally { await new Promise((res) => foreign2.close(res)); }
  });

  await test('launcher reuses a healthy instance instead of starting a second server', async () => {
    removeRuntime();
    const p = await findFreePort();
    const server = spawnNode(['server.js'], { UL_IDE_PORT: String(p) });
    try {
      const { health } = await waitHealthy(server);
      const pidBefore = readInstanceSafe().pid;
      const launcherProc = spawnNode(['launch.mjs'], { UL_NO_BROWSER: '1' });
      await waitExit(launcherProc, 15000);
      eq(launcherProc.exitCode, 0, 'launcher exits 0 on reuse');
      const out = output(launcherProc);
      assert(out.includes('already running'), 'launcher reports the existing instance');
      assert(!out.includes('starting node server.js'), 'launcher did NOT start a second server');
      assert(out.includes(`http://127.0.0.1:${health.port}`), 'launcher names the real URL');
      eq(readInstanceSafe().pid, pidBefore, 'instance file untouched by the reuse path');
      assert(await getHealth(p), 'original instance still healthy afterwards');
    } finally { await killChild(server); removeRuntime(); }
  });

  await test('launcher start path: waits for /api/health, opens the REAL url', async () => {
    removeRuntime();
    const p = await findFreePort();
    const launcherProc = spawnNode(['launch.mjs'], { UL_IDE_PORT: String(p), UL_NO_BROWSER: '1' });
    try {
      const deadline = Date.now() + 25000;
      let upUrl = null;
      while (Date.now() < deadline && !upUrl) {
        const m = /UL-IDE is up at (http:\/\/[^\s)]+)/.exec(output(launcherProc));
        if (m) upUrl = m[1]; else await sleep(300);
      }
      assert(upUrl, 'launcher reported the real URL. Output:\n' + output(launcherProc));
      const upPort = Number(new URL(upUrl).port);
      const health = await getHealth(upPort);
      assert(health && health.service === 'UL-IDE', 'reported URL serves UL-IDE health');
      eq(health.port, p, 'UL_IDE_PORT passed through the launcher to the server');
      eq(health.pid, readInstanceSafe().pid, 'instance file belongs to the started server');
      // stop the server behind the launcher; the launcher exits when its child does
      try { process.kill(health.pid); } catch { /* already gone */ }
      await waitExit(launcherProc, 10000);
    } finally {
      // if the test failed early the launcher may still own a server — stop it by its instance record
      try { const inst = readInstanceSafe(); if (inst && Number.isInteger(inst.pid) && inst.pid > 0) process.kill(inst.pid); } catch { /* gone */ }
      await killChild(launcherProc); removeRuntime();
    }
  });

  await test('server.js does not open a browser (that is the launcher\'s job)', async () => {
    const src = fs.readFileSync(SERVER, 'utf8');
    assert(!/[^.\w]exec\(/.test(src), 'no child_process exec() browser spawn');
    assert(!src.includes('xdg-open'), 'no xdg-open');
    assert(!src.includes("open '") && !src.includes('open "'), 'no direct open call');
    assert(!src.includes('openBrowser'), 'no openBrowser helper left behind');
  });
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) {
      for (const f of failures) console.error('FAILED: ' + f.name + '\n' + (f.e.stack || f.e.message));
      process.exitCode = 1;
    }
  })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    for (const c of [...children]) { try { c.kill(); } catch { /* gone */ } }
    await sleep(500);
    for (const c of [...children]) { try { await killChild(c); } catch { /* gone */ } }
    removeRuntime();
  });
