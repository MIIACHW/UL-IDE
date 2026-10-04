// App bootstrap — wires scanner → parser → model → graph → inspector → panels → exporter.
// Multi-mod: the server scans every mod in the Mods folder and classifies tech-tree
// XMLs; dropped XML files are parsed client-side as additional in-memory sources.
import { apiDefaults, apiScan, apiAddLang, apiDeleteLang } from './api.js';
import { scanWorkspace, classifyXml } from './scanner.js';
import { buildTechTree, searchLangText, findLangMatch, applyDisplayNames, applyCategoryLabels } from './parser.js';
import { CommandStack } from './model.js';
import { createGraph } from './graph.js';
import { createInspector } from './inspector.js';
import { createLeftPanel, createBottomPanel } from './panels.js';
import { createExporter } from './exporter.js';
import { validate } from './validator.js';
import { generateFiles, getGenerateFilesCalls } from './generator.js';
import { t, getLang, setLang, applyStatic } from './i18n.js';

const $ = (sel) => document.querySelector(sel);

const ui = {
  status: $('#status'),
  left: $('#left'),
  center: $('#center'),
  right: $('#right'),
  bottom: $('#bottom'),
  toastArea: $('#toasts'),
  openDialog: $('#openDialog'),
};

let tree = null;
let ctx = null;
let graph = null;
let inspector = null;
let leftPanel = null;
let bottom = null;
let exporter = null;
const commands = new CommandStack();
let droppedSources = [];
let includeProgression = false; // explicit opt-in — progression files never load by default
// dirty cache — updated only when a command actually mutates a DOM (never on selection)
const dirtyFiles = new Set();
let dirty = false;
function markDirty(fileKey) {
  if (fileKey) dirtyFiles.add(fileKey);
  dirty = true;
}
function clearDirty() { dirtyFiles.clear(); dirty = false; }
// view dirty — node.pos is IDE layout state (persisted to localStorage), never XML.
// Drags set ONLY this flag; the export pipeline and the dirty status stay untouched.
let viewDirty = false;
function markViewDirty() {
  viewDirty = true;
  savePositions(); // persist layout immediately — a crash must not lose it
  updateStatus();
}
// precise recompute (serialize once per file) — used by Undo/Redo, not by clicks
function recomputeDirty() {
  window.__dirtyLog = window.__dirtyLog || [];
  window.__dirtyLog.push('recompute:enter dirty=' + dirty + ' files=' + [...dirtyFiles].join('|'));
  if (!tree) { clearDirty(); return; }
  const files = generateFiles(tree);
  dirtyFiles.clear();
  for (const [key, text] of Object.entries(files)) {
    const sf = tree.sourceFiles.find(f => `${f.mod}/${f.path}` === key);
    if (!sf) { dirtyFiles.add(key); continue; }
    let cmp = text;
    if (cmp.charCodeAt(0) === 0xFEFF) cmp = cmp.slice(1);
    if (sf.text !== cmp) {
      dirtyFiles.add(key);
      window.__recomputeDiff = { key, at: (function () { const a = sf.text, b = cmp; for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return i; return -1; })(), sfLen: sf.text.length, cmpLen: cmp.length, sfDomLen: serializeLength(sf.dom) };
    }
  }
  dirty = dirtyFiles.size > 0;
  window.__dirtyLog.push('recompute:exit dirty=' + dirty + ' files=' + [...dirtyFiles].join('|'));
}
function serializeLength(dom) {
  try {
    const mod = window.__lenProbe;
    return -1;
  } catch (e) { return -1; }
} // [{mod:'(drop)', modRoot:null, path, role, text, bom, sha1}]

function toast(msg, kind = 'info') {
  const t2 = document.createElement('div');
  t2.className = 'toast ' + kind;
  t2.textContent = msg;
  ui.toastArea.appendChild(t2);
  setTimeout(() => { t2.classList.add('fade'); setTimeout(() => t2.remove(), 600); }, 4200);
}

