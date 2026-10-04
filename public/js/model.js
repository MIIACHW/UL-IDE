// Unified TechTree model + undoable command stack (research tree).
// The model is the single source of truth for the UI; every mutation goes through
// a Command so Undo/Redo can replay it on both the model and the underlying DOM.
import { removeElement } from './xmldom.js';

export function createTechTree() {
  return {
    meta: { modRoot: null, modInfo: null, scannedAt: null },
    sourceFiles: [],      // [{path, text(original), dom, patchType, sha1}]
    categories: [],       // [{id, label, kind, icon}] — the 12 research branches
    nodes: [],            // TechNode[]
    edges: [],            // TechEdge[] — parent + requires
    byId: new Map(),
    localization: { en: new Map(), zh: new Map(), languages: [] },
    icons: { atlases: new Map() },
    unknownCount: 0,
    problems: [],
  };
}

export function makeNode(partial) {
  return Object.assign({
    id: '', kind: 'research', display: '',
    nameKey: null, descKey: null,
    icon: null, category: null,
    parentId: null,
    maxLevel: null, minLevel: null, baseCost: null, costMultiplier: null,
    prerequisites: [],      // progression ProgressionLevel refs [{target, operation, value, ref}]
    sourceMod: null, sourceFile: null, sourceLine: 0, sourcePath: '',
    dom: null,
    research: null,         // research extras {pos, area, unlocks, ingredients, requiresList, unlocked, ...}
    unknownAttrs: [],
    unknownChildren: [],
    pos: null,              // IDE view layout (not XML)
    displayEn: null,
  }, partial);
}

export function makeEdge(partial) {
  return Object.assign({
    id: '', from: null, to: null, type: 'parent', // parent | requires
    label: '', source: null, ref: null,
  }, partial);
}

// ------------------------------------------------------------------ commands
export class CommandStack {
  constructor() { this.undoStack = []; this.redoStack = []; this.listeners = new Set(); }
  onChange(fn) { this.listeners.add(fn); }
  emit() { for (const fn of this.listeners) fn(this); }
  push(cmd) {
    cmd.do();
    this.undoStack.push(cmd);
    this.redoStack.length = 0;
    this.emit();
    return cmd;
  }
  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    cmd.undo();
    this.redoStack.push(cmd);
    this.emit();
    return cmd;
  }
  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    cmd.do();
    this.undoStack.push(cmd);
    this.emit();
    return cmd;
  }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get label() { const c = this.undoStack[this.undoStack.length - 1]; return c ? c.label : ''; }
}

function getAttrSafe(el, name) { const a = el.attrs.find(x => x.name === name); return a ? a.decoded : undefined; }

// Locate "<Mod>/<Config-relative path>" for the file containing this DOM element —
// lets each command report which source file it mutated (for the dirty cache).
function fileKeyOf(tree, dom) {
  let cur = dom;
  while (cur) {
    for (const sf of tree.sourceFiles) if (sf.dom === cur) return `${sf.mod}/${sf.path}`;
    cur = cur.parent;
  }
  return null;
}
function nodeFileKey(tree, node) { return node?.dom ? fileKeyOf(tree, node.dom) : null; }
function setAttrOnDom(el, name, value) {
  if (value === undefined || value === null) {
    el.attrs = el.attrs.filter(x => x.name !== name);
    return;
  }
  let a = el.attrs.find(x => x.name === name);
  if (!a) { a = { name, value, quote: '"', start: -1, raw: null, pre: ' ' }; el.attrs.push(a); }
  a.decoded = String(value); a.value = a.decoded;
  a.raw = null; // force re-encode on serialize
}

