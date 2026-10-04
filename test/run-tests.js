// Core regression tests (run: npm test / node test/run-tests.js)
// Critical assertions: round-trip byte-identity, research parsing counts,
// bilingual localization, command undo restoring original bytes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseXML, serializeXML, setAttr, makeElement, appendElement, insertElementBefore, removeElement } from '../public/js/xmldom.js';
import { buildTechTree, parseModLocalization, parseVanillaLocalization, resolveKey, searchLangText, findLangMatch, applyDisplayNames, applyCategoryLabels } from '../public/js/parser.js';
import { classifyXml } from '../public/js/scanner.js';
import { validate } from '../public/js/validator.js';
import { generateFiles, isDirty, getGenerateFilesCalls } from '../public/js/generator.js';
import { lineDiff, structuredDiff } from '../public/js/differ.js';
import { CommandStack, cmdSetAttr, cmdSetDomAttr, cmdRename, cmdDeleteNode, cmdDuplicateNode, cmdAddResearchChild, cmdRemoveResearchChild, rebuildEdges } from '../public/js/model.js';

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
test('parser: custom language files power multi-language search', () => {
  // langs/*.txt enter tree.localization.langs for SEARCH only — zh/en display untouched
  const base = buildTechTree(makeBundle());
  const b = makeBundle();
  b.customLangs = [{ name: 'Japanese', path: 'langs/Japanese.txt', bom: null, text: 'researchTier1,リサーチ Tier 1\nperkDeadEyeName,デッドアイ\ngroupScience,Wissenschaft' }];
  const t = buildTechTree(b);
  const jp = t.localization.langs.get('Japanese');
  assert(jp instanceof Map, 'custom lang map stored');
  eq(jp.get('researchTier1'), 'リサーチ Tier 1', 'two-column CSV parsed');
  const node = t.byId.get('researchTier1');
  assert(searchLangText(t, node).includes('リサーチ'), 'search corpus includes translation');
  assert(findLangMatch(t, node, 'リサーチ').includes('Japanese'), 'lang match names the language');
  assert(!findLangMatch(t, node, '存在しない'), 'no match for absent text');
  eq(resolveKey(t, 'researchTier1'), resolveKey(base, 'researchTier1'), 'zh display resolution untouched');
  eq(resolveKey(t, 'researchTier1', 'en'), resolveKey(base, 'researchTier1', 'en'), 'en display resolution untouched');
  // node display names can follow a chosen language (custom file or English)
  const node2 = t.byId.get('researchTier1');
  const autoDisplay = node2.display;
  applyDisplayNames(t, 'Japanese');
  eq(node2.display, 'リサーチ Tier 1', 'display follows the custom language');
  applyDisplayNames(t, '');
  eq(node2.display, autoDisplay, 'auto restores the default chain');
  const perk = t.byId.get('perkDeadEye');
  const enDisplay = perk.displayEn;
  applyDisplayNames(t, 'en');
  eq(perk.display, enDisplay, 'English chosen uses the en column');
  applyDisplayNames(t, '');
  // missing translations fall back to the default chain
  applyDisplayNames(t, 'Japanese');
  const untranslated = [...t.byId.values()].find(n => !t.localization.langs.get('Japanese').has(n.id) && n.kind === 'research');
  if (untranslated) assert(untranslated.display === untranslated.id || untranslated.display === resolveKey(t, untranslated.id) || untranslated.display === resolveKey(t, untranslated.id, 'en'), 'fallback chain for untranslated nodes');
  // left-panel branch labels follow the same display language
  applyCategoryLabels(t, '');
  const sci = t.categories.find(c => c.id === 'Science');
  eq(sci.label, '科学与工程', 'auto keeps built-in zh branch name');
  applyCategoryLabels(t, 'Japanese');
  eq(t.categories.find(c => c.id === 'Science').label, 'Wissenschaft', 'branch label follows custom language');
  applyCategoryLabels(t, 'en');
  const RESEARCH_BRANCH_ZH_SET = new Set(['研究站', '科学与工程', '工具', '通用', '近战武器', '远程武器', '烹饪', '种植', '护甲', '陷阱', '化学', '机械']);
  eq(t.categories.find(c => c.id === 'Science').label, resolveKey(t, 'groupScience', 'en'), 'branch label uses en column for English');
  // regression: Cooking's group key is "groupCookingAndBrewing" — "groupCooking" does
  // not exist, which left the branch showing the Chinese fallback in en/custom modes
  eq(t.categories.find(c => c.id === 'Cooking').label, 'Cooking and Brewing', 'Cooking branch translated');
  for (const c of t.categories.filter(c => c.kind === 'research')) {
    assert(!RESEARCH_BRANCH_ZH_SET.has(c.label), `en mode fully translated: ${c.id} -> ${c.label}`);
  }
  applyCategoryLabels(t, '');
  eq(t.categories.find(c => c.id === 'Science').label, '科学与工程', 'restored');
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
  assert(generateFiles(t)['UndeadLegacy/Config/Custom/recipes_research.xml'].includes('unlocked="true"'), 'edited value present');
  cs.undo();
  eq(generateFiles(t)['UndeadLegacy/Config/Custom/recipes_research.xml'], researchText, 'undo restores original bytes');
  cs.redo();
  cs.undo();
  eq(generateFiles(t)['UndeadLegacy/Config/Custom/recipes_research.xml'], researchText, 'second undo restores bytes');
});
test('commands: undo of attr removal restores original attr slot (byte-identical)', () => {
  // regression: re-adding a removed attr at the END of the list changed attribute
  // order — undo must splice the original attr object back at its captured index
  const t = buildTechTree(makeBundle());
  const cs = new CommandStack();
  const node = t.byId.get('researchTier2'); // has parent="researchTier1" mid-list
  cs.push(cmdSetAttr(t, node, 'parent', undefined));
  assert(!node.dom.attrs.some(a => a.name === 'parent'), 'parent attr removed');
  cs.undo();
  eq(node.dom.attrs.map(a => a.name).indexOf('parent'), 4, 'parent back at original slot');
  eq(generateFiles(t)['UndeadLegacy/Config/Custom/recipes_research.xml'], researchText, 'undo restores exact bytes');
  cs.redo();
  cs.undo();
  eq(generateFiles(t)['UndeadLegacy/Config/Custom/recipes_research.xml'], researchText, 'redo+undo cycle stays byte-identical');
});
test('commands: undo of child-attr removal via cmdSetDomAttr is byte-identical', () => {
  const t = buildTechTree(makeBundle());
  const cs = new CommandStack();
  const node = t.byId.get('researchTier1');
  const unlock = node.research.unlocks[0];
  cs.push(cmdSetDomAttr(t, unlock.dom, 'name', undefined, 'remove unlocks.name', node));
  cs.undo();
  eq(generateFiles(t)['UndeadLegacy/Config/Custom/recipes_research.xml'], researchText, 'undo restores exact bytes');
});
test('commands: ingredient count edit refreshes parsed cache (inspector reads it back)', () => {
  // regression: editing count without the node arg updated the DOM attr but left
  // r.ingredients stale — the inspector re-rendered the input with the old value
  const t = buildTechTree(makeBundle());
  const cs = new CommandStack();
  const node = t.byId.get('researchTier2');
  const ing = node.research.ingredients.find(i => i.name === 'ulmResourceBook');
  const orig = ing.count;
  cs.push(cmdSetDomAttr(t, ing.dom, 'count', '77', 'Set ingredient.count', node));
  eq(node.research.ingredients.find(i => i.name === 'ulmResourceBook').count, '77', 'parsed cache refreshed for inspector');
  cs.undo();
  eq(node.research.ingredients.find(i => i.name === 'ulmResourceBook').count, orig, 'undo refreshes parsed cache too');
  eq(generateFiles(t)['UndeadLegacy/Config/Custom/recipes_research.xml'], researchText, 'undo restores bytes');
});
test('commands: rename cascades to parent references', () => {
  const t = buildTechTree(makeBundle());
  const cs = new CommandStack();
  const node = t.byId.get('researchTier1'); // referenced via parent by researchTier2 etc.
  cs.push(cmdRename(t, node, 'researchTier1Renamed'));
  const xml = generateFiles(t)['UndeadLegacy/Config/Custom/recipes_research.xml'];
  assert(xml.includes('parent="researchTier1Renamed"'), 'children repointed');
  assert(!xml.includes('parent="researchTier1"'), 'old parent refs gone');
  eq(t.byId.get('researchTier1Renamed'), node);
  cs.undo();
  eq(generateFiles(t)['UndeadLegacy/Config/Custom/recipes_research.xml'], researchText, 'undo rename restores bytes');
});
// two-file fixture: rename cascades out of the node's own file into a second XML
const renXmlA = '<Subquake><append xpath="/recipes">\n' +
  '  <research name="renRoot"><unlocks name="renItem"/></research>\n' +
  '  <research name="renChild" parent="renRoot"/>\n' +
  '</append></Subquake>';