// The toggle shows the language you would switch TO.
function refreshLangButton() {
  const b = $('#btnLang');
  if (b) b.textContent = getLang() === 'zh' ? 'EN' : '中文';
}

// Node-name display language: '' = auto (zh → en), 'en', or a custom langs/ file name.
function displayLang() {
  try { return localStorage.getItem('ul-ide-display-lang') || ''; } catch { return ''; }
}
function setDisplayLang(l) {
  try { localStorage.setItem('ul-ide-display-lang', l || ''); } catch { /* private mode */ }
}

function updateStatus(extra = '') {
  if (!tree) { ui.status.textContent = t('status.unloaded'); return; }
  // uses the dirty cache — selecting/panning/zooming never serializes XML here
  const sel = graph?.state.selected.size || 0;
  ui.status.innerHTML =
    `<b>${t('status.mods', { n: tree.mods?.length || 0 })}</b>` +
    ` · ${t('status.nodesEdges', { n: tree.nodes.length, m: tree.edges.length })}` +
    ` · <span class="${dirty ? 'dirty' : 'clean'}">${dirty ? t('status.dirty', { n: dirtyFiles.size }) : t('status.clean')}</span>` +
    (viewDirty ? ` · <span class="clean">${t('status.viewDirty')}</span>` : '') +
    ` · ${t('status.selected', { n: sel })}` +
    (commands.canUndo ? ` · ${t('status.undoAvailable', { label: commands.label })}` : '') +
    (extra ? ` · ${extra}` : '');
}

function runValidation(silent = false) {
  if (!tree) return;
  const result = validate(tree);
  ctx.problems = result;
  const map = new Map();
  for (const p of result.problems) {
    if (!p.nodeId) continue;
    const rank = { error: 0, warning: 1, info: 2 };
    const cur = map.get(p.nodeId);
    if (!cur || rank[p.severity] < rank[cur]) map.set(p.nodeId, p.severity);
  }
  graph.setProblemNodes(map); // incremental problem-marker update — no full render
  bottom.render();
  updateStatus(`validation: ✖${result.summary.errors} ⚠${result.summary.warnings} ℹ${result.summary.infos}`);
  if (!silent) {
    bottom.switchTo('problems');
    toast(t('status.validation', { e: result.summary.errors, w: result.summary.warnings, i: result.summary.infos }), result.summary.errors ? 'error' : 'ok');
  }
  return result;
}

async function loadWorkspace(modsDirArg, scanResult) {
  clearDirty();
  viewDirty = false; // layout state is restored from localStorage below
  let scan = scanResult;
  if (!scan) {
    toast(t('toast.scanning'));
    scan = await apiScan(modsDirArg);
    if (!scan.ok) { toast(scan.error, 'error'); return false; }
  }
  const log = (m) => console.log('[scan] ' + m);
  const bundle = await scanWorkspace(scan, log, { includeProgression });
  bundle.sourceFiles.push(...droppedSources);
  for (const w of bundle.warnings) console.warn('[scan] ' + w);
  tree = buildTechTree(bundle);
  tree.mods = bundle.mods;
  applyDisplayNames(tree, displayLang()); // chosen node-name language (default zh→en)
  applyCategoryLabels(tree, displayLang()); // left-panel branch labels follow it too

  // reset UI state
  commands.undoStack.length = 0; commands.redoStack.length = 0;
  ctx = { tree, modsDir: bundle.modsDir, cmd, onDirty, refresh: () => { graph.render(); inspector.refresh(); }, filter: null, problems: null, locate, showXml, onError: (m) => toast(m, 'error') };
  initPanels();
  leftPanel.render();
  restorePositions(); // view state only — picked up by the single initial render below
  graph.render();
  runValidation(true);
  updateStatus();
  graph.fitView({ minScale: 0.55 }); // LAST — the transform must survive everything above
  toast(t('toast.loaded', { n: bundle.mods.length, nodes: tree.nodes.length, edges: tree.edges.length, m: [...new Set(tree.nodes.map(n => n.sourceMod))].length }), 'ok');
  return true;
}