// Set a single XML-backed attribute on a research node.
export function cmdSetAttr(tree, node, name, value) {
  const cmd = {
    label: `Set ${node.id}.${name}`,
    fileKey: nodeFileKey(tree, node),
    do() {
      if (this.prev === undefined) this.prev = getAttrSafe(node.dom, name);
      setAttrOnDom(node.dom, name, value);
      applyNodeAttr(node, name, value);
      rebuildEdges(tree);
    },
    undo() {
      setAttrOnDom(node.dom, name, this.prev);
      applyNodeAttr(node, name, this.prev);
      rebuildEdges(tree);
    },
  };
  return cmd;
}
function applyNodeAttr(node, name, value) {
  switch (name) {
    case 'desc': node.descKey = value ?? null; break;
    case 'icon': node.icon = value ?? null; break;
    case 'category': node.category = value || 'research'; break;
    case 'parent': node.parentId = value ?? null; break;
    case 'name_key': node.nameKey = value ?? null; break;
    case 'max_level': node.maxLevel = value == null ? null : parseInt(value, 10); break;
    case 'min_level': node.minLevel = value == null ? null : parseInt(value, 10); break;
    case 'base_skill_point_cost': node.baseCost = value == null ? null : parseFloat(value); break;
    case 'cost_multiplier_per_level': node.costMultiplier = value == null ? null : parseFloat(value); break;
    case 'unlocked': if (node.research) node.research.unlocked = value === 'true'; break;
    case 'pos': if (node.research) { node.research.pos = value ?? null; const [px, py] = (value || '').split(',').map(v => parseFloat(v)); node.research.posX = Number.isFinite(px) ? px : null; node.research.posY = Number.isFinite(py) ? py : null; } break;
    case 'area': if (node.research) node.research.area = value ?? null; break;
    case 'requires': if (node.research) node.research.requiresList = (value || '').split(',').map(s => s.trim()).filter(Boolean); break;
    default: break;
  }
}

// Rename a node id and cascade to every referencing attribute (parent + requires).
export function cmdRename(tree, node, newId) {
  const oldId = node.id;
  const affected = [];
  collectIdRefs(tree, oldId, affected);
  const cmd = {
    label: `Rename ${oldId} → ${newId}`,
    fileKey: nodeFileKey(tree, node),
    do() {
      setAttrOnDom(node.dom, 'name', newId);
      node.id = newId;
      tree.byId.delete(oldId);
      tree.byId.set(newId, node);
      for (const r of affected) setAttrOnDom(r.dom, r.attr, newId);
      refreshRefs(tree, oldId, newId);
    },
    undo() {
      setAttrOnDom(node.dom, 'name', oldId);
      node.id = oldId;
      tree.byId.delete(newId);
      tree.byId.set(oldId, node);
      for (const r of affected) setAttrOnDom(r.dom, r.attr, oldId);
      refreshRefs(tree, newId, oldId);
    },
  };
  return cmd;
}
function collectIdRefs(tree, id, out) {
  for (const sf of tree.sourceFiles) walkElems(sf.dom, (el) => {
    for (const a of el.attrs) {
      if (a.decoded == null) continue;
      if (a.name === 'parent' && a.decoded === id) out.push({ dom: el, attr: 'parent' });
      if (a.name === 'requires' && a.decoded.split(',').map(s => s.trim()).includes(id)) out.push({ dom: el, attr: 'requires' });
      if (a.name === 'progression_name' && a.decoded === id) out.push({ dom: el, attr: 'progression_name' });
    }
  });
}
function walkElems(el, fn) {
  if (el.kind === 'element') { fn(el); for (const c of el.children) if (c.kind === 'element') walkElems(c, fn); }
  else if (el.kind === 'doc') for (const c of el.children) walkElems(c, fn);
}
function refreshRefs(tree, from, to) {
  for (const n of tree.nodes) {
    if (n.parentId === from) n.parentId = to;
    if (n.research) n.research.requiresList = n.research.requiresList.map(r => (r === from ? to : r));
    for (const p of n.prerequisites || []) if (p.target === from) p.target = to;
  }
  for (const e of tree.edges) {
    if (e.from === from) e.from = to;
    if (e.to === from) e.to = to;
  }
}

// Delete a node (and its DOM element). Undo restores the exact removed nodes.
export function cmdDeleteNode(tree, node) {
  const parentDom = node.dom.parent;
  const cmd = {
    label: `Delete ${node.id}`,
    fileKey: nodeFileKey(tree, node),
    do() {
      const idx = parentDom.children.indexOf(node.dom);
      this.removed = removeElement(node.dom);
      this.removedIndex = idx;
      tree.nodes = tree.nodes.filter(n => n !== node);
      tree.byId.delete(node.id);
      tree.edges = tree.edges.filter(e => e.from !== node.id && e.to !== node.id);
    },
    undo() {
      parentDom.children.splice(Math.min(this.removedIndex, parentDom.children.length), 0, ...this.removed);
      tree.nodes.push(node);
      tree.byId.set(node.id, node);
      rebuildEdges(tree);
    },
  };
  return cmd;
}

