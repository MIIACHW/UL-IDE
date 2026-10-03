// Parser — Raw research XML → Unified TechTree Model (research tree only).
// Everything the schema below does not understand lands in unknownAttrs /
// unknownChildren and stays in the DOM; serialization never drops it.
// Localization is bilingual: Simplified Chinese preferred, English fallback.
import { parseXML, serializeXML, findRoot, childElements } from './xmldom.js';
import { createTechTree, makeNode, rebuildEdges } from './model.js';

// ------------------------------------------------------------- schemas
const KNOWN_ATTRS_RESEARCH = ['name', 'desc', 'pos', 'area', 'parent', 'category', 'icon', 'size', 'link_type',
  'unlocked', 'requires'];

// ------------------------------------------------------------- localization
function splitCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// Vanilla CSV (multi-column: Key,File,Type,...,english,...,schinese,...)
export function parseVanillaLocalization(text) {
  const en = new Map(), zh = new Map();
  const lines = text.split(/\r?\n/);
  if (!lines.length) return { en, zh };
  const header = splitCsvLine(lines[0]);
  const enIdx = header.findIndex(h => h.trim().toLowerCase() === 'english');
  const zhIdx = header.findIndex(h => h.trim().toLowerCase() === 'schinese');
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cols = splitCsvLine(lines[i]);
    if (!cols[0]) continue;
    const key = cols[0].trim();
    if (enIdx >= 0 && cols.length > enIdx && cols[enIdx]) en.set(key, cols[enIdx]);
    if (zhIdx >= 0 && cols.length > zhIdx && cols[zhIdx]) zh.set(key, cols[zhIdx]);
  }
  return { en, zh };
}

// Mod CSV (two columns: Key,<language>)
export function parseModLocalization(text) {
  const map = new Map();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    if (i === 0 && /^key\s*,/i.test(lines[i])) continue;
    const cols = splitCsvLine(lines[i]);
    if (cols.length >= 2 && cols[0]) map.set(cols[0].trim(), cols[1]);
  }
  return map;
}

// Prefer Simplified Chinese, fall back to English, then to the raw key.
export function resolveKey(tree, key, lang = 'zh') {
  if (!key || key === 'null') return null;
  const loc = tree.localization;
  if (lang === 'zh') return loc.zh.get(key) ?? loc.en.get(key) ?? null;
  return loc.en.get(key) ?? null;
}

const RESEARCH_BRANCH_ZH = {
  Research: '研究站', Science: '科学与工程', Tools: '工具', General: '通用',
  Melee: '近战武器', Ranged: '远程武器', Cooking: '烹饪', Farming: '种植',
  Armorer: '护甲', Traps: '陷阱', Chemistry: '化学', Mechanic: '机械',
};
export function researchCategoryLabel(tree, category) {
  const key = category === 'Melee' ? 'groupMeleeWeapons' : category === 'Ranged' ? 'groupRangedWeapons' : 'group' + category;
  return RESEARCH_BRANCH_ZH[category] || resolveKey(tree, key, 'en') || category;
}

// ------------------------------------------------------------- helpers
function registerNode(tree, n) {
  if (tree.byId.has(n.id)) {
    tree.meta.duplicateIds = tree.meta.duplicateIds || [];
    let dup = tree.meta.duplicateIds.find(d => d.id === n.id);
    if (!dup) {
      const first = tree.byId.get(n.id);
      dup = { id: n.id, sources: [{ file: first.sourceFile, line: first.sourceLine }] };
      tree.meta.duplicateIds.push(dup);
    }
    dup.sources.push({ file: n.sourceFile, line: n.sourceLine });
  } else {
    tree.byId.set(n.id, n);
  }
  tree.nodes.push(n);
}
function attrsOf(el) {
  const out = {};
  for (const a of el.attrs) if (a.decoded !== null) out[a.name] = a.decoded;
  return out;
}