function cmd(factory) {
  try {
    const c = commands.push(factory());
    // a command may mutate several files (e.g. rename cascades into parent/requires/
    // progression_name attrs in other XMLs) — every touched file must be tracked
    const keys = c && c.fileKeys instanceof Set && c.fileKeys.size
      ? c.fileKeys
      : (c && c.fileKey ? new Set([c.fileKey]) : null);
    if (keys) { for (const k of keys) markDirty(k); } else markDirty(null);
    updateStatus();
  }
  catch (e) { toast(t('toast.opFailed', { msg: e.message }), 'error'); }
}
function onDirty(hint) {
  updateStatus();
  clearTimeout(onDirty._t);
  onDirty._t = setTimeout(() => runValidation(true), 400);
  inspector.refresh();
  if (hint && hint.type === 'content' && hint.node) {
    // icon/id/display edit — single node DOM refresh, edges only re-keyed on rename
    graph.updateNodeContent(hint.node, hint.prevId);
    if (hint.prevId) graph.syncEdges();
  } else if (hint && hint.type === 'panel') {
    // inspector-only change (unlocks/ingredients/…): graph DOM untouched
  } else {
    graph.syncModel(); // incremental DOM/edge sync — no full rebuild, no XML serialization
  }
}
function locate(id) {
  const n = tree.byId.get(id);
  if (!n) { toast(t('locate.missing', { id }), 'error'); return; }
  graph.selectNode(id, { focus: true });
  inspector.show(n);
}
function showXml(node) {
  const sfIndex = tree.sourceFiles.findIndex(f => f.path === node.sourceFile && f.mod === node.sourceMod);
  bottom.switchTo('xml');
  bottom.render();
  if (sfIndex >= 0) bottom.setActiveXmlFile(sfIndex);
  ctx.scrollToLine?.(node.sourceLine);
}

