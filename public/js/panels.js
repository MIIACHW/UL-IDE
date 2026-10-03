// Side panels — left (categories / search / filters) and bottom (Problems / XML / Diff).
import { lineDiff, structuredDiff, summarizeStructured } from './differ.js';
import { generateFiles } from './generator.js';
import { serializeXML } from './xmldom.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function createLeftPanel(container, ctx) {
  // ctx: {tree, graph, onFilterChange()}
  const filter = { kinds: new Set(), categories: new Set(), onlyProblems: false, edgeTypes: new Set() };
  ctx.filter = filter;

  function render() {
    const tree = ctx.tree;
    container.innerHTML = `
      <div class="lp-search"><input type="search" placeholder="搜索 ID / 中文名 / 描述…"></div>
      <div class="lp-block lp-cats"><div class="lp-title">研究分支（对应游戏左侧大类）</div>
        ${tree.categories.filter(c => c.kind === 'research').map(c => `<label class="lp-check"><input type="checkbox" data-cat="${esc(c.id)}"> ${esc(c.label)} <span class="cnt">${tree.nodes.filter(n => n.category === c.id).length}</span></label>`).join('')}
      </div>
      <div class="lp-block"><div class="lp-title">边类型</div>
        ${[['parent', '层级 parent'], ['requires', '额外前置 requires']].map(([t, label]) => `<label class="lp-check"><input type="checkbox" data-edge="${t}" checked> ${label}</label>`).join('')}
      </div>
      <div class="lp-block"><label class="lp-check"><input type="checkbox" data-flag="onlyProblems"> 只显示有问题的节点</label></div>
    `;
    const search = container.querySelector('input[type=search]');
    let deb;
    search.addEventListener('input', () => {
      clearTimeout(deb);
      deb = setTimeout(() => { ctx.graph.setSearch(search.value.trim()); ctx.graph.render(); }, 180);
    });
    container.querySelectorAll('[data-cat]').forEach(cb => cb.addEventListener('change', () => {
      cb.checked ? filter.categories.add(cb.dataset.cat) : filter.categories.delete(cb.dataset.cat);
      ctx.graph.render();
      // frame whatever is visible now: a single branch jumps to center, several fit side by side
      ctx.graph.fitView({ minScale: 0.45 });
    }));
    container.querySelectorAll('[data-edge]').forEach(cb => cb.addEventListener('change', () => {
      if (cb.checked) filter.edgeTypes.delete(cb.dataset.edge); else filter.edgeTypes.add(cb.dataset.edge);
      ctx.graph.setHiddenEdges(filter.edgeTypes);
      ctx.graph.render();
    }));
    container.querySelector('[data-flag=onlyProblems]').addEventListener('change', (ev) => {
      filter.onlyProblems = ev.target.checked;
      ctx.graph.render();
      ctx.graph.fitView({ minScale: 0.45 });
    });
  }
  return { render };
}

