// Parser — Raw tech-tree XML → Unified TechTree Model (multi-mod, multi-tree).
// Two tree styles are recognized, both round-trip safe with unknown data preserved:
//   research-style    — <research> elements (UL research unlocks)
//   progression-style — vanilla-format <attribute/skill/book_group/perk/book>
// Localization is bilingual: Simplified Chinese preferred, English fallback.
import { parseXML, serializeXML, findRoot, childElements } from './xmldom.js';
import { createTechTree, makeNode, rebuildEdges } from './model.js';

// ------------------------------------------------------------- schemas
const KNOWN_ATTRS_RESEARCH = ['name', 'desc', 'pos', 'area', 'parent', 'category', 'icon', 'size', 'link_type',
  'unlocked', 'requires'];
const KNOWN_ATTRS_PROG = {
  attribute: ['name', 'name_key', 'desc_key', 'icon', 'min_level', 'max_level', 'base_skill_point_cost', 'cost_multiplier_per_level'],
  skill: ['parent', 'name', 'name_key', 'desc_key', 'icon'],
  book_group: ['parent', 'name', 'name_key', 'desc_key', 'icon'],
  perk: ['parent', 'name', 'max_level', 'name_key', 'desc_key', 'icon', 'base_skill_point_cost', 'cost_multiplier_per_level'],
  book: ['parent', 'name', 'max_level', 'base_skill_point_cost', 'name_key', 'desc_key', 'icon', 'long_desc_key'],
};
function num(v) { if (v == null) return null; const n = parseFloat(v); return Number.isFinite(n) ? n : null; }

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

// Translations from user-added language files (tree.localization.langs) for a node's
// localization keys and its unlock targets — the multi-language search corpus for the
// graph filter and the name suggestion dropdown. Never used for display names.
export function searchLangText(tree, node) {
  const langs = tree.localization?.langs;
  if (!langs || !langs.size || !node) return '';
  let out = '';
  for (const map of langs.values()) {
    for (const k of [node.id, node.nameKey, node.descKey]) {
      if (!k) continue;
      const v = map.get(k);
      if (v) out += ' ' + v;
    }
    for (const u of node.research?.unlocks || []) {
      if (!u.name) continue;
      const v = map.get(u.name);
      if (v) out += ' ' + v;
    }
  }
  return out;
}