// Duplicate a node: deep-clone DOM next to the original, assign a fresh id.
export function cmdDuplicateNode(tree, node, newId) {
  let cloneDom = null, cloneNode = null;
  const cmd = {
    label: `Duplicate ${node.id} → ${newId}`,
    fileKey: nodeFileKey(tree, node),
    do() {
      if (!cloneDom) {
        cloneDom = cloneElementDom(node.dom);
        setAttrOnDom(cloneDom, 'name', newId);
      }
      const parentDom = node.dom.parent;
      const idx = parentDom.children.indexOf(node.dom);
      const prev = idx > 0 ? parentDom.children[idx - 1] : null;
      const wsSrc = prev && prev.kind === 'text' && /\n/.test(prev.text) ? prev : null;
      const wsClone = { kind: 'text', text: wsSrc ? wsSrc.text : ' ', _auto: true, parent: parentDom };
      cloneDom.parent = parentDom;
      parentDom.children.splice(idx + 1, 0, wsClone, cloneDom);
      if (!cloneNode || !tree.nodes.includes(cloneNode)) {
        cloneNode = makeNode({
          id: newId, kind: node.kind, descKey: node.descKey, icon: node.icon,
          category: node.category, parentId: node.parentId,
          sourceFile: node.sourceFile, dom: cloneDom,
        });
        cloneNode.research = { ...node.research, dom: cloneDom, unlocks: [], ingredients: [], requiresList: node.research.requiresList.slice() };
        reparseResearch(cloneNode);
        tree.nodes.push(cloneNode);
        tree.byId.set(newId, cloneNode);
      }
      rebuildEdges(tree);
    },
    undo() {
      removeElement(cloneDom);
      tree.nodes = tree.nodes.filter(n => n !== cloneNode);
      tree.byId.delete(newId);
      tree.edges = tree.edges.filter(e => !(e.from === newId || e.to === newId));
    },
  };
  return cmd;
}
function cloneElementDom(el) {
  if (el.kind !== 'element') return { kind: el.kind, text: el.text, parent: null, children: [] };
  const c = { kind: 'element', name: el.name, selfClosing: el.selfClosing, parent: null, start: -1, line: -1, children: [], attrs: (el.attrs || []).map(a => ({ ...a })) };
  for (const ch of el.children) { const cc = cloneElementDom(ch); cc.parent = c; c.children.push(cc); }
  return c;
}

// Generic DOM attribute edit (unlock names, ingredient names/counts, unknown attrs).
// Pass `node` when the element belongs to a research node so its parsed cache refreshes.
export function cmdSetDomAttr(tree, dom, name, value, label, node) {
  const cmd = {
    label: label || `Set ${name}`,
    fileKey: fileKeyOf(tree, dom),
    do() {
      if (this.hadAttr === undefined) {
        const a = dom.attrs.find(x => x.name === name);
        this.hadAttr = !!a;
        this.prevVal = a ? a.decoded : undefined;
      }
      setAttrOnDom(dom, name, value);
      if (node) reparseResearch(node);
      rebuildEdges(tree);
    },
    undo() {
      if (this.hadAttr) setAttrOnDom(dom, name, this.prevVal);
      else setAttrOnDom(dom, name, undefined);
      if (node) reparseResearch(node);
      rebuildEdges(tree);
    },
  };
  return cmd;
}

// Add a child element (unlocks / ingredient) to a research node.
export function cmdAddResearchChild(tree, node, kind, attrs = {}) {
  let dom = null;
  const cmd = {
    label: `Add ${kind} to ${node.id}`,
    fileKey: nodeFileKey(tree, node),
    do() {
      if (!dom) {
        dom = { kind: 'element', name: kind, attrs: [], children: [], selfClosing: true, parent: null, start: -1, line: -1 };
        for (const [k, v] of Object.entries(attrs)) {
          dom.attrs.push({ name: k, value: String(v), decoded: String(v), quote: '"', start: -1, raw: null, pre: ' ' });
        }
      }
      if (!node.dom.children.includes(dom)) insertInContainer(tree, node.dom, dom, kind);
      reparseResearch(node);
      rebuildEdges(tree);
    },
    undo() {
      removeElement(dom);
      reparseResearch(node);
      rebuildEdges(tree);
    },
  };
  return cmd;
}

