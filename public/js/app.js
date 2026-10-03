// App bootstrap — wires scanner → parser → model → graph → inspector → panels → exporter.
// Multi-mod: the server scans every mod in the Mods folder and classifies tech-tree
// XMLs; dropped XML files are parsed client-side as additional in-memory sources.
import { apiDefaults, apiScan } from './api.js';
import { scanWorkspace, classifyXml } from './scanner.js';
import { buildTechTree } from './parser.js';
import { CommandStack } from './model.js';
import { createGraph } from './graph.js';
import { createInspector } from './inspector.js';
import { createLeftPanel, createBottomPanel } from './panels.js';
import { createExporter } from './exporter.js';
import { validate } from './validator.js';
import { generateFiles, isDirty } from './generator.js';

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
let droppedSources = []; // [{mod:'(drop)', modRoot:null, path, role, text, bom, sha1}]

function toast(msg, kind = 'info') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  ui.toastArea.appendChild(t);
  setTimeout(() => { t.classList.add('fade'); setTimeout(() => t.remove(), 600); }, 4200);
}

function updateStatus(extra = '') {
  if (!tree) { ui.status.textContent = '未加载'; return; }
  const files = generateFiles(tree);
  const dirty = isDirty(tree, files);
  const sel = graph?.state.selected.size || 0;
  const modCount = new Set(tree.nodes.map(n => n.sourceMod)).size;
  ui.status.innerHTML =
    `<b>${tree.mods?.length || 0} 个 Mod</b>` +
    ` · 节点 ${tree.nodes.length} · 边 ${tree.edges.length}` +
    ` · <span class="${dirty ? 'dirty' : 'clean'}">${dirty ? '● 有未导出修改' : '○ 与原始文件一致'}</span>` +
    ` · 选中 ${sel}` +
    (commands.canUndo ? ` · 撤销可用: ${commands.label}` : '') +
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
  graph.setProblemNodes(map);
  graph.render();
  bottom.render();
  updateStatus(`validation: ✖${result.summary.errors} ⚠${result.summary.warnings} ℹ${result.summary.infos}`);
  if (!silent) {
    bottom.switchTo('problems');
    toast(`Validation 完成: ${result.summary.errors} errors / ${result.summary.warnings} warnings / ${result.summary.infos} infos`, result.summary.errors ? 'error' : 'ok');
  }
  return result;
}

async function loadWorkspace(modsDirArg, scanResult) {
  let scan = scanResult;
  if (!scan) {
    toast('扫描 Mods 文件夹…');
    scan = await apiScan(modsDirArg);
    if (!scan.ok) { toast(scan.error, 'error'); return false; }
  }
  const log = (m) => console.log('[scan] ' + m);
  const bundle = await scanWorkspace(scan, log);
  bundle.sourceFiles.push(...droppedSources);
  for (const w of bundle.warnings) console.warn('[scan] ' + w);
  tree = buildTechTree(bundle);
  tree.mods = bundle.mods;

  // reset UI state
  commands.undoStack.length = 0; commands.redoStack.length = 0;
  ctx = { tree, modsDir: bundle.modsDir, cmd, onDirty, refresh: () => { graph.render(); inspector.refresh(); }, filter: null, problems: null, locate, showXml, onError: (m) => toast(m, 'error') };
  initPanels();
  leftPanel.render();
  graph.render();
  graph.fitView({ minScale: 0.55 });
  runValidation(true);
  updateStatus();
  toast(`已加载 ${bundle.mods.length} 个 Mod: ${tree.nodes.length} 节点 / ${tree.edges.length} 边（${[...new Set(tree.nodes.map(n => n.sourceMod))].length} 个 Mod 含科技树）`, 'ok');
  return true;
}

function cmd(factory) {
  try { commands.push(factory()); }
  catch (e) { toast('操作失败: ' + e.message, 'error'); }
}
function onDirty() {
  updateStatus();
  clearTimeout(onDirty._t);
  onDirty._t = setTimeout(() => runValidation(true), 400);
  inspector.refresh();
  graph.render();
}
function locate(id) {
  const n = tree.byId.get(id);
  if (!n) { toast(`节点 "${id}" 不存在`, 'error'); return; }
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
    onSelectionChange: ({ nodes, edge }) => {
      if (nodes && nodes.length >= 1) inspector.show(nodes[0]);
      updateStatus();
    },
    onInspect: (n) => { inspector.show(n); },
    onDirty: () => onDirty(),
    cmd,
    onError: (m) => toast(m, 'error'),
  });
  ctx.graph = graph; // shared with the left panel so its filter object lands on ctx
  inspector = createInspector(ui.right, {
    tree, cmd, onDirty,
    showXml,
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
  exporter = createExporter({
    tree, modsDir: ctx.modsDir,
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
  $('#btnUndo').onclick = () => { const c = commands.undo(); if (c) { onDirty(); toast('撤销: ' + c.label); } };
  $('#btnRedo').onclick = () => { const c = commands.redo(); if (c) { onDirty(); toast('重做: ' + c.label); } };
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
  if (!files.length) { toast('请拖入 .xml 文件', 'error'); return; }
  const dirty = tree ? isDirty(tree, generateFiles(tree)) : false;
  if (dirty && !confirm('拖入将按当前扫描+已拖入文件重建模型，未导出的修改会丢失。继续?')) return;
  let added = 0, skipped = 0;
  for (const f of files) {
    const text = await f.text();
    const role = classifyXml(text);
    if (!role) { skipped++; toast(`无法识别 ${f.name}（未找到 research/progression 结构）`, 'error'); continue; }
    droppedSources = droppedSources.filter(s => s.path !== '(drop)/' + f.name);
    droppedSources.push({ mod: '(拖入)', modRoot: null, path: '(drop)/' + f.name, role, text, bom: null, sha1: '' });
    added++;
    toast(`已识别 ${f.name} → ${role === 'research' ? '研究树' : '进度树'}`, 'ok');
  }
  if (added) {
    await loadWorkspace(null, window.__lastScan);
    graph.fitView({ minScale: 0.4 });
  }
});

// position persistence for dragged definition nodes (IDE view state, not XML)
window.addEventListener('beforeunload', () => {
  if (!tree) return;
  try {
    const pos = {};
    for (const n of tree.nodes) if (n.pos) pos[n.id] = n.pos;
    localStorage.setItem('ul-ide-pos', JSON.stringify(pos));
  } catch { /* ignore */ }
});
function restorePositions() {
  try {
    const pos = JSON.parse(localStorage.getItem('ul-ide-pos') || '{}');
    for (const n of tree.nodes) if (pos[n.id]) n.pos = pos[n.id];
  } catch { /* ignore */ }
}

(async function boot() {
  window.addEventListener('error', (e) => console.error('[ide]', e.message));
  window.__ide = { get tree() { return tree; }, get graph() { return graph; }, get ctx() { return ctx; }, runValidation, loadWorkspace };
  try {
    const scan = await apiDefaults();
    window.__lastScan = scan.ok ? scan : null;
    if (scan.ok) {
      $('#openPath').value = scan.modsDir;
      await loadWorkspace(scan.modsDir, scan);
      restorePositions();
      graph.render();
    } else {
      toast(scan.error || '自动扫描失败 — 请通过 Open Mod 手动指定 Mods 目录', 'error');
      ui.openDialog.showModal();
    }
  } catch (e) {
    toast('初始化失败: ' + e.message, 'error');
    console.error(e);
  }
})();