// ------------------------------------------------------------- recipes_research.xml
function parseResearchFile(tree, sf) {
  const root = findRoot(sf.dom, 'Subquake');
  if (!root) return;
  const wrapper = childElements(root).find(c => c.name === 'append' || c.name === 'set');
  if (!wrapper) return;
  sf.patchType = wrapper.name;
  sf.patchXpath = wrapper.attrs.find(a => a.name === 'xpath')?.decoded || '';

  for (const c of childElements(wrapper)) {
    if (c.name !== 'research') {
      tree.meta.unknownTopLevel = tree.meta.unknownTopLevel || [];
      tree.meta.unknownTopLevel.push({ file: sf.path, name: c.name, line: c.line });
      continue;
    }
    const attrs = attrsOf(c);
    const posRaw = attrs.pos || '';
    const [px, py] = posRaw.split(',').map(v => parseFloat(v.trim()));
    const node = makeNode({
      id: attrs.name || '', kind: 'research',
      descKey: attrs.desc || null, icon: attrs.icon || null,
      category: attrs.category || 'research', parentId: attrs.parent || null,
      sourceFile: sf.path, sourceLine: c.line, dom: c,
      research: {
        dom: c, pos: posRaw || null, posX: Number.isFinite(px) ? px : null, posY: Number.isFinite(py) ? py : null,
        area: attrs.area || null, size: attrs.size || null, linkType: attrs.link_type || null,
        unlocked: attrs.unlocked === 'true', requiresList: (attrs.requires || '').split(',').map(s => s.trim()).filter(Boolean),
        unlocks: [], ingredients: [],
      },
    });
    const known = new Set(KNOWN_ATTRS_RESEARCH);
    for (const a of c.attrs) {
      if (a.decoded !== null && !known.has(a.name)) node.unknownAttrs.push({ name: a.name, value: a.decoded });
    }
    for (const ch of childElements(c)) {
      const a = attrsOf(ch);
      if (ch.name === 'unlocks') node.research.unlocks.push({ name: a.name || '', craftable: a.craftable, dom: ch });
      else if (ch.name === 'ingredient') node.research.ingredients.push({ name: a.name || '', count: a.count || '', dom: ch });
      else node.unknownChildren.push({ kind: 'element', name: ch.name, xml: serializeXML(ch).slice(0, 4000) });
    }
    registerNode(tree, node);
  }
}

// ------------------------------------------------------------- main entry
export function buildTechTree(bundle) {
  const tree = createTechTree();
  tree.meta.modRoot = bundle.modRoot;
  tree.meta.modInfo = bundle.modInfo;
  tree.meta.scannedAt = bundle.scannedAt;

  // localization: mod overrides vanilla; Simplified Chinese + English
  tree.localization.en = new Map();
  tree.localization.zh = new Map();
  for (const lf of bundle.localizationFiles) {
    const m = parseModLocalization(lf.text);
    const target = /chinese/i.test(lf.lang) ? tree.localization.zh : tree.localization.en;
    for (const [k, v] of m) target.set(k, v);
    tree.localization.languages.push({ lang: lf.lang, path: lf.path, size: m.size, bom: lf.bom });
  }
  if (bundle.vanilla.localization) {
    const v = parseVanillaLocalization(bundle.vanilla.localization.text);
    for (const [k, val] of v.en) if (!tree.localization.en.has(k)) tree.localization.en.set(k, val);
    for (const [k, val] of v.zh) if (!tree.localization.zh.has(k)) tree.localization.zh.set(k, val);
  }
  // community Chinese (sibling localization mods) — applied last, in load order,
  // exactly like the game applies them (ZZZZZ_* loads last and wins)
  for (const cl of bundle.communityLocalization || []) {
    const m = parseModLocalization(cl.text);
    for (const [k, val] of m) tree.localization.zh.set(k, val);
  }

  // icons
  for (const a of bundle.atlases) tree.icons.atlases.set(a.atlas, new Set(a.sprites.map(s => s.name)));

  // parse the research file
  for (const sf of bundle.sourceFiles) {
    if (sf.role !== 'research') continue;
    let dom;
    try { dom = parseXML(sf.text, { sourceName: sf.path }); }
    catch (e) {
      tree.meta.parseErrors = tree.meta.parseErrors || [];
      tree.meta.parseErrors.push({ file: sf.path, line: e.line || 0, message: e.message });
      continue;
    }
    const record = { path: sf.path, text: sf.text, dom, sha1: sf.sha1, bom: sf.bom, role: sf.role, patchType: '', patchXpath: '' };
    tree.sourceFiles.push(record);
    parseResearchFile(tree, record);
  }

  // categories: the 12 research branches
  const seen = new Set();
  for (const n of tree.nodes) {
    if (n.category && n.category !== 'research' && !seen.has(n.category)) {
      seen.add(n.category);
      tree.categories.push({ id: n.category, label: researchCategoryLabel(tree, n.category), kind: 'research', icon: n.icon });
    }
  }

  // inherit the branch category down each subtree (game's left panel semantics)
  const children = new Map();
  for (const n of tree.nodes) {
    const p = n.parentId && tree.byId.get(n.parentId)?.kind === 'research' ? n.parentId : null;
    if (p) { if (!children.has(p)) children.set(p, []); children.get(p).push(n); }
  }
  for (const n of tree.nodes) {
    if (!n.category || n.category === 'research') continue;
    const stack = [...(children.get(n.id) || [])];
    while (stack.length) {
      const c = stack.pop();
      c.category = n.category;
      for (const gc of children.get(c.id) || []) stack.push(gc);
    }
  }

  // localized display names — the localization key of an item IS the item name
  for (const n of tree.nodes) {
    n.display = resolveKey(tree, n.id) || resolveKey(tree, n.id, 'en') || n.id;
    n.displayEn = tree.localization.en.get(n.id) || null;
  }

  tree.unknownCount = tree.nodes.filter(n => n.unknownAttrs.length || n.unknownChildren.length).length;
  rebuildEdges(tree);
  return tree;
}
