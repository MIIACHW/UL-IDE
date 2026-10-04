// UL-IDE launcher — the entry point behind 启动IDE.bat.
// Division of responsibility:
//   server.js  — the ONLY port manager (UL_IDE_PORT → 8899, auto-increment when busy);
//                writes .runtime/instance.json once listening; never opens a browser.
//   launch.mjs — instance discovery + /api/health polling + opening the REAL url.
// Identification rule: only a /api/health response with service === "UL-IDE" counts
// as a running IDE. PID liveness, file existence or "some HTTP response" on a port
// is never trusted — a stale file or a foreign service must not be mistaken for us.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const IDE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(IDE_ROOT, 'server.js');
const RUNTIME_DIR = path.join(IDE_ROOT, '.runtime');
const INSTANCE_FILE = path.join(RUNTIME_DIR, 'instance.json');
const START_TIMEOUT_MS = 20000;

const log = (...a) => console.log('[ul-ide]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET /api/health — resolves to the parsed body only when it identifies as UL-IDE,
// null on transport errors, non-JSON bodies, or any other service.
function fetchHealth(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.get({ host, port, path: '/api/health', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 64 * 1024) res.destroy(); });
      res.on('end', () => {
        try { const j = JSON.parse(body); finish(j && j.service === 'UL-IDE' ? j : null); }
        catch { finish(null); }
      });
      res.on('error', () => finish(null));
    });
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.on('error', () => finish(null));
  });
}

// .runtime/instance.json is a HINT, never proof. Returns the parsed object, or null
// when the file is missing, unparseable, or has an unusable shape.
export function readInstance() {
  let raw; try { raw = fs.readFileSync(INSTANCE_FILE, 'utf8'); } catch { return null; }
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return null;
    if (!Number.isInteger(j.port) || j.port < 1 || j.port > 65535) return null;
    if (typeof j.host !== 'string' || !j.host) j.host = '127.0.0.1';
    return j;
  } catch { return null; }
}

function removeStaleRuntime() {
  try { fs.rmSync(INSTANCE_FILE, { force: true }); fs.rmdirSync(RUNTIME_DIR); } catch { /* already gone / not empty */ }
}

// Decide whether the instance file describes a live UL-IDE. Anything else — missing
// file, dead server, foreign service on the port, garbage or shape-invalid file — is
// treated as not-running; unusable files are removed so the fresh start owns the record.
export async function checkExistingInstance() {
  const inst = readInstance();
  if (!inst) {
    if (fs.existsSync(INSTANCE_FILE)) { // present but unusable (garbage / bad shape) → stale
      removeStaleRuntime();
      return { running: false, stale: true, stalePort: null };
    }
    return { running: false };
  }
  const health = await fetchHealth(inst.host, inst.port, 1500);
  if (health) {
    const host = health.host || inst.host || '127.0.0.1';
    const port = Number.isInteger(health.port) ? health.port : inst.port;
    return { running: true, url: `http://${host}:${port}`, health };
  }
  removeStaleRuntime();
  return { running: false, stale: true, stalePort: inst.port };
}

export function openBrowser(url) {
  if (process.env.UL_NO_BROWSER === '1') { log('UL_NO_BROWSER=1 — skipping browser. IDE is at: ' + url); return; }
  const opts = { stdio: 'ignore' };
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], opts).unref();
  else if (process.platform === 'darwin') spawn('open', [url], opts).unref();
  else spawn('xdg-open', [url], opts).unref();
}

async function main() {
  // 1. reuse a healthy instance instead of starting a second server
  const existing = await checkExistingInstance();
  if (existing.running) {
    log(`UL-IDE already running (pid ${existing.health.pid}) at ${existing.url} — opening it instead of starting a second server.`);
    openBrowser(existing.url);
    return 0;
  }
  if (existing.stale) log(`stale instance file (nothing answering /api/health on port ${existing.stalePort}) — removed.`);

  // 2. start the server; it picks the port itself and declares it in instance.json
  log('starting node server.js ...');
  const child = spawn(process.execPath, [SERVER], { cwd: IDE_ROOT, env: process.env, stdio: 'inherit' });
  const startedAt = Date.now();

  for (;;) {
    if (child.exitCode !== null) {
      console.error(`[ul-ide] server exited (code ${child.exitCode}) before /api/health answered. See the log above.`);
      return child.exitCode || 1;
    }
    // 3. discover the candidate port from the instance file — never guessed here
    const inst = readInstance();
    if (inst) {
      // 4. confirm via /api/health; the REAL port comes from the health response
      const health = await fetchHealth(inst.host, inst.port, 1200);
      if (health && health.pid === child.pid) {
        const url = `http://${health.host || '127.0.0.1'}:${health.port}`;
        log(`UL-IDE is up at ${url} (pid ${health.pid}, v${health.version}).`);
        openBrowser(url);
        // keep the console (and its log output) open until the server stops
        const keepAlive = setInterval(() => {}, 60000);
        child.on('exit', (code, signal) => { clearInterval(keepAlive); process.exit(signal ? 1 : (code ?? 0)); });
        return 0;
      }
    }
    if (Date.now() - startedAt > START_TIMEOUT_MS) {
      console.error(`[ul-ide] timed out after ${START_TIMEOUT_MS / 1000}s waiting for /api/health — killing the server. Check the log above (port conflicts, firewall, startup errors).`);
      try { child.kill(); } catch { /* already gone */ }
      return 1;
    }
    await sleep(300);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // Ctrl+C / console close reach both processes (same console); just exit cleanly.
  for (const sig of process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try { process.on(sig, () => process.exit(0)); } catch { /* unsupported signal */ }
  }
  main().then(
    (code) => { process.exitCode = code || 0; },
    (e) => { console.error('[ul-ide] launcher failed: ' + (e && e.stack || e)); process.exit(1); },
  );
}
