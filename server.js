// Undead Legacy / generic 7DTD tech-tree IDE — local server (zero dependencies).
// Lives anywhere (typically Mods/<anything>/ULTechTreeIDE). On scan it walks EVERY
// mod in the Mods folder and classifies tech-tree XMLs:
//   research-style    — files containing <research> elements (UL research unlocks)
//   progression-style — files containing vanilla-format <perk/skill/book/attribute>
// Read roots: every scanned mod + vanilla game Data. Write roots: scanned mods' Config/*.xml,
// always after backup. A user dictionary (dictionary.csv) supplies extra translations.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IDE_ROOT = __dirname;
const IDE_PARENT = path.resolve(__dirname, '..');
// Mods dir = the folder that contains the IDE folder, unless the IDE sits inside a
// single mod (that folder has ModInfo.xml) — then go one level higher.
const MODS_DIR = process.env.UL_MODS_DIR
  ? path.resolve(process.env.UL_MODS_DIR)
  : (fs.existsSync(path.join(IDE_PARENT, 'ModInfo.xml')) ? path.dirname(IDE_PARENT) : IDE_PARENT);
const VANILLA_CONFIG_ROOT = process.env.UL_VANILLA_CONFIG || 'E:\\STEAM\\steamapps\\common\\7 Days To Die\\Data\\Config';
const VANILLA_ROOT = path.resolve(VANILLA_CONFIG_ROOT, '..');
const BACKUP_DIR = path.join(IDE_ROOT, 'backups');
const EXPORT_DIR = path.join(IDE_ROOT, 'export');
const PORT = Number(process.env.UL_IDE_PORT || 8899);
const PUBLIC_DIR = path.join(IDE_ROOT, 'public');

// ---------------------------------------------------------------- helpers
function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}
function sendErr(res, status, message) { send(res, status, { ok: false, error: message }); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 64 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function normalizeInside(root, rel) {
  const abs = path.resolve(root, rel);
  const normRoot = path.resolve(root);
  if (abs !== normRoot && !abs.startsWith(normRoot + path.sep)) return null;
  return abs;
}
function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }

function detectBom(buf) {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return { bom: 'utf8', text: buf.slice(3).toString('utf8') };
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return { bom: 'utf16le', text: buf.slice(2).toString('utf16le') };
  return { bom: null, text: buf.toString('utf8') };
}

function listXmlFiles(rootDir, base) {
  const out = [];
  const walk = (dir) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.xml')) {
        const rel = path.relative(base, p).replace(/\\/g, '/');
        let st; try { st = fs.statSync(p); } catch { continue; }
        out.push({ path: rel, size: st.size, mtime: st.mtimeMs });
      }
    }
  };
  walk(rootDir);
  return out;
}

