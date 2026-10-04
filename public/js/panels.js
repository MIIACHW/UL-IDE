// Side panels — left (categories / search / filters) and bottom (Problems / XML / Diff).
import { lineDiff, structuredDiff, summarizeStructured } from './differ.js';
import { generateFiles } from './generator.js';
import { serializeXML } from './xmldom.js';
import { t } from './i18n.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function createLeftPanel(container, ctx) {
  // ctx: {tree, graph, onFilterChange()}
  const filter = { mods: new Set(), kinds: new Set(), categories: new Set(), onlyProblems: false, edgeTypes: new Set() };
  ctx.filter = filter;
  const KIND_LABELS = { research: '研究节点', attribute: '属性大类', skill: '技能', book_group: '书组', perk: 'Perk', book: '书', progression: '进度节点' };

  function render() {
    const tree = ctx.tree;
    let curNameLang = '';
    try { curNameLang = localStorage.getItem('ul-ide-display-lang') || ''; } catch { /* default */ }
    const modsPresent = [...new Set(tree.nodes.map(n => n.sourceMod))];
    container.innerHTML = `
      <div class="lp-search"><input type="search" placeholder="${esc(t('left.searchPh'))}"></div>
      <div class="lp-block"><label class="lp-check"><input type="checkbox" id="lp-prog" ${ctx.includeProgression ? 'checked' : ''}> ${esc(t('left.includeProgression'))}</label></div>
      <div class="lp-block"><div class="lp-title">${esc(t('left.mods'))}</div>
        ${modsPresent.map(m => `<label class="lp-check"><input type="checkbox" data-mod="${esc(m)}"> ${esc(m)} <span class="cnt">${tree.nodes.filter(n => n.sourceMod === m).length}</span></label>`).join('')}
      </div>
      <div class="lp-block lp-cats"><div class="lp-title">${esc(t('left.branches'))}</div>
        ${tree.categories.filter(c => c.kind === 'research').map(c => `<label class="lp-check"><input type="checkbox" data-cat="${esc(c.id)}"> ${esc(c.label)} <span class="cnt">${tree.nodes.filter(n => n.category === c.id).length}</span></label>`).join('')}
      </div>
      <div class="lp-block"><div class="lp-title">${esc(t('left.edgeTypes'))}</div>
        ${[['parent', 'left.edgeParent'], ['requires', 'left.edgeRequires']].map(([tg, key]) => `<label class="lp-check"><input type="checkbox" data-edge="${tg}" checked> ${esc(t(key))}</label>`).join('')}
      </div>
      <div class="lp-block"><div class="lp-title">${esc(t('left.langTitle'))}</div>
        ${[...(tree.localization?.langs || new Map())].map(([name, m]) =>
          `<div class="lp-check"><span> ${esc(name)} <span class="cnt">${esc(t('left.langEntries', { n: m.size }))}</span></span> <button class="mini danger" data-lang-del="${esc(name)}" title="${esc(t('left.langDelTitle'))}">✕</button></div>`).join('')}
        <div class="lp-check"><span>${esc(t('left.nameLang'))}</span>
          <select id="lp-namelang" title="${esc(t('left.nameLangTitle'))}">
            <option value="" ${curNameLang === '' ? 'selected' : ''}>${esc(t('left.nameLangAuto'))}</option>
            <option value="en" ${curNameLang === 'en' ? 'selected' : ''}>English</option>
            ${[...(tree.localization?.langs || new Map())].map(([name]) => `<option value="${esc(name)}" ${curNameLang === name ? 'selected' : ''}>${esc(name)}</option>`).join('')}
          </select>
        </div>
        <button class="mini" id="lp-addlang" title="${esc(t('left.addLangTitle'))}">${esc(t('left.addLang'))}</button>
      </div>
      <div class="lp-block"><label class="lp-check"><input type="checkbox" data-flag="onlyProblems"> ${esc(t('left.onlyProblems'))}</label></div>
    `;
    const search = container.querySelector('input[type=search]');
    let deb;
    search.addEventListener('input', () => {
      clearTimeout(deb);
      deb = setTimeout(() => { ctx.graph.setSearch(search.value.trim()); }, 180); // setSearch full-renders once
    });
    container.querySelectorAll('[data-cat]').forEach(cb => cb.addEventListener('change', () => {
      cb.checked ? filter.categories.add(cb.dataset.cat) : filter.categories.delete(cb.dataset.cat);
      ctx.graph.render();
      // frame whatever is visible now: a single branch jumps to center, several fit side by side
      ctx.graph.fitView({ minScale: 0.45 });
    }));
    container.querySelectorAll('[data-mod]').forEach(cb => cb.addEventListener('change', () => {
      cb.checked ? filter.mods.add(cb.dataset.mod) : filter.mods.delete(cb.dataset.mod);
      ctx.graph.render();
      ctx.graph.fitView({ minScale: 0.45 });
    }));
    container.querySelectorAll('[data-edge]').forEach(cb => cb.addEventListener('change', () => {
      if (cb.checked) filter.edgeTypes.delete(cb.dataset.edge); else filter.edgeTypes.add(cb.dataset.edge);
      ctx.graph.setHiddenEdges(filter.edgeTypes); // edge-only change — no node re-render needed
    }));
    container.querySelector('#lp-prog').addEventListener('change', (ev) => {
      ctx.onIncludeProgression?.(ev.target.checked);
    });
    container.querySelector('[data-flag=onlyProblems]').addEventListener('change', (ev) => {
      filter.onlyProblems = ev.target.checked;
      ctx.graph.render();
      ctx.graph.fitView({ minScale: 0.45 });
    });
    container.querySelector('#lp-addlang')?.addEventListener('click', () => {
      const fi = document.createElement('input');
      fi.type = 'file';
      fi.accept = '.txt,text/plain';
      fi.onchange = () => ctx.addLanguageFile?.(fi.files[0]);
      fi.click();
    });
    container.querySelectorAll('[data-lang-del]').forEach(b => b.addEventListener('click', () => {
      ctx.removeLanguageFile?.(b.dataset.langDel);
    }));
    container.querySelector('#lp-namelang')?.addEventListener('change', (ev) => {
      ctx.changeDisplayLang?.(ev.target.value);
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
      <button data-act="validate" class="mini primary">${esc(t('bottom.runValidation'))}</button>
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
        row.title = t('bottom.clickLocate');
        row.addEventListener('click', () => ctx.locate(p.nodeId));
      }
      list.appendChild(row);
    }
    if (problems.length > 800) list.appendChild(document.createTextNode(t('bottom.moreCount', { n: problems.length })));
    body.appendChild(list);
  }

  function renderXml() {
    const tree = ctx.tree;
    const bar = document.createElement('div');
    bar.className = 'bp-xml-bar';
    bar.innerHTML = tree.sourceFiles.map((sf, i) => `<button class="mini ${xmlFile === i ? 'primary' : ''}" data-file="${i}">[${esc(sf.mod)}] ${esc(sf.path)}</button>`).join('');
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
    bar.innerHTML = `<button class="mini primary" data-act="gen">${esc(t('bottom.genDiff'))}</button><span class="dim">${esc(t('bottom.autoRegen'))}</span>`;
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
        ? `<span class="sev ok">${esc(t('bottom.noDiff'))}</span>`
        : `<span class="sev warn">${esc(t('bottom.diffSummary', { n: sum.files, a: sum.attrChanged, b: sum.attrAdded, c: sum.attrRemoved, d: sum.elemAdded, e: sum.elemRemoved }))}</span>`;
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

  return { switchTo, render, setActiveXmlFile: (i) => { xmlFile = i; }, get active() { return active; } };
}
