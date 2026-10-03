// Undead Legacy Tech Tree IDE — local server (zero dependencies).
// Serves the IDE front-end and a guarded file API for the mod folder.
// Read roots: mod folder + vanilla game Data/Config. Write roots: Config/*.xml only, always after backup.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const IDE_ROOT = __dirname;
// TechTreeIDE lives directly inside the mod folder, so the mod root is one level up.
const MOD_ROOT_DEFAULT = path.resolve(__dirname, '..');
const VANILLA_CONFIG_ROOT = process.env.UL_VANILLA_CONFIG || 'E:\\STEAM\\steamapps\\common\\7 Days To Die\\Data\\Config';
const VANILLA_ROOT = path.resolve(VANILLA_CONFIG_ROOT, '..');
const BACKUP_DIR = path.join(IDE_ROOT, 'backups');
const EXPORT_DIR = path.join(IDE_ROOT, 'export');

const PORT = Number(process.env.UL_IDE_PORT || 8899);

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
function isModXml(rel) {
  const n = rel.replace(/\\/g, '/').toLowerCase();
  return (n.startsWith('config/') && n.endsWith('.xml'));
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

function listSprites(dir, base) {
  const out = [];
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isFile() && /\.png$/i.test(e.name)) {
      out.push({ name: e.name.replace(/\.png$/i, ''), atlas: path.relative(base, dir).replace(/\\/g, '/') });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- scan
// Extends / Icon inheritance map shared with the /api/icon resolver (module scope).
const iconChain = {}; // name -> { icon?: string, extends?: string }

function scanMod(modRoot) {
  const modRootAbs = path.resolve(modRoot);
  const configDir = path.join(modRootAbs, 'Config');
  if (!fs.existsSync(path.join(modRootAbs, 'ModInfo.xml'))) {
    return { ok: false, error: 'ModInfo.xml not found — not a 7 Days to Die mod folder: ' + modRootAbs };
  }
  let modInfoText = '';
  try { modInfoText = fs.readFileSync(path.join(modRootAbs, 'ModInfo.xml'), 'utf8'); } catch (e) { return { ok: false, error: 'Cannot read ModInfo.xml: ' + e.message }; }
  const version = /Version\s+value="([^"]*)"/.exec(modInfoText)?.[1] || '?';
  const name = /Name\s+value="([^"]*)"/.exec(modInfoText)?.[1] || '?';

  const files = listXmlFiles(configDir, modRootAbs);
  const interesting = files.filter(f => f.path.toLowerCase() === 'config/custom/recipes_research.xml');

  const localization = [];
  const locDir = path.join(configDir, 'Localization');
  if (fs.existsSync(locDir)) {
    for (const e of fs.readdirSync(locDir, { withFileTypes: true })) {
      if (e.isFile() && /\.txt$/i.test(e.name)) localization.push('Config/Localization/' + e.name);
    }
  }

  const atlases = [];
  const atlasRoot = path.join(modRootAbs, 'UIAtlases');
  if (fs.existsSync(atlasRoot)) {
    for (const e of fs.readdirSync(atlasRoot, { withFileTypes: true })) {
      if (e.isDirectory()) atlases.push({ atlas: e.name, sprites: listSprites(path.join(atlasRoot, e.name), path.join(modRootAbs, 'UIAtlases')) });
    }
  }

  const sourceFiles = interesting.map(f => {
    const buf = fs.readFileSync(path.join(modRootAbs, f.path));
    const { bom, text } = detectBom(buf);
    return { path: f.path, size: f.size, sha1: sha1(buf), bom, text };
  });

  // name index over items / blocks / recipes — used to resolve the game's implicit
  // unlock rule: a research unlocks the recipe (and thus item/block) of the same name
  const nameIndex = { items: new Set(), blocks: new Set(), recipes: new Set() };
  const scanNames = (rel, re, set) => {
    const p = path.join(configDir, rel);
    if (!fs.existsSync(p)) return;
    const text = fs.readFileSync(p, 'utf8');
    let m; while ((m = re.exec(text))) set.add(m[1]);
  };
  const itemFiles = ['items.xml', ...files.filter(f => /^Config\/Custom\/items_.*\.xml$/i.test(f.path)).map(f => f.path.slice('Config/'.length))];
  const blockFiles = ['blocks.xml', ...files.filter(f => /^Config\/Custom\/blocks_.*\.xml$/i.test(f.path)).map(f => f.path.slice('Config/'.length))];
  const recipeFiles = ['recipes.xml', ...files.filter(f => /^Config\/Custom\/recipes_(?!research).*\.xml$/i.test(f.path)).map(f => f.path.slice('Config/'.length))];
  for (const f of itemFiles) scanNames(f, /<item\s+name="([^"]+)"/g, nameIndex.items);
  for (const f of blockFiles) scanNames(f, /<block\s+name="([^"]+)"/g, nameIndex.blocks);
  for (const f of recipeFiles) scanNames(f, /<recipe\s+name="([^"]+)"/g, nameIndex.recipes);
  const nameIndexOut = { items: [...nameIndex.items], blocks: [...nameIndex.blocks], recipes: [...nameIndex.recipes] };

  // Extends / Icon inheritance (the game resolves block/item icons through these).
  // Sources: vanilla Data/Config blocks+items (read-only) and the mod's own files.
  const scanChains = (p) => {
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
      if (iconM || extM) {
        iconChain[name] = {
          icon: iconM ? iconM[1].trim() : undefined,
          extends: extM ? extM[1].split(',')[0].trim() : undefined,
        };
      }
    }
  };
  scanChains(path.join(VANILLA_ROOT, 'Config', 'blocks.xml'));   // vanilla, read-only
  scanChains(path.join(VANILLA_ROOT, 'Config', 'items.xml'));    // vanilla, read-only
  for (const f of blockFiles) scanChains(path.join(configDir, f));
  for (const f of itemFiles) scanChains(path.join(configDir, f));

  // user-editable custom dictionary (Key,schinese CSV) — merged last, wins over everything
  let customDictionary = null;
  const dictPath = path.join(IDE_ROOT, 'dictionary.csv');
  if (fs.existsSync(dictPath)) {
    const buf = fs.readFileSync(dictPath);
    const { bom, text } = detectBom(buf);
    customDictionary = { text, bom };
  }

  // community/localization mods installed as siblings (e.g. ZZZZZ_XIHE汉化-亡灵遗产).
  // The game applies mods in alphabetical folder order, so later folders win —
  // we collect their Simplified Chinese files and overlay them in the same order.
  const communityLocalization = [];
  const modsDir = path.dirname(modRootAbs);
  let siblings; try { siblings = fs.readdirSync(modsDir, { withFileTypes: true }); } catch { siblings = []; }
  for (const e of siblings.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || e.name === path.basename(modRootAbs)) continue;
    const modDir = path.join(modsDir, e.name);
    if (!fs.existsSync(path.join(modDir, 'ModInfo.xml'))) continue;
    const locDir = path.join(modDir, 'Config', 'Localization');
    let locFiles; try { locFiles = fs.readdirSync(locDir, { withFileTypes: true }); } catch { continue; }
    for (const lf of locFiles) {
      if (!lf.isFile() || !/schinese/i.test(lf.name)) continue;
      const abs = path.join(locDir, lf.name);
      try {
        const buf = fs.readFileSync(abs);
        const { bom, text } = detectBom(buf);
        communityLocalization.push({ mod: e.name, path: `Mods/${e.name}/Config/Localization/${lf.name}`, lang: 'SChinese', text, bom });
      } catch { /* unreadable sibling — skip */ }
    }
  }

  return {
    ok: true,
    modRoot: modRootAbs,
    modInfo: { name, displayName: /DisplayName\s+value="([^"]*)"/.exec(modInfoText)?.[1] || name, version },
    sourceFiles,           // tech tree definition files, with content
    localization,          // relative paths
    communityLocalization, // Chinese localization from sibling mods, in load order
    nameIndex: nameIndexOut, // {items, blocks, recipes} — for implicit-unlock resolution
    customDictionary,      // {text, bom} from TechTreeIDE/dictionary.csv
    atlases,               // [{atlas, sprites:[{name, atlas}]}]
    allXmlCount: files.length,
    vanillaConfigRoot: VANILLA_CONFIG_ROOT,
  };
}