// Remove a child element (unlocks / ingredient) from a research node.
export function cmdRemoveResearchChild(tree, node, childDom) {
  let removed = null;
  const cmd = {
    label: `Remove ${childDom.name} from ${node.id}`,
    fileKey: nodeFileKey(tree, node),
    do() {
      removed = removeElement(childDom);
      reparseResearch(node);
      rebuildEdges(tree);
    },
    undo() {
      const extra = (removed || []).filter(x => x !== childDom);
      const anchor = node.dom.children.indexOf(extra[0]);
      node.dom.children.splice(anchor >= 0 ? anchor : node.dom.children.length, 0, ...extra, childDom);
      childDom.parent = node.dom;
      reparseResearch(node);
      rebuildEdges(tree);
    },
  };
  return cmd;
}

// Refresh parsed research structures after DOM edits.
export function reparseResearch(node) {
  if (!node.research) return;
  const r = node.research;
  r.unlocks = []; r.ingredients = [];
  node.unknownChildren = node.unknownChildren || [];
  for (const c of node.dom.children) {
    if (c.kind !== 'element') continue;
    const a = {};
    for (const at of c.attrs) if (at.decoded !== null) a[at.name] = at.decoded;
    if (c.name === 'unlocks') r.unlocks.push({ name: a.name || '', craftable: a.craftable, dom: c });
    else if (c.name === 'ingredient') r.ingredients.push({ name: a.name || '', count: a.count || '', dom: c });
  }
  const attrs = {};
  for (const at of node.dom.attrs) if (at.decoded !== null) attrs[at.name] = at.decoded;
  r.requiresList = (attrs.requires || '').split(',').map(s => s.trim()).filter(Boolean);
  r.unlocked = attrs.unlocked === 'true';
  r.area = attrs.area || null; r.pos = attrs.pos || null;
  const [px, py] = (attrs.pos || '').split(',').map(v => parseFloat(v));
  r.posX = Number.isFinite(px) ? px : null; r.posY = Number.isFinite(py) ? py : null;
}

function insertInContainer(tree, container, dom, kind) {
  // insert before the container's closing whitespace; the new element carries its own _auto ws
  const kids = container.children;
  const lastElem = [...kids].reverse().find(c => c.kind === 'element');
  if (lastElem) {
    const idx = kids.indexOf(lastElem);
    const after = kids[idx + 1];
    const ws = after && after.kind === 'text' && /\n/.test(after.text || '') ? after : null;
    const wsClone = { kind: 'text', text: ws ? ws.text : ' ', _auto: true, parent: container };
    kids.splice(ws ? kids.indexOf(ws) : idx + 1, 0, wsClone, dom);
  } else {
    kids.push({ kind: 'text', text: '\n', _auto: true, parent: container }, dom);
  }
  dom.parent = container;
}

// Full edge rebuild from model (cheap at this scale, keeps edges consistent after edits)
export function rebuildEdges(tree) {
  const edges = [];
  const byId = tree.byId;
  for (const n of tree.nodes) {
    if (n.parentId && byId.has(n.parentId)) {
      edges.push(makeEdge({ id: `p:${n.id}`, from: n.parentId, to: n.id, type: 'parent', source: n.sourceFile }));
    }
    if (n.kind === 'research' && n.research) {
      for (const r of n.research.requiresList) {
        edges.push(makeEdge({ id: `rq:${n.id}:${r}`, from: r, to: n.id, type: 'requires', label: 'requires', source: n.sourceFile }));
      }
    }
    for (const p of n.prerequisites || []) {
      edges.push(makeEdge({ id: `q:${n.id}:${p.target}`, from: p.target, to: n.id, type: 'prerequisite', label: (p.operation || '') + ' ' + (p.value || ''), ref: p.ref, source: n.sourceFile }));
    }
  }
  tree.edges = edges;
}