export function createBottomPanel(container, ctx) {
  // ctx: {tree, validateNow(), locate(id), problems, summary}
  const tabs = container.querySelector('.bp-tabs');
  const body = container.querySelector('.bp-body');
  let active = 'problems';
  let xmlFile = null;

  function switchTo(tab) {
    active = tab;
    for (const b of tabs.querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === tab);
    render();
  }
  tabs.addEventListener('click', (ev) => { if (ev.target.dataset.tab) switchTo(ev.target.dataset.tab); });

  function render() {
    body.textContent = '';
    if (active === 'problems') renderProblems();
    else if (active === 'xml') renderXml();
    else if (active === 'diff') renderDiff();
  }

  function renderProblems() {
    const { problems, summary } = ctx.problems || { problems: [], summary: { errors: 0, warnings: 0, infos: 0, total: 0 } };
    const head = document.createElement('div');
    head.className = 'bp-problems-head';
    head.innerHTML = `
      <button data-act="validate" class="mini primary">▶ 运行完整 Validation</button>
      <span class="sev err">✖ ${summary.errors} errors</span>
      <span class="sev warn">⚠ ${summary.warnings} warnings</span>
      <span class="sev info">ℹ ${summary.infos} infos</span>`;
    head.querySelector('[data-act=validate]').addEventListener('click', () => ctx.validateNow());
    body.appendChild(head);
    const list = document.createElement('div');
    list.className = 'bp-problem-list';
    const icon = { error: '✖', warning: '⚠', info: 'ℹ' };
    for (const p of problems.slice(0, 800)) {
      const row = document.createElement('div');
      row.className = 'bp-problem ' + p.severity;
      row.innerHTML = `<span class="sev ${p.severity}">${icon[p.severity]}</span>
        <span class="code">${esc(p.code)}</span>
        <span class="msg">${esc(p.message)}</span>
        <span class="loc dim">${esc(p.sourceFile || '')}${p.line ? ':' + p.line : ''}</span>`;
      if (p.nodeId) {
        row.classList.add('clickable');
        row.title = '点击在图中定位';
        row.addEventListener('click', () => ctx.locate(p.nodeId));
      }
      list.appendChild(row);
    }
    if (problems.length > 800) list.appendChild(document.createTextNode(`… 共 ${problems.length} 条`));
    body.appendChild(list);
  }

  function renderXml() {
    const tree = ctx.tree;
    const bar = document.createElement('div');
    bar.className = 'bp-xml-bar';
    bar.innerHTML = tree.sourceFiles.map((sf, i) => `<button class="mini ${xmlFile === i ? 'primary' : ''}" data-file="${i}">${esc(sf.path)}</button>`).join('');
    body.appendChild(bar);
    if (xmlFile == null || !tree.sourceFiles[xmlFile]) xmlFile = 0;
    const sf = tree.sourceFiles[xmlFile];
    bar.querySelectorAll('[data-file]').forEach(b => b.addEventListener('click', () => { xmlFile = +b.dataset.file; render(); }));
    const pre = document.createElement('pre');
    pre.className = 'bp-xml';
    const text = sf.text;
    const lines = text.split('\n');
    pre.innerHTML = lines.map((l, i) => `<span class="xl" data-line="${i + 1}"><span class="ln">${i + 1}</span>${esc(l) || ' '}</span>`).join('\n');
    body.appendChild(pre);
    ctx.scrollToLine = (line) => {
      switchTo('xml');
      const target = pre.querySelector(`.xl[data-line="${line}"]`);
      if (target) {
        target.scrollIntoView({ block: 'center' });
        target.classList.add('flash');
        setTimeout(() => target.classList.remove('flash'), 1600);
      }
    };
  }

  function renderDiff() {
    const tree = ctx.tree;
    const bar = document.createElement('div');
    bar.className = 'bp-diff-bar';
    bar.innerHTML = `<button class="mini primary" data-act="gen">⟳ 生成 Diff（当前模型 vs 原始文件）</button><span class="dim">导出前会自动重新生成</span>`;
    body.appendChild(bar);
    const out = document.createElement('div');
    body.appendChild(out);
    bar.querySelector('[data-act=gen]').addEventListener('click', () => fill(out));
    fill(out);

    function fill(out) {
      out.textContent = '';
      const files = generateFiles(tree);
      const struct = structuredDiff(tree);
      const sum = summarizeStructured(struct);
      const sm = document.createElement('div');
      sm.className = 'bp-diff-summary';
      sm.innerHTML = sum.files === 0
        ? `<span class="sev ok">✓ 无差异 — 模型与原始文件一致</span>`
        : `<span class="sev warn">${sum.files} 个文件有变更:</span>
           属性修改 ${sum.attrChanged} · 属性新增 ${sum.attrAdded} · 属性删除 ${sum.attrRemoved} · 元素新增 ${sum.elemAdded} · 元素删除 ${sum.elemRemoved}`;
      out.appendChild(sm);
      for (const sf of tree.sourceFiles) {
        const d = lineDiff(sf.text, files[sf.path]);
        if (!d.changed) continue;
        const block = document.createElement('div');
        block.className = 'bp-diff-file';
        block.innerHTML = `<div class="bp-diff-file-name">${esc(sf.path)}</div>`;
        const pre = document.createElement('pre');
        const rows = d.rows.filter((r, i) => {
          // context window around changes
          return true;
        }).slice(0, 4000);
        pre.innerHTML = rows.map(r => {
          const ln = (r.oldLine || '') + ' ' + (r.newLine || '');
          return `<span class="dl ${r.type}"><span class="ln">${ln}</span>${esc(r.text)}</span>`;
        }).join('\n');
        block.appendChild(pre);
        out.appendChild(block);
      }
    }
  }

  return { switchTo, render, get active() { return active; } };
}