function classifyXml(text) {
  if (/<research\s/.test(text)) return 'research';
  if (/<(perk|skill|book_group|attribute)\s+[^>]*name="/.test(text)) return 'progression';
  return null;
}

// ---------------------------------------------------------------- scan
// iconChain is module scope: /api/icon resolves names through it after a scan.
const iconChain = {}; // name -> { icon?: string, extends?: string }

function scanMods(modsDir) {
  const mods = [];
  let entries; try { entries = fs.readdirSync(modsDir, { withFileTypes: true }); } catch (e) {
    return { ok: false, error: 'Cannot read Mods folder ' + modsDir + ': ' + e.message };
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    const modRoot = path.join(modsDir, e.name);
    if (!fs.existsSync(path.join(modRoot, 'ModInfo.xml'))) continue;
    let infoText = ''; try { infoText = fs.readFileSync(path.join(modRoot, 'ModInfo.xml'), 'utf8'); } catch { /* keep defaults */ }
    mods.push({
      name: e.name,
      modRoot,
      version: /Version\s+value="([^"]*)"/.exec(infoText)?.[1] || '?',
      displayName: /DisplayName\s+value="([^"]*)"/.exec(infoText)?.[1] || e.name,
    });
  }

  const sourceFiles = [];
  const localizationFiles = [];
  const nameIndex = { items: new Set(), blocks: new Set(), recipes: new Set() };
  const scanNames = (text, re, set) => { let m; while ((m = re.exec(text))) set.add(m[1]); };
  const scanChainsFile = (p) => {
    if (!fs.existsSync(p)) return;
    const text = fs.readFileSync(p, 'utf8');
    const re = /<(block|item)\s+name="([^"]+)"([\s\S]*?)(?=<\1\s|<$)/g;
    let m;
    while ((m = re.exec(text))) {
      const name = m[2];
      if (iconChain[name]) continue;
      const body = m[3];
      const iconM = /<property\s+name="Icon"\s+value="([^"]+)"/.exec(body);
      const extM = /<property\s+name="Extends"\s+value="([^"]+)"/.exec(body);
      if (iconM || extM) iconChain[name] = { icon: iconM ? iconM[1].trim() : undefined, extends: extM ? extM[1].split(',')[0].trim() : undefined };
    }
  };

  for (const mod of mods) {
    const configDir = path.join(mod.modRoot, 'Config');
    const xmlFiles = listXmlFiles(configDir, mod.modRoot);
    for (const f of xmlFiles) {
      // cheap size guard; tech-tree files are small
      if (f.size > 12 * 1024 * 1024) continue;
      let buf; try { buf = fs.readFileSync(path.join(mod.modRoot, f.path)); } catch { continue; }
      const { bom, text } = detectBom(buf);
      const role = classifyXml(text);
      if (role) sourceFiles.push({ mod: mod.name, modRoot: mod.modRoot, path: f.path, role, size: f.size, sha1: sha1(buf), bom, text });
      // name index sources (never returned to the client, used for implicit-unlock + icons)
      const lower = f.path.toLowerCase();
      if (/items_.*\.xml$/.test(lower) || /(^|\/)items\.xml$/.test(lower)) scanNames(text, /<item\s+name="([^"]+)"/g, nameIndex.items);
      if (/blocks_.*\.xml$/.test(lower) || /(^|\/)blocks\.xml$/.test(lower)) scanNames(text, /<block\s+name="([^"]+)"/g, nameIndex.blocks);
      if (/recipes_.*\.xml$/.test(lower) || /(^|\/)recipes\.xml$/.test(lower)) scanNames(text, /<recipe\s+name="([^"]+)"/g, nameIndex.recipes);
    }
    const locDir = path.join(configDir, 'Localization');
    let locEntries; try { locEntries = fs.readdirSync(locDir, { withFileTypes: true }); } catch { locEntries = []; }
    for (const lf of locEntries) {
      if (!lf.isFile() || !/(english|schinese)\.txt$/i.test(lf.name)) continue;
      try {
        const buf = fs.readFileSync(path.join(locDir, lf.name));
        const { bom, text } = detectBom(buf);
        const lang = /schinese/i.test(lf.name) ? 'SChinese' : 'English';
        localizationFiles.push({ mod: mod.name, path: `Config/Localization/${lf.name}`, lang, bom, text });
      } catch { /* skip */ }
    }
  }

  // icon inheritance from vanilla (read-only) + every mod's blocks/items
  scanChainsFile(path.join(VANILLA_ROOT, 'Config', 'blocks.xml'));
  scanChainsFile(path.join(VANILLA_ROOT, 'Config', 'items.xml'));
  for (const mod of mods) {
    scanChainsFile(path.join(mod.modRoot, 'Config', 'blocks.xml'));
    scanChainsFile(path.join(mod.modRoot, 'Config', 'items.xml'));
    const custom = path.join(mod.modRoot, 'Config', 'Custom');
    let entries2; try { entries2 = fs.readdirSync(custom, { withFileTypes: true }); } catch { entries2 = []; }
    for (const e of entries2) {
      if (e.isFile() && /^blocks_.*\.xml$|^items_.*\.xml$/i.test(e.name)) scanChainsFile(path.join(custom, e.name));
    }
  }

  // user-editable custom dictionary (Key,schinese CSV) — merged last, wins over everything
  let customDictionary = null;
  const dictPath = path.join(IDE_ROOT, 'dictionary.csv');
  if (fs.existsSync(dictPath)) {
    const buf = fs.readFileSync(dictPath);
    const { bom, text } = detectBom(buf);
    customDictionary = { text, bom };
  }

  return {
    ok: true,
    modsDir,
    mods: mods.map(m => ({ name: m.name, displayName: m.displayName, version: m.version, modRoot: m.modRoot })),
    sourceFiles,
    localizationFiles,
    nameIndex: { items: [...nameIndex.items], blocks: [...nameIndex.blocks], recipes: [...nameIndex.recipes] },
    customDictionary,
    vanillaConfigRoot: VANILLA_CONFIG_ROOT,
  };
}