const renXmlB = '<Subquake><append xpath="/recipes">\n' +
  '  <research name="renCross" parent="renRoot" requires="renRoot"/>\n' +
  '  <requirement name="ProgressionLevel" progression_name="renRoot"/>\n' +
  '</append></Subquake>';
function makeRenameBundle() {
  const b = makeBundle();
  b.sourceFiles = [
    { mod: 'UndeadLegacy', modRoot: MOD_ROOT, path: 'Config/Custom/rename_a.xml', size: renXmlA.length, sha1: '', bom: null, text: renXmlA, role: 'research' },
    { mod: 'UndeadLegacy', modRoot: MOD_ROOT, path: 'Config/Custom/rename_b.xml', size: renXmlB.length, sha1: '', bom: null, text: renXmlB, role: 'research' },
  ];
  return b;
}
test('commands: rename tracks fileKeys for every mutated file', () => {
  const t = buildTechTree(makeRenameBundle());
  const cs = new CommandStack();
  const node = t.byId.get('renRoot');
  const c = cmdRename(t, node, 'renRootRenamed');
  assert(c.fileKeys instanceof Set, 'fileKeys is a Set');
  eq(c.fileKeys.size, 2, 'own file + cross-file refs');
  assert(c.fileKeys.has('UndeadLegacy/Config/Custom/rename_a.xml'), 'own file tracked');
  assert(c.fileKeys.has('UndeadLegacy/Config/Custom/rename_b.xml'), 'referencing file tracked');
  cs.push(c);
  const files = generateFiles(t);
  const b = files['UndeadLegacy/Config/Custom/rename_b.xml'];
  assert(b.includes('parent="renRootRenamed"'), 'cross-file parent repointed');
  assert(b.includes('requires="renRootRenamed"'), 'cross-file requires repointed');
  assert(b.includes('progression_name="renRootRenamed"'), 'cross-file progression_name repointed');
  cs.undo();
  const restored = generateFiles(t);
  eq(restored['UndeadLegacy/Config/Custom/rename_a.xml'], renXmlA, 'undo restores file A bytes');
  eq(restored['UndeadLegacy/Config/Custom/rename_b.xml'], renXmlB, 'undo restores file B bytes');
});
test('commands: delete node + undo', () => {
  const t = buildTechTree(makeBundle());
  const cs = new CommandStack();
  const node = t.byId.get('researchTier2');
  cs.push(cmdDeleteNode(t, node));
  assert(!t.byId.has('researchTier2'), 'gone from model');
  assert(!serializeXML(t.sourceFiles[0].dom).includes('<research name="researchTier2"'), 'gone from XML');
  cs.undo();
  eq(generateFiles(t)['UndeadLegacy/Config/Custom/recipes_research.xml'], researchText, 'undo delete restores bytes');
});
test('commands: duplicate node + undo', () => {
  const t = buildTechTree(makeBundle());
  const cs = new CommandStack();
  const node = t.byId.get('researchTier1');
  cs.push(cmdDuplicateNode(t, node, 'researchTier1Copy'));
  assert(t.byId.has('researchTier1Copy'), 'copy exists');
  const xml = generateFiles(t)['UndeadLegacy/Config/Custom/recipes_research.xml'];
  assert(xml.includes('researchTier1Copy'), 'copy in XML');
  parseXML(xml);
  cs.undo();
  eq(generateFiles(t)['UndeadLegacy/Config/Custom/recipes_research.xml'], researchText);
});
test('commands: add/remove unlock + undo', () => {
  const t = buildTechTree(makeBundle());
  const cs = new CommandStack();
  const node = t.byId.get('researchTier1');
  cs.push(cmdAddResearchChild(t, node, 'unlocks', { name: 'ulmResourceBook' }));
  assert(node.research.unlocks.some(u => u.name === 'ulmResourceBook'), 'unlock added');
  const xml = generateFiles(t)['UndeadLegacy/Config/Custom/recipes_research.xml'];
  parseXML(xml);
  assert(xml.includes('<unlocks name="ulmResourceBook"/>'), 'unlock in XML');
  cs.undo();
  eq(generateFiles(t)['UndeadLegacy/Config/Custom/recipes_research.xml'], researchText, 'add undo restores bytes');
});
test('commands: remove existing unlock + undo', () => {
  const t = buildTechTree(makeBundle());
  const cs = new CommandStack();
  const node = t.byId.get('researchTier1');
  const u = node.research.unlocks[0];
  cs.push(cmdRemoveResearchChild(t, node, u.dom));
  assert(!node.research.unlocks.length, 'unlock removed');
  cs.undo();
  eq(generateFiles(t)['UndeadLegacy/Config/Custom/recipes_research.xml'], researchText, 'remove undo restores bytes');
});
test('generator: pristine tree is not dirty', () => {
  const t = buildTechTree(makeBundle());
  assert(!isDirty(t, generateFiles(t)), 'pristine should not be dirty');
});
test('generator: generateFilesCalls debug counter increments', () => {
  const t = buildTechTree(makeBundle());
  const before = getGenerateFilesCalls();
  generateFiles(t);
  eq(getGenerateFilesCalls(), before + 1, 'counter increments per call');
});
test('server: iconChain cleared on every scan (no stale inheritance)', () => {
  // static guard: the reset must exist inside scanMods and run before the chain
  // rebuild — otherwise switching Mods directories leaks old Extends/Icon chains
  const src = fs.readFileSync(path.join(HERE, '..', 'server.js'), 'utf8');
  const reset = src.indexOf('delete iconChain[k]');
  const scan = src.indexOf('scanChainsFile(path.join(VANILLA_ROOT');
  assert(reset !== -1, 'iconChain reset statement missing');
  assert(scan !== -1, 'chain scan call not found');
  assert(reset < scan, 'reset must run before the chain scan rebuilds it');
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