function readVanillaFile(rel) {
  const abs = normalizeInside(VANILLA_ROOT, rel);
  if (!abs) return { ok: false, error: 'Path outside vanilla root' };
  if (!fs.existsSync(abs)) return { ok: false, error: 'Not found in vanilla: ' + rel };
  const buf = fs.readFileSync(abs);
  const { bom, text } = detectBom(buf);
  return { ok: true, path: rel, sha1: sha1(buf), bom, text };
}

// ---------------------------------------------------------------- export/backup
function doBackup(modRoot, relPaths) {
  const stamp = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dirName = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
  const backupRoot = path.join(BACKUP_DIR, dirName);
  const copied = [];
  for (const rel of relPaths) {
    if (!isModXml(rel)) throw new Error('Refusing to backup non mod-config file: ' + rel);
    const src = normalizeInside(modRoot, rel);
    if (!src || !fs.existsSync(src)) throw new Error('Missing file for backup: ' + rel);
    const dst = path.join(backupRoot, rel.replace(/\\/g, '/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    copied.push(rel.replace(/\\/g, '/'));
  }
  return { backupDir: path.relative(modRoot, backupRoot).replace(/\\/g, '/'), backupDirAbs: backupRoot, files: copied };
}

function doExport(modRoot, files) {
  const written = [];
  for (const [rel, content] of Object.entries(files)) {
    if (!isModXml(rel)) throw new Error('Refusing to write non mod-config file: ' + rel);
    const abs = normalizeInside(modRoot, rel);
    if (!abs) throw new Error('Path outside mod root: ' + rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    // keep an export copy inside the IDE folder as well
    const copy = path.join(EXPORT_DIR, rel.replace(/\\/g, '/'));
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.writeFileSync(copy, content, 'utf8');
    written.push(rel.replace(/\\/g, '/'));
  }
  return { written };
}

// ---------------------------------------------------------------- router
async function handleApi(req, res, url) {
  const route = url.pathname;

  if (route === '/api/scan' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const result = scanMod(body.path || MOD_ROOT_DEFAULT);
    return send(res, result.ok ? 200 : 400, result);
  }
  if (route === '/api/defaults' && req.method === 'GET') {
    const result = scanMod(MOD_ROOT_DEFAULT);
    return send(res, result.ok ? 200 : 400, result);
  }
  if (route === '/api/vanilla' && req.method === 'GET') {
    return send(res, 200, readVanillaFile(url.searchParams.get('path') || 'Config/Localization.txt'));
  }
  if (route === '/api/readmod' && req.method === 'GET') {
    const rel = url.searchParams.get('path') || '';
    const modRoot = url.searchParams.get('root') || MOD_ROOT_DEFAULT;
    const abs = normalizeInside(modRoot, rel);
    if (!abs) return sendErr(res, 403, 'Path outside mod root');
    try {
      const buf = fs.readFileSync(abs);
      const { bom, text } = detectBom(buf);
      return send(res, 200, { ok: true, path: rel, bom, text, sha1: sha1(buf) });
    } catch (e) { return sendErr(res, 404, e.message); }
  }
  if (route === '/api/icon' && req.method === 'GET') {
    // resolve an item/symbol icon by name: mod ItemIconAtlas → vanilla ItemIcons → mod UISkills
    // fuzzy=<token> finds the first icon whose filename contains the token (used for
    // symbol icons like symbol_baton where the vanilla UIAtlas sprite isn't servable)
    const name = (url.searchParams.get('name') || '').trim();
    const fuzzy = (url.searchParams.get('fuzzy') || '').trim().toLowerCase();
    const safe = name.replace(/[^a-zA-Z0-9_.]/g, '');
    if (!safe) return sendErr(res, 400, 'name required');
    const roots = [
      path.join(MOD_ROOT_DEFAULT, 'UIAtlases', 'ItemIconAtlas'),
      path.join(VANILLA_ROOT, 'ItemIcons'), // VANILLA_ROOT already points at <game>\Data
      path.join(MOD_ROOT_DEFAULT, 'UIAtlases', 'UISkills'),
    ];
    const fileFor = (n) => {
      for (const dir of roots) {
        const p = path.join(dir, n + '.png');
        if (fs.existsSync(p)) return p;
      }
      return null;
    };
    // exact file, then walk the game's own inheritance (Icon property -> Extends chain)
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
      for (const dir of roots) {
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

    // static files from public/
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
    console.log(' Undead Legacy Tech Tree IDE');
    console.log(` Open in browser:  http://localhost:${port}`);
    console.log(` Mod folder:       ${MOD_ROOT_DEFAULT}`);
    console.log(` Vanilla configs:  ${VANILLA_CONFIG_ROOT} (read-only)`);
    console.log('==========================================================');
  });
}
listen(PORT);
