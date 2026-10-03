// Node Inspector — right panel (research tree). Edits go through commands;
// Unknown/Preserved data is shown, never hidden. Names resolve to Chinese/English.
import { cmdSetAttr, cmdRename, cmdDeleteNode, cmdDuplicateNode, cmdSetDomAttr,
  cmdAddResearchChild, cmdRemoveResearchChild } from './model.js';
import { resolveKey } from './parser.js';

export function createInspector(container, ctx) {
  // ctx: {tree, cmd(cmdFactory), onDirty, locate(id), showXml(node), problemsByNode}
  let current = null;

  function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function header() {
    const c = container.querySelector('.insp-content');
    c.textContent = '';
    return c;
  }
  function section(parent, title, extra = '') {
    const s = h(`<div class="insp-section"><div class="insp-title">${esc(title)}${extra}</div></div>`);
    parent.appendChild(s);
    return s;
  }
  function fieldRow(parent, label, inputHtml) {
    const r = h(`<div class="insp-row"><label>${esc(label)}</label><div class="insp-field">${inputHtml}</div></div>`);
    parent.appendChild(r);
    const el = r.querySelector('input, select, textarea');
    if (el) {
      // commit pipeline: typing (input) → debounced change; change handlers dedupe repeats.
      const orig = el.addEventListener.bind(el);
      el.addEventListener = (type, fn, opts) => {
        if (type === 'change') {
          let last = el.value;
          orig(type, () => { if (el.value !== last) { last = el.value; fn(); } });
        } else orig(type, fn, opts);
      };
      el.addEventListener('input', () => {
        clearTimeout(el._commitTimer);
        el._commitTimer = setTimeout(() => el.dispatchEvent(new Event('change')), 450);
      });
      el.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { clearTimeout(el._commitTimer); el.dispatchEvent(new Event('change')); }
      });
    }
    return el;
  }

  function attachDatalist(c, id, values) {
    let dl = c.querySelector('#' + id);
    if (!dl) { dl = h(`<datalist id="${id}"></datalist>`); c.appendChild(dl); }
    dl.textContent = '';
    for (const v of values.slice(0, 3000)) {
      const o = document.createElement('option'); o.value = v; dl.appendChild(o);
    }
  }

  // Chinese-aware suggestion dropdown for key inputs: type 中文 or part of the key,
  // get matching research keys back. Replaces the native datalist on .pre-target inputs.
  function attachZhSuggest(input, tree) {
    let box = null;
    const close = () => { box?.remove(); box = null; };
    const commit = (node) => {
      input.value = node.id;
      close();
      input.dispatchEvent(new Event('change'));
      input.focus();
    };
    const renderBox = (q) => {
      close();
      const ql = q.trim().toLowerCase();
      if (!ql) return;
      const matches = tree.nodes
        .filter(n => (n.display || '').toLowerCase().includes(ql) || n.id.toLowerCase().includes(ql) || (n.displayEn || '').toLowerCase().includes(ql))
        .slice(0, 8);
      if (!matches.length) return;
      const rect = input.getBoundingClientRect();
      box = h(`<div class="zh-suggest"></div>`);
      box.style.left = rect.left + 'px';
      box.style.top = rect.bottom + 2 + 'px';
      box.style.width = Math.max(rect.width, 260) + 'px';
      for (const n of matches) {
        const row = h(`<div class="zh-suggest-row"><span>${esc(n.display || n.id)}</span><span class="dim">${esc(n.id)}</span></div>`);
        row.addEventListener('mousedown', (ev) => { ev.preventDefault(); commit(n); });
        box.appendChild(row);
      }
      const first = box.firstChild;
      first.classList.add('active');
      const onKey = (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(matches[0]); cleanup(); }
        else if (ev.key === 'Escape') { close(); cleanup(); }
      };
      const cleanup = () => { input.removeEventListener('keydown', onKey, true); input.removeEventListener('blur', onBlur); };
      const onBlur = () => setTimeout(close, 120);
      input.addEventListener('keydown', onKey, true);
      input.addEventListener('blur', onBlur);
      document.body.appendChild(box);
    };
    input.addEventListener('input', () => renderBox(input.value));
    input.addEventListener('blur', () => setTimeout(close, 120));
  }

  function render() {
    const c = header();
    if (!current) {
      c.appendChild(h(`<div class="insp-empty">点击图中节点查看与编辑属性。<br><br>双击节点可快速聚焦。<br>节点下方显示的是本地化中文名称。</div>`));
      return;
    }
    const n = current, tree = ctx.tree;

    // ---- identity
    const s1 = section(c, '标识 · 研究节点');
    let input = fieldRow(s1, 'ID', `<input type="text" value="${esc(n.id)}">`);
    input.addEventListener('change', () => {
      const v = input.value.trim();
      if (!v || v === n.id) { render(); return; }
      if (tree.byId.has(v)) { ctx.onError(`ID "${v}" 已存在`); render(); return; }
      ctx.cmd(() => cmdRename(tree, n, v));
      ctx.onDirty();
    });
    const zhName = resolveKey(tree, n.id);
    const enName = n.displayEn;
    s1.appendChild(h(`<div class="insp-hint ${zhName == null ? 'dim' : ''}">本地化: ${esc(zhName || enName || '(未找到，显示 ID)')}${enName && zhName && zhName !== enName ? ' <span class="dim">(' + esc(enName) + ')</span>' : ''}</div>`));

    input = fieldRow(s1, '描述 desc', `<input type="text" value="${esc(n.descKey || '')}">`);
    input.addEventListener('change', () => { ctx.cmd(() => cmdSetAttr(tree, n, 'desc', input.value || undefined)); ctx.onDirty(); });
    const descResolved = n.descKey ? resolveKey(tree, n.descKey) : null;
    if (n.descKey) {
      s1.appendChild(h(`<div class="insp-hint ${descResolved == null ? 'warn' : ''}">${descResolved == null ? '⚠ 未找到' : esc(descResolved)}</div>`));
    }
    input = fieldRow(s1, '图标 icon（符号）', `<input type="text" value="${esc(n.icon || '')}">`);
    input.addEventListener('change', () => { ctx.cmd(() => cmdSetAttr(tree, n, 'icon', input.value || undefined)); ctx.onDirty(); });

    // ---- research settings
    const sr = section(c, '研究设置');
    const bindField = (parent, label, html, apply) => {
      const fi = fieldRow(parent, label, html);
      fi.addEventListener('change', () => apply(fi.value));
      return fi;
    };
    bindField(sr, '前置研究 parent', `<select><option value="">（根节点）</option>${tree.nodes.filter(x => x.kind === 'research' && x.id !== n.id).map(x => `<option value="${esc(x.id)}" ${x.id === n.parentId ? 'selected' : ''}>${esc(x.display || x.id)}</option>`).join('')}</select>`,
      (v) => { ctx.cmd(() => cmdSetAttr(tree, n, 'parent', v || undefined)); ctx.onDirty(); });

    bindField(sr, '坐标 pos（布局提示）', `<input type="text" value="${esc(n.research?.pos || '')}" placeholder="x,y">`,
      (v) => { ctx.cmd(() => cmdSetAttr(tree, n, 'pos', v || undefined)); ctx.onDirty(); });

    attachDatalist(c, 'dl-areas', [...new Set(tree.nodes.filter(x => x.kind === 'research').map(x => x.research?.area).filter(Boolean))]);
    bindField(sr, '区域 area', `<input type="text" value="${esc(n.research?.area || '')}" list="dl-areas">`,
      (v) => { ctx.cmd(() => cmdSetAttr(tree, n, 'area', v || undefined)); ctx.onDirty(); });

    attachDatalist(c, 'dl-rcats', [...new Set(tree.nodes.filter(x => x.kind === 'research').map(x => x.category).filter(x => x && x !== 'research'))]);
    bindField(sr, '分类 category', `<input type="text" value="${esc(n.category === 'research' ? '' : n.category || '')}" list="dl-rcats">`,
      (v) => { ctx.cmd(() => cmdSetAttr(tree, n, 'category', v || undefined)); ctx.onDirty(); });

    bindField(sr, '初始解锁 unlocked', `<select><option value="">否</option><option value="true" ${n.research?.unlocked ? 'selected' : ''}>true</option></select>`,
      (v) => { ctx.cmd(() => cmdSetAttr(tree, n, 'unlocked', v || undefined)); ctx.onDirty(); });

    attachDatalist(c, 'dl-rnodes', tree.nodes.filter(x => x.kind === 'research').map(x => x.id));
    bindField(sr, '额外前置 requires', `<input type="text" value="${esc((n.research?.requiresList || []).join(','))}" list="dl-rnodes">`,
      (v) => { ctx.cmd(() => cmdSetAttr(tree, n, 'requires', v || undefined)); ctx.onDirty(); });

    // ---- unlocks — the items this research makes craftable
    const r = n.research;
    const implicitKind = { item: '物品', block: '方块', recipe: '配方' }[r.sameName] || null;
    const su = section(c, `解锁物品 unlocks (${r.unlocks.length + (implicitKind ? 1 : 0)})`, ' <button class="mini" data-act="add-unlock">＋ 添加</button>');
    if (implicitKind) {
      // the game's implicit rule: a research unlocks the recipe/item/block of the same name
      const izh = resolveKey(tree, n.id);
      su.appendChild(h(`<div class="insp-pre-wrap">
        <div class="insp-pre" title="研究名与同名${implicitKind}——游戏自动解锁它的制作配方。改名会同步改变隐式解锁目标。">
          <span class="badge pe">同名${implicitKind}</span>
          <input class="pre-target" type="text" value="${esc(n.id)}" disabled>
        </div>
        ${izh ? `<div class="insp-zh">${esc(izh)}</div>` : ''}
      </div>`));
    }
    if (!r.unlocks.length && !implicitKind) su.appendChild(h('<div class="insp-hint">无解锁（研究名不同名任何物品/方块/配方，也没有显式 unlocks）</div>'));
    for (const u of r.unlocks) {
      const uzh = resolveKey(tree, u.name);
      const row = h(`<div class="insp-pre-wrap">
        <div class="insp-pre">
          <input class="pre-target" type="text" value="${esc(u.name)}" spellcheck="false" placeholder="输入中文或键名…">
          <button class="mini danger" title="删除">✕</button>
        </div>
        ${uzh ? `<div class="insp-zh">${esc(uzh)}</div>` : ''}
      </div>`);
      su.appendChild(row);
      const inp = row.querySelector('.pre-target');
      attachZhSuggest(inp, tree);
      inp.addEventListener('change', () => { ctx.cmd(() => cmdSetDomAttr(tree, u.dom, 'name', inp.value, 'Set unlocks.name', n)); ctx.onDirty(); });
      row.querySelector('button').addEventListener('click', () => { ctx.cmd(() => cmdRemoveResearchChild(tree, n, u.dom)); ctx.onDirty(); });
    }
    attachDatalist(c, 'dl-nodes', tree.nodes.map(x => x.id));
    su.querySelector('[data-act="add-unlock"]')?.addEventListener('click', () => {
      ctx.cmd(() => cmdAddResearchChild(tree, n, 'unlocks', { name: n.id }));
      ctx.onDirty();
    });

    // ---- ingredients — research cost
    const si = section(c, `研究消耗 ingredients (${r.ingredients.length})`, ' <button class="mini" data-act="add-ing">＋ 添加</button>');
    for (const ing of r.ingredients) {
      const izh = resolveKey(tree, ing.name);
      const row = h(`<div class="insp-pre-wrap">
        <div class="insp-pre">
          <input class="pre-target" type="text" value="${esc(ing.name)}" spellcheck="false" placeholder="输入中文或键名…">
          <input class="pre-val" type="text" value="${esc(ing.count)}" size="4" title="数量">
          <button class="mini danger" title="删除">✕</button>
        </div>
        ${izh ? `<div class="insp-zh">${esc(izh)}</div>` : `<div class="insp-zh dim">（词典中无此键 — 可加入 TechTreeIDE/dictionary.csv）</div>`}
      </div>`);
      si.appendChild(row);
      const nameInp = row.querySelector('.pre-target');
      attachZhSuggest(nameInp, tree);
      const cntInp = row.querySelector('.pre-val');
      nameInp.addEventListener('change', () => { ctx.cmd(() => cmdSetDomAttr(tree, ing.dom, 'name', nameInp.value, 'Set ingredient.name', n)); ctx.onDirty(); });
      cntInp.addEventListener('change', () => { ctx.cmd(() => cmdSetDomAttr(tree, ing.dom, 'count', cntInp.value || undefined)); ctx.onDirty(); });
      row.querySelector('button').addEventListener('click', () => { ctx.cmd(() => cmdRemoveResearchChild(tree, n, ing.dom)); ctx.onDirty(); });
    }
    si.querySelector('[data-act="add-ing"]')?.addEventListener('click', () => {
      ctx.cmd(() => cmdAddResearchChild(tree, n, 'ingredient', { name: n.id, count: '1' }));
      ctx.onDirty();
    });

    // ---- unknown / preserved
    if ((n.unknownAttrs && n.unknownAttrs.length) || (n.unknownChildren && n.unknownChildren.length)) {
      const suk = section(c, `Unknown / Preserved (${(n.unknownAttrs?.length || 0) + (n.unknownChildren?.length || 0)})`);
      for (const ua of n.unknownAttrs || []) {
        const row = h(`<div class="insp-row unknown"><label>${esc(ua.name)}</label><div class="insp-field"><input type="text" value="${esc(ua.value)}"></div></div>`);
        suk.appendChild(row);
        row.querySelector('input').addEventListener('change', (ev) => { ctx.cmd(() => cmdSetDomAttr(tree, n.dom, ua.name, ev.target.value, `Set ${ua.name} (unknown)`)); ctx.onDirty(); });
      }
      for (const uc of n.unknownChildren || []) {
        suk.appendChild(h(`<pre class="insp-xml-small">&lt;${esc(uc.name)}&gt; …已保留</pre>`));
      }
    }

    // ---- source & actions
    const ss = section(c, '来源');
    ss.appendChild(h(`<div class="insp-hint">${esc(n.sourceFile)} : 行 ${n.sourceLine || '?'}</div>`));
    const btns = h(`<div class="insp-btns">
      <button class="mini" data-act="raw">原始 XML</button>
      <button class="mini" data-act="dup">复制节点</button>
      <button class="mini danger" data-act="del">删除节点</button>
    </div>`);
    ss.appendChild(btns);
    btns.querySelector('[data-act="raw"]').addEventListener('click', () => ctx.showXml(n));
    btns.querySelector('[data-act="dup"]').addEventListener('click', () => {
      let base = n.id + '_copy', i = 1;
      while (tree.byId.has(base)) base = n.id + '_copy' + (++i);
      ctx.cmd(() => cmdDuplicateNode(tree, n, base));
      ctx.onDirty();
    });
    btns.querySelector('[data-act="del"]').addEventListener('click', () => {
      const refs = countRefs(tree, n.id);
      const msg = `删除节点 "${n.id}"？\n\n该节点被 ${refs} 处属性引用（将一并失效，Validation 会报告悬空引用）。\n删除可通过 Undo 撤销。`;
      if (confirm(msg)) { ctx.cmd(() => cmdDeleteNode(tree, n)); ctx.onDirty(); }
    });
  }

  function countRefs(tree, id) {
    let count = 0;
    for (const sf of tree.sourceFiles) {
      const walkE = (el) => {
        if (el.kind === 'element') {
          for (const a of el.attrs) if (a.decoded === id) count++;
          for (const ch of el.children) walkE(ch);
        } else if (el.kind === 'doc') for (const ch of el.children) walkE(ch);
      };
      walkE(sf.dom);
    }
    return count;
  }

  return {
    show(node) { current = node; render(); container.classList.add('open'); },
    refresh() { render(); },
    get current() { return current; },
  };
}