function initPanels() {
  ui.center.textContent = '';
  graph = createGraph(ui.center, tree, {
    get filter() { return ctx.filter; }, // live reference — panels replace the object after init
    searchText: (n) => searchLangText(tree, n), // multi-language search corpus (langs/*.txt)
    onSelectionChange: ({ nodes, edge }) => {
      if (nodes && nodes.length >= 1) inspector.show(nodes[0]);
      updateStatus();
    },
    onInspect: (n) => { inspector.show(n); },
    onDirty: () => onDirty(),
    onViewDirty: () => markViewDirty(),
    cmd,
    onError: (m) => toast(m, 'error'),
  });
  ctx.graph = graph; // shared with the left panel so its filter object lands on ctx
  inspector = createInspector(ui.right, {
    tree, cmd, onDirty,
    showXml,
    searchLangText: (n) => searchLangText(tree, n),
    findLangMatch: (n, ql) => findLangMatch(tree, n, ql),
    onError: (m) => toast(m, 'error'),
  });
  inspector.show(null);
  leftPanel = createLeftPanel(ui.left, ctx);
  bottom = createBottomPanel(ui.bottom.querySelector('.bp-inner'), {
    tree,
    validateNow: () => runValidation(false),
    locate,
    get problems() { return ctx.problems; },
  });
  ctx.showProblems = () => { bottom.switchTo('problems'); bottom.render(); };
  ctx.onIncludeProgression = (v) => {
    if (v === includeProgression) return;
    if (dirty && !confirm(t('confirm.reloadDirty'))) { leftPanel.render(); return; }
    includeProgression = v;
    loadWorkspace(null, window.__lastScan);
  };
  // user-added language files (server persists them under langs/) — after adding or
  // removing one, re-scan so the new language enters the search corpus
  async function rescanWorkspace() {
    const scan = await apiDefaults();
    if (!scan.ok) { toast(scan.error || '重新扫描失败', 'error'); return false; }
    window.__lastScan = scan;
    return loadWorkspace(scan.modsDir, scan);
  }
  ctx.addLanguageFile = async (file) => {
    if (!file) return;
    const text = await file.text();
    const name = file.name.replace(/\.txt$/i, '');
    const entries = text.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#')).length;
    if (!entries) { toast(t('toast.langEmpty'), 'error'); return; }
    if (dirty && !confirm(t('confirm.langReload'))) return;
    try {
      const r = await apiAddLang(name, text);
      toast(t('toast.langAdded', { name: r.name, n: r.entries }), 'ok');
      await rescanWorkspace();
    } catch (e) { toast(t('toast.langAddFailed', { msg: e.message }), 'error'); }
  };
  ctx.removeLanguageFile = async (name) => {
    if (!confirm(t('confirm.langDelete', { name }))) return;
    if (dirty && !confirm(t('confirm.reloadDirty'))) return;
    try {
      await apiDeleteLang(name);
      toast(t('toast.langDeleted', { name }), 'ok');
      await rescanWorkspace();
    } catch (e) { toast(t('toast.langDelFailed', { msg: e.message }), 'error'); }
  };
  // node-name display language — pure model/label update, no reload needed
  ctx.changeDisplayLang = (lang) => {
    setDisplayLang(lang);
    applyDisplayNames(tree, lang);
    applyCategoryLabels(tree, lang);
    graph.relabelAll();
    leftPanel.render(); // branch labels live in the left panel
    inspector.refresh();
  };
  // UI language toggle — static chrome + all dynamically rendered panels
  $('#btnLang').onclick = () => {
    setLang(getLang() === 'zh' ? 'en' : 'zh');
    applyStatic();
    refreshLangButton();
    leftPanel.render();
    bottom.render();
    updateStatus();
    inspector.refresh();
  };
  exporter = createExporter({
    tree, modsDir: ctx.modsDir,
    isDirty: () => dirty,
    showProblems: () => ctx.showProblems(),
    toast,
    log: (m) => console.log('[export] ' + m),
  });
  // topbar actions
  $('#btnFit').onclick = () => graph.fitView();
  $('#btnValidate').onclick = () => runValidation(false);
  $('#btnDiff').onclick = () => { bottom.switchTo('diff'); bottom.render(); };
  $('#btnExport').onclick = () => exporter.run({ confirmWrite: true }).then(r => { if (r?.ok) updateStatus(); });
  $('#btnSave').onclick = () => exporter.run({ confirmWrite: true }).then(r => { if (r?.ok) updateStatus(); });
  $('#btnUndo').onclick = () => { try { const c = commands.undo(); if (c) { recomputeDirty(); onDirty(); toast(t('toast.undone', { label: c.label })); } } catch (e) { toast(t('toast.undoFailed', { msg: e.message }), 'error'); console.error(e); } };
  $('#btnRedo').onclick = () => { const c = commands.redo(); if (c) { recomputeDirty(); onDirty(); toast(t('toast.redone', { label: c.label })); } };
  $('#btnOpen').onclick = () => ui.openDialog.showModal();
  $('#btnOpenGo').onclick = async () => {
    const path = $('#openPath').value.trim();
    ui.openDialog.close();
    if (path) await loadWorkspace(path);
  };
  $('#btnOpenDefault').onclick = async () => { ui.openDialog.close(); await loadWorkspace(null, window.__lastScan); };
  $('#bottomResizer').addEventListener('mousedown', startBottomResize);
  updateStatus();
}

function startBottomResize(ev) {
  ev.preventDefault();
  const startY = ev.clientY, startH = ui.bottom.offsetHeight;
  const move = (e) => {
    const h = Math.min(window.innerHeight - 220, Math.max(120, startH + (startY - e.clientY)));
    ui.bottom.style.height = h + 'px';
    window.dispatchEvent(new Event('resize'));
  };
  const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

window.addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') { ev.preventDefault(); $('#btnUndo').click(); }
  else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'y') { ev.preventDefault(); $('#btnRedo').click(); }
  else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); $('#btnSave').click(); }
  else if (ev.key === 'f' && !ev.ctrlKey && !ev.metaKey && document.activeElement.tagName !== 'INPUT') { ev.preventDefault(); graph?.fitView(); }
});

