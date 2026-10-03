// Technology Graph Canvas — SVG based, zero dependencies. Research tree only,
// mirroring the in-game ULM_ResearchWindow: layered tidy tree, roots on a bottom
// rail, children above, ordered by the pos="x,y" hint, item icons + localized names.
// Interactions: pan, zoom, node drag, box select, edge selection, culling.

const NS = 'http://www.w3.org/2000/svg';
const NODE_R = 26;            // half-size of the icon box
const CELL_X = 62, CELL_Y = 96;

const EDGE_COLORS = { parent: '#5a6572', requires: '#c96f6f' };

function el(name, attrs = {}, parent) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

export function createGraph(container, tree, hooks) {
  const svg = el('svg', { class: 'graph-svg' });
  container.appendChild(svg);
  const gEdges = el('g', { class: 'edges' }, svg);
  const gNodes = el('g', { class: 'nodes' }, svg);
  const gRubber = el('g', {}, svg);

  const state = {
    scale: 0.55, panX: 120, panY: 60,
    selected: new Set(), selectedEdge: null,
    visible: new Set(),
    hiddenEdges: new Set(),
    problemNodes: new Map(),
    search: '',
    dragging: null,
    nodePos: new Map(),
  };

  function applyTransform() {
    svg.querySelector('.viewport')?.setAttribute('transform', `translate(${state.panX},${state.panY}) scale(${state.scale})`);
  }

  // ---------------------------------------------------------- layout
  // Layered tidy tree: depth = longest path from a root; x by leaf packing with
  // siblings sorted by the pos="x,y" hint (the game's DLL does the same).
  function layoutResearch() {
    state.nodePos.clear();
    const researchNodes = tree.nodes.filter(n => n.kind === 'research');
    const children = new Map();
    for (const n of researchNodes) {
      const p = n.parentId && tree.byId.get(n.parentId)?.kind === 'research' ? n.parentId : null;
      if (p) { if (!children.has(p)) children.set(p, []); children.get(p).push(n); }
    }
    const depthCache = new Map();
    const depthOf = (n, seen = new Set()) => {
      if (depthCache.has(n.id)) return depthCache.get(n.id);
      if (seen.has(n.id)) return 0;
      seen.add(n.id);
      const kids = children.get(n.id) || [];
      let d = 0;
      for (const k of kids) d = Math.max(d, depthOf(k, seen) + 1);
      depthCache.set(n.id, d);
      return d;
    };
    for (const n of researchNodes) depthOf(n);
    for (const [, list] of children) {
      list.sort((a, b) => (a.research?.posX ?? 0) - (b.research?.posX ?? 0) || a.sourceLine - b.sourceLine);
    }
    let leafX = 0;
    const place = (n) => {
      const kids = children.get(n.id) || [];
      let x;
      if (kids.length === 0) { x = leafX * CELL_X; leafX++; }
      else { x = kids.reduce((s, k) => s + place(k), 0) / kids.length; }
      state.nodePos.set(n.id, { x, y: -depthOf(n) * CELL_Y, root: !n.parentId });
      return x;
    };
    const roots = researchNodes.filter(n => !n.parentId || tree.byId.get(n.parentId)?.kind !== 'research')
      .sort((a, b) => (a.research?.posX ?? 0) - (b.research?.posX ?? 0) || a.sourceLine - b.sourceLine);
    for (const r of roots) { if (leafX > 0) leafX += 1; place(r); }
    // user-dragged IDE positions win (view state only — the game auto-lays-out too)
    for (const n of researchNodes) {
      if (n.pos && state.nodePos.has(n.id)) state.nodePos.set(n.id, { ...state.nodePos.get(n.id), ...n.pos });
    }
  }

  // ---------------------------------------------------------- filtering
  function matchesFilter(n) {
    if (n.kind !== 'research') return false;
    const f = hooks.filter;
    if (f) {
      if (f.kinds && f.kinds.size && !f.kinds.has(n.kind)) return false;
      if (f.categories && f.categories.size && !f.categories.has(n.category)) return false;
      if (f.onlyProblems && !state.problemNodes.has(n.id)) return false;
    }
    if (state.search) {
      const q = state.search.toLowerCase();
      const hay = `${n.id} ${n.display || ''} ${n.displayEn || ''} ${n.descKey || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function computeVisible() {
    state.visible.clear();
    for (const n of tree.nodes) if (matchesFilter(n)) state.visible.add(n.id);
  }

  // ---------------------------------------------------------- render
  function render() {
    layoutResearch();
    computeVisible();
    gEdges.textContent = '';
    gNodes.textContent = '';
    let vp = null;
    for (const c of svg.children) if (c.classList?.contains('viewport')) { vp = c; break; }
    if (!vp) vp = el('g', { class: 'viewport' }, svg);
    if (gEdges.parentNode !== vp) vp.appendChild(gEdges);
    if (gNodes.parentNode !== vp) vp.appendChild(gNodes);
    if (gRubber.parentNode !== vp) vp.appendChild(gRubber);

    // edges — game-style orthogonal connectors
    for (const e of tree.edges) {
      if (state.hiddenEdges.has(e.type)) continue;
      const a = state.nodePos.get(e.from), b = state.nodePos.get(e.to);
      if (!a || !b || !state.visible.has(e.from) || !state.visible.has(e.to)) continue;
      const sel = state.selectedEdge === e.id;
      const color = EDGE_COLORS[e.type] || '#888';
      const yTop = a.y - NODE_R;
      const yBot = b.y + NODE_R;
      const railY = yBot + (yTop - yBot) / 2;
      const pts = [[a.x, yTop], [a.x, railY], [b.x, railY], [b.x, yBot]];
      const path = el('path', {
        d: 'M' + pts.map(p => p.join(',')).join(' L'),
        fill: 'none', stroke: color, 'stroke-width': sel ? 2.4 : 1.1,
        opacity: sel ? 1 : 0.6, class: 'edge' + (sel ? ' selected' : ''),
      }, gEdges);
      path.dataset.edgeId = e.id;
      path.addEventListener('mousedown', (ev) => {
        ev.stopPropagation();
        state.selectedEdge = e.id; state.selected.clear();
        hooks.onSelectionChange({ nodes: [], edge: e });
        render();
      });
    }
    // bottom rail through the roots
    const railNodes = tree.nodes.filter(n => n.kind === 'research' && state.visible.has(n.id) && !n.parentId)
      .map(n => state.nodePos.get(n.id)).filter(Boolean).sort((p, q) => p.x - q.x);
    if (railNodes.length > 1) {
      el('line', {
        x1: railNodes[0].x, y1: railNodes[0].y + NODE_R,
        x2: railNodes[railNodes.length - 1].x, y2: railNodes[railNodes.length - 1].y + NODE_R,
        stroke: '#5a6572', 'stroke-width': 1.2, opacity: 0.8, class: 'edge',
      }, gEdges);
    }

    // nodes (culled)
    for (const n of tree.nodes) {
      if (!state.visible.has(n.id)) continue;
      const p = state.nodePos.get(n.id);
      if (!p) continue;
      renderResearchNode(n, p);
    }
    applyTransform();
  }

  // game-style research node: dark box + item icon (fallback chain) + localized name
  const PLACEHOLDER_ICON = '/api/icon?name=missingIcon';
  const S = (inner) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36">' +
    '<g fill="none" stroke="#9aa5b1" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">' + inner + '</g></svg>');
  const SYMBOL_SVGS = {
    door: S('<path d="M11 30V7h14v23"/><path d="M11 30h14"/><circle cx="21.5" cy="19" r="1.2" fill="#9aa5b1"/>'),
    lightbulb: S('<circle cx="18" cy="15" r="7"/><path d="M15.5 24h5M16 27h4"/>'),
    safe: S('<rect x="8" y="9" width="20" height="19" rx="2"/><circle cx="18" cy="18" r="4.5"/><path d="M18 15v6M15 18h6"/><path d="M11 28v3M25 28v3"/>'),
    chair: S('<path d="M13 7v13h11"/><path d="M13 20l-2 9M24 20l3 9"/><path d="M13 12h10"/>'),
    cement: S('<path d="M11 10h14l2 19H9z"/><path d="M13 16h10M13 21h10"/>'),
    cosmetic: S('<rect x="14" y="14" width="8" height="15" rx="2"/><path d="M16 14v-4h4v4"/><path d="M15 7h6"/>'),
    research: S('<path d="M12 8h8l4 4v16h-12z"/><circle cx="19" cy="19" r="4"/><path d="M22 22l4 4"/>'),
    lock: S('<rect x="11" y="16" width="14" height="12" rx="2"/><path d="M13.5 16v-4a4.5 4.5 0 019 0v4"/>'),
    fence: S('<path d="M8 10v20M14 10v20M22 10v20M28 10v20"/><path d="M8 14l20 8M28 14L8 22"/>'),
    corn: S('<path d="M18 8c4 3 5 8 5 12h-10c0-4 1-9 5-12z"/><path d="M18 20v9M13 24l5-3 5 3"/>'),
    wire: S('<path d="M8 12c6 0 6 6 10 6s4-6 10-6"/><circle cx="18" cy="26" r="3"/>'),
    camera: S('<rect x="8" y="12" width="20" height="14" rx="2"/><circle cx="18" cy="19" r="4"/><path d="M14 12l2-3h4l2 3"/>'),
    spotlight: S('<path d="M12 14l12-6 4 8-12 6z"/><path d="M10 30l8-10M26 22l4 8"/>'),
    'bowl_light': S('<path d="M9 18a9 6 0 0018 0z"/><path d="M18 24v6M13 30h10"/>'),
    'gooseneck_light': S('<path d="M12 30h12"/><path d="M18 30c0-8 0-14-2-17 3-2 7-1 8 2"/><circle cx="24" cy="17" r="3"/>'),
    'table_lamp': S('<path d="M12 15l6-8 6 8z"/><path d="M18 15v13M13 30h10"/>'),
    'ceiling_fan_light': S('<path d="M18 6v6"/><circle cx="18" cy="15" r="3"/><path d="M4 15h10M22 15h10"/><path d="M14 21l-6 8M22 21l6 8"/>'),
    'street_light_classic': S('<path d="M18 30V10"/><path d="M18 10c-6 0-8 3-8 5h16c0-2-2-5-8-5z"/>'),
    'work_light': S('<rect x="10" y="10" width="16" height="9" rx="1"/><path d="M13 19l-4 11M23 19l4 11M18 19v12"/>'),
    'led_lights': S('<rect x="7" y="14" width="22" height="8" rx="2"/>'),
    'barbed_wire': S('<path d="M6 14c4 3 8-3 12 0s8 3 12 0M6 22c4 3 8-3 12 0s8 3 12 0"/><path d="M12 10l2 4M24 20l2 4M10 24l4-2"/>'),
    trapper: S('<path d="M8 26h20"/><path d="M10 26V12l8 8 8-8v14"/>'),
    'cube_inverted': S('<path d="M8 13l10-5 10 5v10l-10 5-10-5z"/><path d="M8 13l10 5 10-5M18 18v10"/>'),
    'carpentry_1': S('<rect x="9" y="11" width="18" height="15" rx="1"/><path d="M9 16h18M14 11v15"/><path d="M12 29h12"/>'),
    'super_corn': S('<path d="M18 7c4 3 5 8 5 12h-10c0-4 1-9 5-12z"/><path d="M18 19v10M13 24l5-3 5 3"/>'),
  };
  const symbolSvg = (name) => SYMBOL_SVGS[name] || SYMBOL_SVGS[String(name).split('_')[0]] || SYMBOL_SVGS.research;

  function renderResearchNode(n, p) {
    const R = p.root ? 30 : NODE_R;
    const g = el('g', { class: 'node', transform: `translate(${p.x},${p.y})` }, gNodes);
    g.dataset.nodeId = n.id;
    const isSel = state.selected.has(n.id);
    el('rect', {
      x: -R, y: -R, width: R * 2, height: R * 2, rx: 8,
      fill: '#23272e', stroke: isSel ? '#ffd166' : (p.root ? '#8a97a5' : '#4c5763'),
      'stroke-width': isSel ? 2.4 : 1.3,
    }, g);
    const img = el('image', { x: -R + 7, y: -R + 7, width: R * 2 - 14, height: R * 2 - 14, href: PLACEHOLDER_ICON }, g);
    // icon chain mirroring the game: research named after an item -> explicit symbol icon
    // (fuzzy-matched to a thematically related item icon) -> first unlock item -> the
    // game's own missingIcon texture. ui_game_symbol_* glyphs are drawn as SVG.
    const candidates = [];
    if (n.id) candidates.push({ name: n.id });
    // first explicit unlock — the server resolves it through the game's own
    // Extends/Icon inheritance, so Powered variants get their real item icon
    if (n.research?.unlocks?.[0]?.name) candidates.push({ name: n.research.unlocks[0].name });
    // symbol_* fuzzily maps to a thematically related item icon (symbol_baton -> *baton*.png)
    if (n.icon && /^symbol_/i.test(n.icon) && !/^ui_game_symbol_/i.test(n.icon)) {
      const base = n.icon.replace(/^symbol_/i, '');
      candidates.push({ name: n.icon, fuzzy: base });
      if (base.includes('_')) candidates.push({ name: n.icon, fuzzy: base.split('_').pop() });
    }
    // ui_game_symbol_* / unmatched symbol_*: the game's flat glyph, drawn as SVG
    if (n.icon && /^ui_game_symbol_/i.test(n.icon)) {
      candidates.push({ svg: symbolSvg(n.icon.replace(/^ui_game_symbol_/i, '')) });
    }
    if (n.icon && /^symbol_/i.test(n.icon) && !/^ui_game_symbol_/i.test(n.icon)) {
      const base = n.icon.replace(/^symbol_/i, '');
      candidates.push({ svg: symbolSvg(base) });
    }
    if (!n.icon && n.id) {
      const m = /[A-Za-z]+/.exec(n.id.split(/(?=[A-Z])/).pop());
      if (m && m[0].length >= 4) candidates.push({ name: n.id, fuzzy: m[0].toLowerCase() });
    }
    let ci = 0;
    const tryNext = () => {
      if (ci >= candidates.length) { img.setAttribute('href', PLACEHOLDER_ICON); return; }
      const c = candidates[ci++];
      if (c.svg) { img.setAttribute('href', c.svg); return; }
      let url = '/api/icon?name=' + encodeURIComponent(c.name);
      if (c.fuzzy) url += '&fuzzy=' + encodeURIComponent(c.fuzzy);
      img.setAttribute('href', url);
    };
    img.addEventListener('error', tryNext);
    tryNext();
    // localized name under the box (Simplified Chinese preferred)
    const label = (n.display || n.id);
    el('text', { x: 0, y: R + 13, 'text-anchor': 'middle', fill: isSel ? '#ffd166' : '#aeb6c2', 'font-size': 10.5 }, g)
      .textContent = label.length > 13 ? label.slice(0, 12) + '…' : label;
    const title = el('title', {}, g);
    title.textContent = `${n.display || n.id}  [${n.id}]`;
    if (state.problemNodes.has(n.id)) {
      const sev = state.problemNodes.get(n.id);
      el('circle', { cx: R - 6, cy: -R + 6, r: 4.5, fill: sev === 'error' ? '#e5484d' : sev === 'warning' ? '#f5a623' : '#7c8691' }, g);
    }
    g.addEventListener('mousedown', (ev) => startNodeDrag(n, ev, g));
    g.addEventListener('dblclick', (ev) => { ev.stopPropagation(); hooks.onInspect(n); });
  }

  // ---------------------------------------------------------- interactions
  function toWorld(clientX, clientY) {
    const r = svg.getBoundingClientRect();
    return { x: (clientX - r.left - state.panX) / state.scale, y: (clientY - r.top - state.panY) / state.scale };
  }

  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const r = svg.getBoundingClientRect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
    const ns = Math.min(2.5, Math.max(0.06, state.scale * factor));
    state.panX = mx - (mx - state.panX) * (ns / state.scale);
    state.panY = my - (my - state.panY) * (ns / state.scale);
    state.scale = ns;
    applyTransform();
  }, { passive: false });

  svg.addEventListener('mousedown', (ev) => {
    if (ev.target !== svg && !ev.target.classList.contains('viewport')) return;
    if (ev.shiftKey) {
      const start = toWorld(ev.clientX, ev.clientY);
      const rect = el('rect', { fill: 'rgba(255,209,102,0.12)', stroke: '#ffd166', 'stroke-dasharray': '5,4' }, gRubber);
      state.dragging = {
        type: 'rubber', start,
        move(ev2) {
          const cur = toWorld(ev2.clientX, ev2.clientY);
          rect.setAttribute('x', Math.min(start.x, cur.x)); rect.setAttribute('y', Math.min(start.y, cur.y));
          rect.setAttribute('width', Math.abs(cur.x - start.x)); rect.setAttribute('height', Math.abs(cur.y - start.y));
        },
        up(ev2) {
          const cur = toWorld(ev2.clientX, ev2.clientY);
          rect.remove();
          const x1 = Math.min(start.x, cur.x), x2 = Math.max(start.x, cur.x);
          const y1 = Math.min(start.y, cur.y), y2 = Math.max(start.y, cur.y);
          state.selected.clear();
          for (const n of tree.nodes) {
            if (!state.visible.has(n.id)) continue;
            const p = state.nodePos.get(n.id);
            if (p && p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2) state.selected.add(n.id);
          }
          state.selectedEdge = null;
          hooks.onSelectionChange({ nodes: [...state.selected].map(id => tree.byId.get(id)), edge: null });
          render();
        },
      };
    } else {
      state.dragging = {
        type: 'pan', sx: ev.clientX, sy: ev.clientY, px: state.panX, py: state.panY,
        move(ev2) { state.panX = this.px + (ev2.clientX - this.sx); state.panY = this.py + (ev2.clientY - this.sy); applyTransform(); },
        up() {},
      };
    }
  });

  function startNodeDrag(n, ev) {
    ev.stopPropagation();
    if (ev.button !== 0) return;
    if (!state.selected.has(n.id)) {
      if (!ev.ctrlKey) state.selected.clear();
      state.selected.add(n.id);
      state.selectedEdge = null;
      hooks.onSelectionChange({ nodes: [...state.selected].map(id => tree.byId.get(id)), edge: null });
      render();
    }
    const start = toWorld(ev.clientX, ev.clientY);
    const origins = new Map();
    for (const id of state.selected) { const p = state.nodePos.get(id); if (p) origins.set(id, { ...p }); }
    let moved = false;
    state.dragging = {
      type: 'node',
      move(ev2) {
        const cur = toWorld(ev2.clientX, ev2.clientY);
        const dx = cur.x - start.x, dy = cur.y - start.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
        for (const [id, o] of origins) {
          const np = { x: o.x + dx, y: o.y + dy };
          state.nodePos.set(id, np);
          const g = gNodes.querySelector(`g[data-node-id="${CSS.escape(id)}"]`);
          if (g) g.setAttribute('transform', `translate(${np.x},${np.y})`);
        }
      },
      up() {
        if (!moved) return;
        hooks.onDirty();
        for (const id of state.selected) {
          const node = tree.byId.get(id);
          const p = state.nodePos.get(id);
          if (!node || !p) continue;
          if (node.kind === 'research') node.pos = { x: p.x, y: p.y }; // IDE-only view state
        }
        render();
      },
    };
  }

  window.addEventListener('mousemove', (ev) => { if (state.dragging?.move) state.dragging.move(ev); });
  window.addEventListener('mouseup', (ev) => { if (state.dragging) { state.dragging.up(ev); state.dragging = null; } });

  // ---------------------------------------------------------- public api
  return {
    state,
    render,
    setSearch(q) { state.search = q; },
    setHiddenEdges(set) { state.hiddenEdges = set; },
    setProblemNodes(map) { state.problemNodes = map; },
    selectNode(id, { focus = true } = {}) {
      state.selected.clear(); state.selected.add(id); state.selectedEdge = null;
      const n = tree.byId.get(id);
      hooks.onSelectionChange({ nodes: n ? [n] : [], edge: null });
      if (focus) this.centerOn(id);
      render();
    },
    centerOn(id) {
      this.render();
      const p = state.nodePos.get(id);
      if (!p) return;
      const r = svg.getBoundingClientRect();
      state.panX = r.width / 2 - p.x * state.scale;
      state.panY = r.height / 2 - p.y * state.scale;
      applyTransform();
    },
    fitView({ minScale = 0 } = {}) {
      this.render();
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const id of state.visible) {
        const p = state.nodePos.get(id);
        if (!p) continue;
        x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y); x2 = Math.max(x2, p.x); y2 = Math.max(y2, p.y);
      }
      if (x1 === Infinity) return;
      const r = svg.getBoundingClientRect();
      const pad = 60;
      const sx = (r.width - pad * 2) / Math.max(1, x2 - x1), sy = (r.height - pad * 2) / Math.max(1, y2 - y1);
      let s = Math.min(1.6, Math.max(0.06, Math.min(sx, sy)));
      if (!Number.isFinite(s)) return;
      if (minScale && s < minScale) {
        s = minScale;
        state.scale = s;
        state.panX = pad - x1 * s;
        state.panY = pad - y1 * s;
        applyTransform();
        return;
      }
      state.scale = s;
      state.panX = r.width / 2 - (x1 + x2) / 2 * state.scale;
      state.panY = r.height / 2 - (y1 + y2) / 2 * state.scale;
      applyTransform();
    },
  };
}
