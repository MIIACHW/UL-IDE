// Core regression tests (run: npm test / node test/run-tests.js)
// Critical assertions: round-trip byte-identity, research parsing counts,
// bilingual localization, command undo restoring original bytes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseXML, serializeXML, setAttr, makeElement, appendElement, insertElementBefore, removeElement } from '../public/js/xmldom.js';
import { buildTechTree, parseModLocalization, parseVanillaLocalization, resolveKey } from '../public/js/parser.js';
import { classifyXml } from '../public/js/scanner.js';
import { validate } from '../public/js/validator.js';
import { generateFiles, isDirty } from '../public/js/generator.js';
import { lineDiff, structuredDiff } from '../public/js/differ.js';
import { CommandStack, cmdSetAttr, cmdRename, cmdDeleteNode, cmdDuplicateNode, cmdAddResearchChild, cmdRemoveResearchChild, rebuildEdges } from '../public/js/model.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOD_ROOT = path.resolve(HERE, '..', '..', 'UndeadLegacy');
const CFG = path.join(MOD_ROOT, 'Config');
let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; failures.push({ name, e }); console.error('  ✗ ' + name + '\n      ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'eq') + ` — expected ${JSON.stringify(b).slice(0, 120)}, got ${JSON.stringify(a).slice(0, 120)}`); }

console.log('Undead Legacy Tech Tree IDE — core tests (research tree)');
console.log(`mod root: ${MOD_ROOT}`);

// ------------------------------------------------------------------ files
const researchText = fs.readFileSync(path.join(CFG, 'Custom', 'recipes_research.xml'), 'utf8');
const progressionText = fs.readFileSync(path.join(CFG, 'progression.xml'), 'utf8'); // xmldom format regression only
const skillsText = fs.readFileSync(path.join(CFG, 'Custom', 'recipes_skills.xml'), 'utf8'); // xmldom format regression only
const locEn = fs.readFileSync(path.join(CFG, 'Localization', 'English.txt'), 'utf8').replace(/^\uFEFF/, '');
const locZh = fs.readFileSync(path.join(CFG, 'Localization', 'SChinese.txt'), 'utf8').replace(/^\uFEFF/, '');
const VANILLA = process.env.UL_VANILLA_ROOT || 'E:\\STEAM\\steamapps\\common\\7 Days To Die';
let vanillaLocText = '';
try { vanillaLocText = fs.readFileSync(path.join(VANILLA, 'Data', 'Config', 'Localization.txt'), 'utf8'); } catch (e) { console.warn('  (vanilla localization not readable: ' + e.message + ')'); }

// ------------------------------------------------------------------ xmldom round-trip
test('round-trip: Custom/recipes_research.xml byte-identical', () => {
  eq(serializeXML(parseXML(researchText)), researchText);
});
test('round-trip: progression.xml byte-identical (format regression)', () => {
  eq(serializeXML(parseXML(progressionText)), progressionText);
});
test('round-trip: Custom/recipes_skills.xml byte-identical (format regression)', () => {
  eq(serializeXML(parseXML(skillsText)), skillsText);
});
test('round-trip: ModInfo.xml byte-identical', () => {
  const t = fs.readFileSync(path.join(MOD_ROOT, 'ModInfo.xml'), 'utf8');
  eq(serializeXML(parseXML(t)), t);
});
test('setAttr preserves everything except the changed value', () => {
  const dom = parseXML(researchText);
  const el = findResearch(dom, 'researchTier1');
  const before = serializeXML(dom);
  setAttr(el, 'unlocked', 'false');
  assert(serializeXML(dom) !== before);
  setAttr(el, 'unlocked', 'true');
  eq(serializeXML(dom), before);
});
test('insert/remove element keeps formatting valid', () => {
  const dom = parseXML(researchText);
  const wrapper = findContainer(dom, 'append');
  const el = makeElement('research', { name: 'researchZZZRoundTrip', parent: 'researchTier1' });
  appendElement(wrapper, el);
  const out = serializeXML(dom);
  const reparsed = parseXML(out);
  assert(findResearch(reparsed, 'researchZZZRoundTrip'));
  removeElement(el);
  eq(serializeXML(dom), researchText);
});
test('insertElementBefore keeps sibling formatting', () => {
  const dom = parseXML(researchText);
  const wrapper = findContainer(dom, 'append');
  const ref = findResearch(dom, 'researchTier2');
  const el = makeElement('research', { name: 'researchYYYBefore' });
  insertElementBefore(wrapper, el, ref);
  const out = serializeXML(dom);
  parseXML(out);
  removeElement(el);
  eq(serializeXML(dom), researchText);
});

// ------------------------------------------------------------------ parser
function makeBundle() {
  return {
    modsDir: MOD_ROOT,
    mods: [{ name: 'UndeadLegacy', modRoot: MOD_ROOT, version: '2.7.01', displayName: 'UndeadLegacy - Core Module' }],
    modInfo: { name: 'UndeadLegacy', version: '2.7.01' },
    scannedAt: 'test',
    sourceFiles: [
      { mod: 'UndeadLegacy', modRoot: MOD_ROOT, path: 'Config/Custom/recipes_research.xml', size: researchText.length, sha1: '', bom: null, text: researchText, role: 'research' },
      { mod: 'UndeadLegacy', modRoot: MOD_ROOT, path: 'Config/progression.xml', size: progressionText.length, sha1: '', bom: null, text: progressionText, role: 'progression' },
    ],
    localizationFiles: [
      { mod: 'UndeadLegacy', path: 'Config/Localization/English.txt', text: locEn, bom: null, lang: 'English' },
      { mod: 'UndeadLegacy', path: 'Config/Localization/SChinese.txt', text: locZh, bom: null, lang: 'SChinese' },
    ],
    atlases: [],
    nameIndex: { items: [], blocks: [], recipes: [] },
    customDictionary: null,
    vanilla: { localization: vanillaLocText ? { text: vanillaLocText, bom: null, sha1: '' } : null },
    warnings: [],
  };
}
let tree = null;
test('parse: expected research + progression counts', () => {
  tree = buildTechTree(makeBundle());
  const count = (k) => tree.nodes.filter(n => n.kind === k).length;
  eq(count('research'), 589, 'research nodes'); // 593 raw matches, 4 inside comments
  eq(count('attribute'), 8, 'attributes');
  eq(count('skill'), 30, 'skills');
  eq(count('book_group'), 19, 'book groups');
  eq(count('perk'), 102, 'perks'); // 104 raw matches, 2 inside comments
  eq(count('book'), 152, 'books');
  const unlocks = tree.nodes.reduce((s, n) => s + (n.research?.unlocks.length || 0), 0);
  eq(unlocks, 472, 'unlock entries'); // 476 raw matches, 4 inside comments
  assert(tree.edges.filter(e => e.type === 'requires').length >= 1, 'requires edges exist');
  assert(tree.edges.filter(e => e.type === 'parent').length > 800, 'parent edges exist');
});
test('parse: classifier recognizes both tree styles', () => {
  eq(classifyXml(researchText), 'research');
  eq(classifyXml(progressionText), 'progression');
  eq(classifyXml('<recipes><recipe name="x"/></recipes>'), null, 'plain recipes not a tree');
});
test('parse: branch categories propagated to subtrees', () => {
  const baton = tree.byId.get('meleeWpnBatonT0PipeBaton');
  eq(baton.category, 'Melee', 'baton inherits Melee');
  const stun = tree.byId.get('meleeWpnBatonT2StunBaton');
  eq(stun.category, 'Melee', 'deep child inherits Melee');
  eq(tree.categories.filter(c => c.kind === 'research').length, 12, '12 branches');
  const total = tree.categories.filter(c => c.kind === 'research')
    .reduce((s, c) => s + tree.nodes.filter(n => n.category === c.id).length, 0);
  eq(total, 589, 'every node classified');
});
test('parse: progression display via name_key', () => {
  const deadeye = tree.byId.get('perkDeadEye');
  eq(deadeye.displayEn, 'Dead Eye', 'vanilla english name via name_key');
  assert(deadeye.display && deadeye.display !== '', 'display resolved');
  eq(deadeye.category, 'attPerception', 'category propagated from attribute root');
});
test('parse: bilingual display names', () => {
  const modZh = parseModLocalization(locZh);
  // UL 2.7.01 ships SChinese.txt as a near-empty stub — Chinese comes from the vanilla CSV
  assert(modZh.size >= 1, 'mod SChinese stub size ' + modZh.size);
  if (vanillaLocText) {
    const van = parseVanillaLocalization(vanillaLocText);
    assert(van.en.size > 10000, 'vanilla en map size ' + van.en.size);
  }
  // at least some nodes must get a translated name different from their id
  const translated = tree.nodes.filter(n => n.display !== n.id);
  assert(translated.length > 100, 'translated nodes: ' + translated.length);
});
test('parse: localization resolution (mod overrides vanilla)', () => {
  assert(resolveKey(tree, 'ulmStationResearch_1', 'en') === 'Research Station', 'mod en key');
  const zh = resolveKey(tree, 'ulmStationResearch_1', 'zh');
  assert(zh != null, 'mod zh key resolves: ' + zh);
});
test('parse: branch labels localized', () => {
  const sci = tree.categories.find(c => c.id === 'Science');
  eq(sci.label, '科学与工程', 'Science branch label');
});

// ------------------------------------------------------------------ validator
test('validate: pristine multi-tree data has zero errors', () => {
  const { problems, summary } = validate(tree);
  const errs = problems.filter(p => p.severity === 'error');
  for (const e of errs.slice(0, 5)) console.log('      ERR: ' + e.message);
  eq(summary.errors, 0, 'errors on pristine data');
  console.log(`      (warnings: ${summary.warnings}, infos: ${summary.infos})`);
});
test('validate: catches duplicate id, missing requires, cycle, bad count', () => {
  const t2 = buildTechTree(makeBundle());
  t2.meta.duplicateIds = [{ id: 'researchTier1', sources: [{ file: 'x', line: 1 }, { file: 'x', line: 2 }] }];
  const a = t2.byId.get('researchTier1');
  const b = t2.byId.get('researchTier2');
  a.research.requiresList.push('researchDOES_NOT_EXIST'); // missing dependency
  a.research.requiresList.push('researchTier2');          // cycle via requires
  b.research.requiresList.push('researchTier1');
  b.research.ingredients.push({ name: 'resourcePaper', count: 'abc', dom: null }); // bad count
  rebuildEdges(t2);
  const { problems } = validate(t2);
  const codes = new Set(problems.map(p => p.code));
  assert(codes.has('DuplicateID'), 'DuplicateID');
  assert(codes.has('MissingDependency'), 'MissingDependency');
  assert(codes.has('CircularDependency'), 'CircularDependency');
  assert(codes.has('InvalidResearch'), 'InvalidResearch');
});

// ------------------------------------------------------------------ commands (edit model)
test('commands: setAttr + undo restores byte-identical file', () => {
  const t = buildTechTree(makeBundle());
  const cs = new CommandStack();
  const node = t.byId.get('researchMechanicT1');
  cs.push(cmdSetAttr(t, node, 'unlocked', 'true'));
  assert(generateFiles(t)['Config/Custom/recipes_research.xml'].includes('unlocked="true"'), 'edited value present');
  cs.undo();
  eq(generateFiles(t)['Config/Custom/recipes_research.xml'], researchText, 'undo restores original bytes');
  cs.redo();
  cs.undo();
  eq(generateFiles(t)['Config/Custom/recipes_research.xml'], researchText, 'second undo restores bytes');
});
test('commands: rename cascades to parent references', () => {
  const t = buildTechTree(makeBundle());
  const cs = new CommandStack();
  const node = t.byId.get('researchTier1'); // referenced via parent by researchTier2 etc.
  cs.push(cmdRename(t, node, 'researchTier1Renamed'));
  const xml = generateFiles(t)['Config/Custom/recipes_research.xml'];
  assert(xml.includes('parent="researchTier1Renamed"'), 'children repointed');
  assert(!xml.includes('parent="researchTier1"'), 'old parent refs gone');
  eq(t.byId.get('researchTier1Renamed'), node);
  cs.undo();
  eq(generateFiles(t)['Config/Custom/recipes_research.xml'], researchText, 'undo rename restores bytes');
});
test('commands: delete node + undo', () => {
  const t = buildTechTree(makeBundle());
  const cs = new CommandStack();
  const node = t.byId.get('researchTier2');
  cs.push(cmdDeleteNode(t, node));
  assert(!t.byId.has('researchTier2'), 'gone from model');
  assert(!serializeXML(t.sourceFiles[0].dom).includes('<research name="researchTier2"'), 'gone from XML');
  cs.undo();
  eq(generateFiles(t)['Config/Custom/recipes_research.xml'], researchText, 'undo delete restores bytes');
});
test('commands: duplicate node + undo', () => {
  const t = buildTechTree(makeBundle());
  const cs = new CommandStack();
  const node = t.byId.get('researchTier1');
  cs.push(cmdDuplicateNode(t, node, 'researchTier1Copy'));
  assert(t.byId.has('researchTier1Copy'), 'copy exists');
  const xml = generateFiles(t)['Config/Custom/recipes_research.xml'];
  assert(xml.includes('researchTier1Copy'), 'copy in XML');
  parseXML(xml);
  cs.undo();
  eq(generateFiles(t)['Config/Custom/recipes_research.xml'], researchText);
});
test('commands: add/remove unlock + undo', () => {
  const t = buildTechTree(makeBundle());
  const cs = new CommandStack();
  const node = t.byId.get('researchTier1');
  cs.push(cmdAddResearchChild(t, node, 'unlocks', { name: 'ulmResourceBook' }));
  assert(node.research.unlocks.some(u => u.name === 'ulmResourceBook'), 'unlock added');
  const xml = generateFiles(t)['Config/Custom/recipes_research.xml'];
  parseXML(xml);
  assert(xml.includes('<unlocks name="ulmResourceBook"/>'), 'unlock in XML');
  cs.undo();
  eq(generateFiles(t)['Config/Custom/recipes_research.xml'], researchText, 'add undo restores bytes');
});
test('commands: remove existing unlock + undo', () => {
  const t = buildTechTree(makeBundle());
  const cs = new CommandStack();
  const node = t.byId.get('researchTier1');
  const u = node.research.unlocks[0];
  cs.push(cmdRemoveResearchChild(t, node, u.dom));
  assert(!node.research.unlocks.length, 'unlock removed');
  cs.undo();
  eq(generateFiles(t)['Config/Custom/recipes_research.xml'], researchText, 'remove undo restores bytes');
});
test('generator: pristine tree is not dirty', () => {
  const t = buildTechTree(makeBundle());
  assert(!isDirty(t, generateFiles(t)), 'pristine should not be dirty');
});

// ------------------------------------------------------------------ diff
test('diff: lineDiff detects single attribute change', () => {
  const changed2 = researchText.replace('unlocked="true"', 'unlocked="false"');
  const d = lineDiff(researchText, changed2);
  assert(d.changed, 'changed');
  const dels = d.rows.filter(r => r.type === 'del'), adds = d.rows.filter(r => r.type === 'add');
  assert(dels.length >= 1 && adds.length >= 1, 'diff rows present');
});
test('diff: structuredDiff reports attribute change', () => {
  const t = buildTechTree(makeBundle());
  const cs = new CommandStack();
  const node = [...t.byId.values()].find(n => n.research && n.research.unlocked);
  cs.push(cmdSetAttr(t, node, 'unlocked', 'false'));
  const struct = structuredDiff(t);
  const all = struct.flatMap(f => f.changes);
  const ch = all.find(c => c.kind === 'attr-changed' && c.name === 'unlocked');
  assert(ch, 'unlocked change found');
  eq(ch.old, 'true'); eq(ch.new, 'false');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.error('FAILED: ' + f.name + '\n' + (f.e.stack || f.e.message)); process.exit(1); }

// ------------------------------------------------------------------ helpers
function findResearch(dom, name) {
  let found = null;
  walk(dom, (el) => { if (el.name === 'research' && el.attrs.some(a => a.name === 'name' && a.decoded === name)) found = el; });
  return found;
}
function findContainer(dom, name) {
  let found = null;
  walk(dom, (el) => { if (!found && el.name === name) found = el; });
  return found;
}
function walk(el, fn) {
  if (el.kind === 'element') { fn(el); for (const c of el.children) walk(c, fn); }
  else if (el.kind === 'doc') for (const c of el.children) walk(c, fn);
}
