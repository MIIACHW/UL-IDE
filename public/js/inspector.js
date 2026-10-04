// Node Inspector — right panel. Two inspector flavors:
//   research nodes    — UL research unlocks (settings, unlocks, ingredients)
//   progression nodes — vanilla-format attribute/skill/book_group/perk/book
// Edits go through commands; Unknown/Preserved data is shown, never hidden.
// Names resolve to Chinese (fallback English) from all loaded dictionaries.
import { cmdSetAttr, cmdRename, cmdDeleteNode, cmdDuplicateNode, cmdSetDomAttr,
  cmdAddResearchChild, cmdRemoveResearchChild } from './model.js';
import { resolveKey } from './parser.js';

export function createInspector(container, ctx) {
  // ctx: {tree, cmd(cmdFactory), onDirty, locate(id), showXml(node)}
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
  // commit pipeline shared by all text inputs: typing (input) → debounced change;
  // Enter commits immediately; change handlers dedupe repeats (Enter then blur once).
  // Chromium does not fire a native change on Enter — without this, edits sit in the
  // input until a blur happens (or never commit visibly).
  function attachCommit(el) {
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
  function fieldRow(parent, label, inputHtml) {
    const r = h(`<div class="insp-row"><label>${esc(label)}</label><div class="insp-field">${inputHtml}</div></div>`);
    parent.appendChild(r);
    const el = r.querySelector('input, select, textarea');
    if (el) attachCommit(el);
    return el;
  }
  const bindField = (parent, label, html, apply) => {
    const fi = fieldRow(parent, label, html);
    fi.addEventListener('change', () => apply(fi.value));
    return fi;
  };

  function attachDatalist(c, id, values) {
    let dl = c.querySelector('#' + id);
    if (!dl) { dl = h(`<datalist id="${id}"></datalist>`); c.appendChild(dl); }
    dl.textContent = '';
    for (const v of values.slice(0, 3000)) {
      const o = document.createElement('option'); o.value = v; dl.appendChild(o);
    }
  }

  // Chinese-aware (plus any user-added language file) suggestion dropdown for key inputs.
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
      const rows = tree.nodes
        .filter(n => {
          const hay = `${(n.display || '').toLowerCase()} ${n.id.toLowerCase()} ${(n.displayEn || '').toLowerCase()} ${(ctx.searchLangText ? ctx.searchLangText(n) : '').toLowerCase()}`;
          return hay.includes(ql);
        })
        .slice(0, 8)
        .map(n => {
          const langHit = ctx.findLangMatch ? ctx.findLangMatch(n, ql) : null;
          return { id: n.id, main: n.display || n.id, sub: (langHit ? langHit + ' · ' : '') + n.id };
        });
      // direct key hits from custom language files — a translation of an item/block/
      // recipe key or a node id; committing such a row fills in the key itself
      const langs = tree.localization?.langs;
      if (langs && rows.length < 8) {
        outer:
        for (const [lang, map] of langs) {
          for (const [key, v] of map) {
            if (rows.some(r => r.id === key)) continue;
            if (v && v.toLowerCase().includes(ql) &&
                (tree.byId.has(key) || tree.nameIndex.items.has(key) || tree.nameIndex.blocks.has(key) || tree.nameIndex.recipes.has(key))) {
              const disp = resolveKey(tree, key) || resolveKey(tree, key, 'en') || key;
              rows.push({ id: key, main: disp, sub: `${lang}: ${v} · ${key}` });
              if (rows.length >= 8) break outer;
            }
          }
        }
      }
      if (!rows.length) return;
      const rect = input.getBoundingClientRect();
      box = h(`<div class="zh-suggest"></div>`);
      box.style.left = rect.left + 'px';
      box.style.top = rect.bottom + 2 + 'px';
      box.style.width = Math.max(rect.width, 260) + 'px';
      for (const row of rows) {
        const el = h(`<div class="zh-suggest-row"><span>${esc(row.main)}</span><span class="dim">${esc(row.sub)}</span></div>`);
        el.addEventListener('mousedown', (ev) => { ev.preventDefault(); commit(row); });
        box.appendChild(el);
      }
      const onKey = (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(matches[0]); cleanup(); }
        else if (ev.key === 'Escape') { close(); cleanup(); }
      };
      const cleanup = () => { input.removeEventListener('keydown', onKey, true); };
      input.addEventListener('keydown', onKey, true);
      input.addEventListener('blur', () => setTimeout(close, 120));
      document.body.appendChild(box);
    };
    input.addEventListener('input', () => renderBox(input.value));
    input.addEventListener('blur', () => setTimeout(close, 120));
  }

  function render() {
    const c = header();
    if (!current) {
      c.appendChild(h(`<div class="insp-empty">点击图中节点查看与编辑属性。<br><br>双击节点可快速聚焦。<br>节点下方显示的是本地化中文名称。<br>支持把任意科技树 XML 拖入窗口识别。</div>`));
      return;
    }
    const n = current, tree = ctx.tree;
    if (n.kind === 'research') renderResearch(c, n, tree);
    else renderProgression(c, n, tree);

    // ---- unknown / preserved (shared)
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

    // ---- source & actions (shared)
    const ss = section(c, '来源');
    ss.appendChild(h(`<div class="insp-hint">[${esc(n.sourceMod || '?')}] ${esc(n.sourceFile)} : 行 ${n.sourceLine || '?'}</div>`));
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

  function idSection(c, n, tree) {
    const s1 = section(c, '标识 · ' + kindLabel(n.kind));
    const input = fieldRow(s1, 'ID', `<input type="text" value="${esc(n.id)}">`);
    input.addEventListener('change', () => {
      const v = input.value.trim();
      if (!v || v === n.id) { render(); return; }
      if (tree.byId.has(v)) { ctx.onError(`ID "${v}" 已存在`); render(); return; }
      const prevId = n.id;
      ctx.cmd(() => cmdRename(tree, n, v));
      // research display names key off the node id itself — refresh after rename
      if (n.kind === 'research') {
        n.display = resolveKey(tree, v) || resolveKey(tree, v, 'en') || v;
        n.displayEn = tree.localization.en.get(v) || null;
      }
      ctx.onDirty({ type: 'content', node: n, prevId });
    });
    const zhName = resolveKey(tree, n.id);
    const enName = n.displayEn;
    if (zhName || enName) {
      s1.appendChild(h(`<div class="insp-hint">本地化: ${esc(zhName || enName)}${enName && zhName && zhName !== enName ? ' <span class="dim">(' + esc(enName) + ')</span>' : ''}</div>`));
    }
    return s1;
  }

  // ------------------------------------------------------ research flavor
  function renderResearch(c, n, tree) {
    const s1 = idSection(c, n, tree);
    let input = fieldRow(s1, '描述 desc', `<input type="text" value="${esc(n.descKey || '')}">`);
    input.addEventListener('change', () => { ctx.cmd(() => cmdSetAttr(tree, n, 'desc', input.value || undefined)); ctx.onDirty(); });
    const descResolved = n.descKey ? resolveKey(tree, n.descKey) : null;
    if (n.descKey) {
      s1.appendChild(h(`<div class="insp-hint ${descResolved == null ? 'warn' : ''}">${descResolved == null ? '⚠ 未找到' : esc(descResolved)}</div>`));
    }
    input = fieldRow(s1, '图标 icon（符号）', `<input type="text" value="${esc(n.icon || '')}">`);
    input.addEventListener('change', () => { ctx.cmd(() => cmdSetAttr(tree, n, 'icon', input.value || undefined)); ctx.onDirty({ type: 'content', node: n }); });

    const r = n.research;
    const sr = section(c, '研究设置');
    bindField(sr, '前置研究 parent', `<select><option value="">（根节点）</option>${tree.nodes.filter(x => x.kind === 'research' && x.id !== n.id).map(x => `<option value="${esc(x.id)}" ${x.id === n.parentId ? 'selected' : ''}>${esc(x.display || x.id)}</option>`).join('')}</select>`,
      (v) => { ctx.cmd(() => cmdSetAttr(tree, n, 'parent', v || undefined)); ctx.onDirty(); });
    bindField(sr, '坐标 pos（布局提示）', `<input type="text" value="${esc(r.pos || '')}" placeholder="x,y">`,
      (v) => { ctx.cmd(() => cmdSetAttr(tree, n, 'pos', v || undefined)); ctx.onDirty(); });
    attachDatalist(c, 'dl-areas', [...new Set(tree.nodes.filter(x => x.kind === 'research').map(x => x.research?.area).filter(Boolean))]);
    bindField(sr, '区域 area', `<input type="text" value="${esc(r.area || '')}" list="dl-areas">`,
      (v) => { ctx.cmd(() => cmdSetAttr(tree, n, 'area', v || undefined)); ctx.onDirty(); });
    attachDatalist(c, 'dl-rcats', [...new Set(tree.nodes.filter(x => x.kind === 'research').map(x => x.category).filter(x => x && x !== 'research'))]);
    bindField(sr, '分类 category', `<input type="text" value="${esc(n.category === 'research' ? '' : n.category || '')}" list="dl-rcats">`,
      (v) => { ctx.cmd(() => cmdSetAttr(tree, n, 'category', v || undefined)); ctx.onDirty(); });
    bindField(sr, '初始解锁 unlocked', `<select><option value="">否</option><option value="true" ${r.unlocked ? 'selected' : ''}>true</option></select>`,
      (v) => { ctx.cmd(() => cmdSetAttr(tree, n, 'unlocked', v || undefined)); ctx.onDirty(); });
    attachDatalist(c, 'dl-rnodes', tree.nodes.filter(x => x.kind === 'research').map(x => x.id));
    bindField(sr, '额外前置 requires', `<input type="text" value="${esc((r.requiresList || []).join(','))}" list="dl-rnodes">`,
      (v) => { ctx.cmd(() => cmdSetAttr(tree, n, 'requires', v || undefined)); ctx.onDirty(); });

    // unlocks — implicit (same-name) first, then explicit entries
    const implicitKind = { item: '物品', block: '方块', recipe: '配方' }[r.sameName] || null;
    const su = section(c, `解锁物品 unlocks (${r.unlocks.length + (implicitKind ? 1 : 0)})`, ' <button class="mini" data-act="add-unlock">＋ 添加</button>');
    if (implicitKind) {
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
      inp.addEventListener('change', () => {
        if (inp.value === u.name) return; // no-op guard: kills blur/duplicate change noise
        ctx.cmd(() => cmdSetDomAttr(tree, u.dom, 'name', inp.value, 'Set unlocks.name', n));
        ctx.onDirty();
      });
      row.querySelector('button').addEventListener('click', () => { ctx.cmd(() => cmdRemoveResearchChild(tree, n, u.dom)); ctx.onDirty(); });
    }
    attachDatalist(c, 'dl-nodes', tree.nodes.map(x => x.id));
    su.querySelector('[data-act="add-unlock"]')?.addEventListener('click', () => {
      ctx.cmd(() => cmdAddResearchChild(tree, n, 'unlocks', { name: n.id }));
      ctx.onDirty();
    });

    // ingredients — research cost
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
      nameInp.addEventListener('change', () => {
        if (nameInp.value === ing.name) return; // no-op guard
        ctx.cmd(() => cmdSetDomAttr(tree, ing.dom, 'name', nameInp.value, 'Set ingredient.name', n));
        ctx.onDirty();
      });
      attachCommit(cntInp);
      // node MUST be passed: cmdSetDomAttr relies on it to reparseResearch(node) —
      // without it the DOM attr updates but r.ingredients stays stale and the
      // inspector re-renders the input with the old count
      cntInp.addEventListener('change', () => { ctx.cmd(() => cmdSetDomAttr(tree, ing.dom, 'count', cntInp.value || undefined, 'Set ingredient.count', n)); ctx.onDirty(); });
      row.querySelector('button').addEventListener('click', () => { ctx.cmd(() => cmdRemoveResearchChild(tree, n, ing.dom)); ctx.onDirty(); });
    }
    si.querySelector('[data-act="add-ing"]')?.addEventListener('click', () => {
      ctx.cmd(() => cmdAddResearchChild(tree, n, 'ingredient', { name: n.id, count: '1' }));
      ctx.onDirty();
    });
  }

  // ------------------------------------------------------ progression flavor
  function renderProgression(c, n, tree) {
    const s1 = idSection(c, n, tree);
    let input = fieldRow(s1, '名称键 name_key', `<input type="text" value="${esc(n.nameKey || '')}">`);
    input.addEventListener('change', () => { ctx.cmd(() => cmdSetAttr(tree, n, 'name_key', input.value || undefined)); ctx.onDirty(); });
    const nkResolved = n.nameKey && n.nameKey !== 'null' ? resolveKey(tree, n.nameKey) : null;
    if (n.nameKey && n.nameKey !== 'null') {
      s1.appendChild(h(`<div class="insp-hint ${nkResolved == null ? 'warn' : ''}">${nkResolved == null ? '⚠ 未找到' : esc(nkResolved)}</div>`));
    }
    input = fieldRow(s1, '描述键 desc_key', `<input type="text" value="${esc(n.descKey || '')}">`);
    input.addEventListener('change', () => { ctx.cmd(() => cmdSetAttr(tree, n, 'desc_key', input.value || undefined)); ctx.onDirty(); });
    const dResolved = n.descKey && n.descKey !== 'null' ? resolveKey(tree, n.descKey) : null;
    if (n.descKey && n.descKey !== 'null') {
      s1.appendChild(h(`<div class="insp-hint ${dResolved == null ? 'warn' : ''}">${dResolved == null ? '⚠ 未找到' : esc(dResolved)}</div>`));
    }
    input = fieldRow(s1, '图标 icon', `<input type="text" value="${esc(n.icon || '')}">`);
    input.addEventListener('change', () => { ctx.cmd(() => cmdSetAttr(tree, n, 'icon', input.value || undefined)); ctx.onDirty({ type: 'content', node: n }); });

    const sp = section(c, '等级与消耗');
    bindField(sp, 'min_level', `<input type="number" step="1" value="${n.minLevel ?? ''}">`,
      (v) => { ctx.cmd(() => cmdSetAttr(tree, n, 'min_level', v === '' ? undefined : v)); ctx.onDirty(); });
    bindField(sp, 'max_level', `<input type="number" step="1" value="${n.maxLevel ?? ''}">`,
      (v) => { ctx.cmd(() => cmdSetAttr(tree, n, 'max_level', v === '' ? undefined : v)); ctx.onDirty(); });
    bindField(sp, 'base_skill_point_cost', `<input type="number" step="0.1" value="${n.baseCost ?? ''}">`,
      (v) => { ctx.cmd(() => cmdSetAttr(tree, n, 'base_skill_point_cost', v === '' ? undefined : v)); ctx.onDirty(); });
    bindField(sp, 'cost_multiplier_per_level', `<input type="number" step="0.01" value="${n.costMultiplier ?? ''}">`,
      (v) => { ctx.cmd(() => cmdSetAttr(tree, n, 'cost_multiplier_per_level', v === '' ? undefined : v)); ctx.onDirty(); });

    const sq = section(c, '层级与前置');
    const parentKinds = { attribute: [], skill: ['attribute'], book_group: ['attribute'], perk: ['skill', 'book_group'], book: ['book_group', 'skill'], progression: [] }[n.kind] || [];
    const candidates = tree.nodes.filter(x => parentKinds.includes(x.kind) && x.id !== n.id);
    bindField(sq, '父节点 parent', `<select><option value="">（根节点）</option>${candidates.map(x => `<option value="${esc(x.id)}" ${x.id === n.parentId ? 'selected' : ''}>${esc(x.display || x.id)}</option>`).join('')}</select>`,
      (v) => { ctx.cmd(() => cmdSetAttr(tree, n, 'parent', v || undefined)); ctx.onDirty(); });
    if (n.prerequisites && n.prerequisites.length) {
      sq.appendChild(h(`<div class="insp-hint">ProgressionLevel 前置引用:</div>`));
      for (const p of n.prerequisites) {
        sq.appendChild(h(`<div class="insp-hint">→ ${esc(p.target)} ${esc(p.operation)} ${esc(p.value)}</div>`));
      }
    } else {
      sq.appendChild(h(`<div class="insp-hint dim">无 ProgressionLevel 前置（效果体内的条件已保留在 XML 中）</div>`));
    }
  }

  function kindLabel(k) {
    return { attribute: '属性大类', skill: '技能', book_group: '书组', perk: 'Perk', book: '书', progression: '进度节点', research: '研究节点' }[k] || k;
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