// First custom-language translation of a node containing the (lowercased) query —
// lets the suggestion UI show WHICH language matched and with what value.
export function findLangMatch(tree, node, queryLower) {
  const langs = tree.localization?.langs;
  if (!langs || !langs.size || !node || !queryLower) return null;
  for (const [lang, map] of langs) {
    for (const k of [node.id, node.nameKey, node.descKey]) {
      if (!k) continue;
      const v = map.get(k);
      if (v && v.toLowerCase().includes(queryLower)) return `${lang}: ${v}`;
    }
  }
  return null;
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
  // accepted shapes: <Subquake><set|append xpath=...>…</set|append></Subquake> (UL patch)
  // or a standalone file whose root (directly or via set/append) holds <research> children
  const root = findRoot(sf.dom, 'Subquake');
  let container = null;
  if (root) {
    const wrapper = childElements(root).find(c => c.name === 'append' || c.name === 'set');
    if (!wrapper) return;
    sf.patchType = wrapper.name;
    sf.patchXpath = wrapper.attrs.find(a => a.name === 'xpath')?.decoded || '';
    container = wrapper;
  } else {
    let el = sf.dom.children.find(c => c.kind === 'element');
    if (!el) return;
    const wrapper = childElements(el).find(c => c.name === 'append' || c.name === 'set');
    container = wrapper || el;
    sf.patchType = wrapper ? wrapper.name : 'root';
    sf.patchXpath = wrapper?.attrs.find(a => a.name === 'xpath')?.decoded || '';
  }

  for (const c of childElements(container)) {
    if (c.name !== 'research') continue; // mixed files (research + recipes) — preserved in DOM, not modeled

    const attrs = attrsOf(c);
    const posRaw = attrs.pos || '';
    const [px, py] = posRaw.split(',').map(v => parseFloat(v.trim()));
    const node = makeNode({
      id: attrs.name || '', kind: 'research',
      descKey: attrs.desc || null, icon: attrs.icon || null,
      category: attrs.category || 'research', parentId: attrs.parent || null,
      sourceMod: sf.mod, sourceFile: sf.path, sourceLine: c.line, dom: c,
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

// ------------------------------------------------------------- progression-style files
// Vanilla-format tech trees: <progression> root (or a set/append patch wrapping one)
// containing <attributes>/<skills>/<perks> with <attribute|skill|book_group|perk|book name=...>.
function parseProgressionFile(tree, sf) {
  const rootEl = sf.dom.children.find(c => c.kind === 'element');
  if (!rootEl) return;
  let content = rootEl;
  const wrapper = childElements(rootEl).find(c => c.name === 'set' || c.name === 'append');
  if (wrapper) content = wrapper;
  sf.patchType = wrapper ? wrapper.name : 'root';
  sf.patchXpath = wrapper?.attrs.find(a => a.name === 'xpath')?.decoded || '';

  const visit = (el, kind) => {
    const attrs = attrsOf(el);
    const id = attrs.name || '';
    if (!id) return; // layout-only elements (<skill id=...>) have no name and are skipped
    const node = makeNode({
      id, kind,
      nameKey: attrs.name_key || null, descKey: attrs.desc_key || null,
      icon: attrs.icon || null, parentId: attrs.parent || null,
      maxLevel: num(attrs.max_level), minLevel: num(attrs.min_level),
      baseCost: num(attrs.base_skill_point_cost), costMultiplier: num(attrs.cost_multiplier_per_level),
      sourceMod: sf.mod, sourceFile: sf.path, sourceLine: el.line, dom: el,
    });
    const known = new Set(KNOWN_ATTRS_PROG[kind] || []);
    for (const a of el.attrs) {
      if (a.decoded !== null && !known.has(a.name)) node.unknownAttrs.push({ name: a.name, value: a.decoded });
    }
    // direct-child requirements of effect_group: collect ProgressionLevel references
    node.prerequisites = [];
    for (const ch of childElements(el)) {
      if (ch.name !== 'effect_group') { node.unknownChildren.push({ kind: 'element', name: ch.name, xml: serializeXML(ch).slice(0, 2000) }); continue; }
      for (const sub of childElements(ch)) {
        if (sub.name !== 'requirement') continue;
        const ra = attrsOf(sub);
        if (ra.name === 'ProgressionLevel' && ra.progression_name && ra.progression_name !== id) {
          node.prerequisites.push({ target: ra.progression_name, operation: ra.operation || '', value: ra.value || '', ref: sub });
        }
      }
    }
    registerNode(tree, node);
  };

  for (const c of childElements(content)) {
    if (c.name === 'attributes') { for (const a of childElements(c)) if (a.name === 'attribute') visit(a, 'attribute'); }
    else if (c.name === 'skills') { for (const a of childElements(c)) { if (a.name === 'skill') visit(a, 'skill'); else if (a.name === 'book_group') visit(a, 'book_group'); } }
    else if (c.name === 'perks') { for (const a of childElements(c)) { if (a.name === 'perk') visit(a, 'perk'); else if (a.name === 'book') visit(a, 'book'); } }
    else if (c.name === 'progression') visit(c, 'progression');
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
  // user-editable custom dictionary (TechTreeIDE/dictionary.csv) — highest priority
  if (bundle.customDictionary?.text) {
    const m = parseModLocalization(bundle.customDictionary.text);
    for (const [k, val] of m) tree.localization.zh.set(k, val);
  }
  // user-added language files (TechTreeIDE/langs/*.txt) — search-only languages
  tree.localization.langs = new Map();
  for (const cl of bundle.customLangs || []) {
    const m = parseModLocalization(cl.text);
    tree.localization.langs.set(cl.name, m);
    tree.localization.languages.push({ lang: cl.name, path: cl.path || ('langs/' + cl.name + '.txt'), size: m.size, bom: cl.bom, custom: true });
  }

  // icons
  for (const a of bundle.atlases || []) tree.icons.atlases.set(a.atlas, new Set(a.sprites.map(s => s.name)));

  // name index over items/blocks/recipes (implicit-unlock resolution)
  tree.nameIndex = {
    items: new Set(bundle.nameIndex?.items || []),
    blocks: new Set(bundle.nameIndex?.blocks || []),
    recipes: new Set(bundle.nameIndex?.recipes || []),
  };

  // parse tech tree files by role
  for (const sf of bundle.sourceFiles) {
    let dom;
    try { dom = parseXML(sf.text, { sourceName: (sf.mod ? sf.mod + '/' : '') + sf.path }); }
    catch (e) {
      tree.meta.parseErrors = tree.meta.parseErrors || [];
      tree.meta.parseErrors.push({ file: (sf.mod ? sf.mod + '/' : '') + sf.path, line: e.line || 0, message: e.message });
      continue;
    }
    const record = { mod: sf.mod || '(drop)', modRoot: sf.modRoot || null, path: sf.path, text: sf.text, dom, sha1: sf.sha1, bom: sf.bom, role: sf.role, patchType: '', patchXpath: '' };
    tree.sourceFiles.push(record);
    if (sf.role === 'research') parseResearchFile(tree, record);
    else if (sf.role === 'progression') parseProgressionFile(tree, record);
  }


  // categories: research branches (category attr) + progression attributes
  const seen = new Set();
  for (const n of tree.nodes) {
    if (n.kind === 'research' && n.category && n.category !== 'research' && !seen.has(n.category)) {
      seen.add(n.category);
      tree.categories.push({ id: n.category, label: researchCategoryLabel(tree, n.category), kind: 'research', icon: n.icon });
    }
  }
  for (const n of tree.nodes) {
    if (n.kind === 'attribute' && !seen.has(n.id)) {
      seen.add(n.id);
      tree.categories.push({ id: n.id, label: resolveKey(tree, n.nameKey) || n.id, kind: 'progression', icon: n.icon });
    }
  }

  // inherit category down each tree (research branches by category attr; progression by attribute root)
  const children = new Map();
  for (const n of tree.nodes) {
    const p = n.parentId && tree.byId.get(n.parentId) ? n.parentId : null;
    if (p) { if (!children.has(p)) children.set(p, []); children.get(p).push(n); }
  }
  const propagate = (n, cat) => {
    const stack = [...(children.get(n.id) || [])];
    while (stack.length) {
      const c = stack.pop();
      c.category = cat;
      for (const gc of children.get(c.id) || []) stack.push(gc);
    }
  };
  for (const n of tree.nodes) {
    if (n.kind === 'research' && n.category && n.category !== 'research') propagate(n, n.category);
    if (n.kind === 'attribute') propagate(n, n.id);
  }

  // localized display names: research key = node id (item name); progression key = name_key
  for (const n of tree.nodes) {
    const key = n.kind === 'research' ? n.id : (n.nameKey && n.nameKey !== 'null' ? n.nameKey : n.id);
    n.display = resolveKey(tree, key) || resolveKey(tree, key, 'en') || n.id;
    n.displayEn = tree.localization.en.get(key) || null;
    // game rule: a research implicitly unlocks the recipe/item/block of the same name
    if (n.kind === 'research' && n.research) {
      n.research.sameName = tree.nameIndex.items.has(n.id) ? 'item'
        : tree.nameIndex.blocks.has(n.id) ? 'block'
        : tree.nameIndex.recipes.has(n.id) ? 'recipe' : null;
    }
  }

  tree.unknownCount = tree.nodes.filter(n => n.unknownAttrs.length || n.unknownChildren.length).length;
  rebuildEdges(tree);
  return tree;
}