// ---------------------------------------------------------------- backup/export
// files are keyed "<ModName>/<Config-relative path>" — keeps multi-mod exports unambiguous
function parseKey(key) {
  const idx = key.indexOf('/');
  if (idx <= 0) throw new Error('Bad file key: ' + key);
  const modName = key.slice(0, idx);
  const rel = key.slice(idx + 1).replace(/\\/g, '/');
  const n = rel.toLowerCase();
  if (!(n.startsWith('config/') && n.endsWith('.xml'))) throw new Error('Refusing to handle non mod-config file: ' + key);
  return { modName, rel };
}

function doBackup(modsDir, keys) {
  const stamp = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dirName = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
  const backupRoot = path.join(BACKUP_DIR, dirName);
  const copied = [];
  for (const key of keys) {
    const { modName, rel } = parseKey(key);
    const src = normalizeInside(path.join(modsDir, modName), rel);
    if (!src || !fs.existsSync(src)) throw new Error('Missing file for backup: ' + key);
    const dst = path.join(backupRoot, modName, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    copied.push(key);
  }
  return { backupDir: path.relative(modsDir, backupRoot).replace(/\\/g, '/'), backupDirAbs: backupRoot, files: copied };
}

function doExport(modsDir, files) {
  const written = [];
  for (const [key, content] of Object.entries(files)) {
    const { modName, rel } = parseKey(key);
    const abs = normalizeInside(path.join(modsDir, modName), rel);
    if (!abs) throw new Error('Path outside mod folder: ' + key);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    const copy = path.join(EXPORT_DIR, modName, rel);
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.writeFileSync(copy, content, 'utf8');
    written.push(key);
  }
  return { written };
}

function readVanillaFile(rel) {
  const abs = normalizeInside(VANILLA_ROOT, rel);
  if (!abs) return { ok: false, error: 'Path outside vanilla root' };
  if (!fs.existsSync(abs)) return { ok: false, error: 'Not found in vanilla: ' + rel };
  const buf = fs.readFileSync(abs);
  const { bom, text } = detectBom(buf);
  return { ok: true, path: rel, sha1: sha1(buf), bom, text };
}

// ---------------------------------------------------------------- routes
async function handleApi(req, res, url) {
  const route = url.pathname;

  if (route === '/api/defaults' && req.method === 'GET') {
    return send(res, 200, scanMods(MODS_DIR));
  }
  if (route === '/api/scan' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    let dir = body.path || MODS_DIR;
    // accept either a Mods folder or a single mod folder
    if (fs.existsSync(path.join(dir, 'ModInfo.xml'))) dir = path.dirname(dir);
    return send(res, 200, scanMods(dir));
  }
  if (route === '/api/vanilla' && req.method === 'GET') {
    return send(res, 200, readVanillaFile(url.searchParams.get('path') || 'Config/Localization.txt'));
  }
  if (route === '/api/readmod' && req.method === 'GET') {
    const rel = url.searchParams.get('path') || '';
    const root = url.searchParams.get('root') || MODS_DIR;
    const abs = normalizeInside(root, rel);
    if (!abs) return sendErr(res, 403, 'Path outside allowed root');
    try {
      const buf = fs.readFileSync(abs);
      const { bom, text } = detectBom(buf);
      return send(res, 200, { ok: true, path: rel, bom, text, sha1: sha1(buf) });
    } catch (e) { return sendErr(res, 404, e.message); }
  }
  if (route === '/api/backup' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.modRoot || !Array.isArray(body.files) || body.files.length === 0) throw new Error('modRoot and files[] required');
      return send(res, 200, { ok: true, ...doBackup(body.modRoot, body.files) });
    } catch (e) { return sendErr(res, 400, e.message); }
  }
  if (route === '/api/export' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.modRoot || !body.files || typeof body.files !== 'object') throw new Error('modRoot and files{} required');
      if (body.confirm !== true) throw new Error('Export requires confirm:true');
      return send(res, 200, { ok: true, ...doExport(body.modRoot, body.files) });
    } catch (e) { return sendErr(res, 400, e.message); }
  }
  if (route === '/api/icon' && req.method === 'GET') {
    const name = (url.searchParams.get('name') || '').trim();
    const fuzzy = (url.searchParams.get('fuzzy') || '').trim().toLowerCase();
    const safe = name.replace(/[^a-zA-Z0-9_.]/g, '');
    if (!safe) return sendErr(res, 400, 'name required');
    // atlas roots: every mod in load order (later wins), vanilla as base fallback
    const modDirs = [];
    try {
      for (const e of fs.readdirSync(MODS_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.isDirectory() && fs.existsSync(path.join(MODS_DIR, e.name, 'ModInfo.xml'))) modDirs.push(path.join(MODS_DIR, e.name));
      }
    } catch { /* ignore */ }
    const modAtlas = [];
    for (const md of modDirs) {
      for (const atlas of ['ItemIconAtlas', 'UISkills']) modAtlas.push(path.join(md, 'UIAtlases', atlas));
    }
    const fileFor = (n) => {
      let hit = null;
      for (const dir of modAtlas) { const p = path.join(dir, n + '.png'); if (fs.existsSync(p)) hit = p; } // last mod wins
      if (hit) return hit;
      const p = path.join(VANILLA_ROOT, 'ItemIcons', n + '.png');
      return fs.existsSync(p) ? p : null;
    };
    let cur = safe;
    const seen = new Set();
    for (let hop = 0; hop < 12 && cur && !seen.has(cur); hop++) {
      seen.add(cur);
      const file = fileFor(cur);
      if (file) {
        const data = fs.readFileSync(file);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
        return res.end(data);
      }
      const link = iconChain[cur];
      if (!link) break;
      cur = link.icon && !/^ui_game_symbol_/i.test(link.icon) ? link.icon : link.extends;
    }
    if (fuzzy && /^[a-z0-9_]+$/.test(fuzzy) && fuzzy.length >= 3) {
      const searchDirs = [...modAtlas, path.join(VANILLA_ROOT, 'ItemIcons')];
      for (const dir of searchDirs) {
        let entries; try { entries = fs.readdirSync(dir); } catch { continue; }
        const hit = entries.find(f => f.toLowerCase().includes(fuzzy) && f.endsWith('.png'));
        if (hit) {
          const data = fs.readFileSync(path.join(dir, hit));
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
          return res.end(data);
        }
      }
    }
    return sendErr(res, 404, 'icon not found: ' + safe);
  }
  return sendErr(res, 404, 'Unknown API route: ' + route);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const abs = normalizeInside(PUBLIC_DIR, rel.replace(/^\/+/, ''));
    if (!abs) return sendErr(res, 403, 'Forbidden');
    let data; try { data = fs.readFileSync(abs); } catch { return sendErr(res, 404, 'Not found: ' + rel); }
    const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    return res.end(data);
  } catch (e) {
    return sendErr(res, 500, e.message);
  }
});

function listen(port, attempts = 10) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempts > 0) { console.log(`[ul-ide] port ${port} busy, trying ${port + 1}`); listen(port + 1, attempts - 1); }
    else { console.error('[ul-ide] server error:', e.message); process.exit(1); }
  });
  server.listen(port, '127.0.0.1', () => {
    console.log('==========================================================');
    console.log(' 7DTD Tech Tree IDE (multi-mod)');
    console.log(` Open in browser:  http://localhost:${port}`);
    console.log(` Mods folder:      ${MODS_DIR}`);
    console.log(` Vanilla configs:  ${VANILLA_CONFIG_ROOT} (read-only)`);
    console.log('==========================================================');
  });
}
listen(PORT);