// drag & drop: drop any tech-tree XML onto the window — auto-recognized by structure
// (research-style or progression-style) and added as an in-memory source; export via
// browser download since there is no mod path to write back to.
window.addEventListener('dragover', (ev) => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('drop', async (ev) => {
  ev.preventDefault();
  const files = [...(ev.dataTransfer?.files || [])].filter(f => /\.xml$/i.test(f.name));
  if (!files.length) { toast(t('drop.noXml'), 'error'); return; }
  if (dirty && !confirm(t('confirm.dropReload'))) return;
  let added = 0, skipped = 0;
  for (const f of files) {
    const text = await f.text();
    const role = classifyXml(text, f.name);
    if (!role) { skipped++; toast(t('drop.unknown', { name: f.name }), 'error'); continue; }
    droppedSources = droppedSources.filter(s => s.path !== '(drop)/' + f.name);
    droppedSources.push({ mod: '(拖入)', modRoot: null, path: '(drop)/' + f.name, role, text, bom: null, sha1: '' });
    added++;
    toast(t('drop.recognized', { name: f.name, role: role === 'research' ? t('drop.roleResearch') : t('drop.roleProgression') }), 'ok');
  }
  if (added) {
    await loadWorkspace(null, window.__lastScan);
    graph.fitView({ minScale: 0.4 });
  }
});

// position persistence for dragged definition nodes (IDE view state, not XML)
function savePositions() {
  if (!tree) return;
  try {
    const pos = {};
    for (const n of tree.nodes) if (n.pos) pos[n.id] = n.pos;
    localStorage.setItem('ul-ide-pos', JSON.stringify(pos));
  } catch { /* ignore */ }
}
window.addEventListener('beforeunload', savePositions);
function restorePositions() {
  try {
    const pos = JSON.parse(localStorage.getItem('ul-ide-pos') || '{}');
    for (const n of tree.nodes) {
      const p = pos[n.id];
      // only finite numeric positions are restorable — NaN/garbage would poison
      // the layout and leave the graph unviewable
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) n.pos = { x: p.x, y: p.y };
    }
  } catch { /* ignore */ }
}

(async function boot() {
  window.addEventListener('error', (e) => { (window.__errs = window.__errs || []).push(e.message + ' @ ' + (e.filename || '').split('/').pop() + ':' + e.lineno); console.error('[ide]', e.message); });
  window.__ide = { get tree() { return tree; }, get graph() { return graph; }, get ctx() { return ctx; }, runValidation, loadWorkspace };
  window.__ide.debug = {
    get fullRenders() { return graph?.stats?.fullRenders ?? 0; },
    get selectionUpdates() { return graph?.stats?.selectionUpdates ?? 0; },
    get nodeCreates() { return graph?.stats?.nodeCreates ?? 0; },
    get edgeCreates() { return graph?.stats?.edgeCreates ?? 0; },
    get iconRequests() { return graph?.stats?.iconRequests ?? 0; },
    get generateFilesCalls() { return getGenerateFilesCalls(); },
    get dirtyFiles() { return [...dirtyFiles]; },
    get dirty() { return dirty; },
    get viewDirty() { return viewDirty; },
  };
  applyStatic();
  refreshLangButton();
  try {
    const scan = await apiDefaults();
    window.__lastScan = scan.ok ? scan : null;
    if (scan.ok) {
      $('#openPath').value = scan.modsDir;
      await loadWorkspace(scan.modsDir, scan);
    } else {
      toast(scan.error || t('toast.scanFallback'), 'error');
      ui.openDialog.showModal();
    }
  } catch (e) {
    toast(t('toast.initFailed', { msg: e.message }), 'error');
    console.error(e);
  }
})();
