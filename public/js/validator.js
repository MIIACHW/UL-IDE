// Validation — runs on the unified (research) model. Results are clickable problem objects.
// error   → blocks export
// warning → allowed, should be reviewed
// info    → notes, including Unknown/Preserved markers

export const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

let PROBLEM_SEQ = 0;
function P(severity, code, message, extra = {}) {
  return { id: 'prb' + (++PROBLEM_SEQ), severity, code, message, ...extra };
}

export function validate(tree) {
  PROBLEM_SEQ = 0;
  const problems = [];
  const add = (p) => problems.push(p);

  // ---- 1. Duplicate ID ------------------------------------------------------
  for (const dup of tree.meta.duplicateIds || []) {
    add(P('error', 'DuplicateID',
      `ID 重复: "${dup.id}" — ${dup.sources.map(s => `${s.file}:${s.line}`).join(' vs ')}`,
      { nodeId: dup.id, sourceFile: dup.sources[0].file, line: dup.sources[0].line }));
  }

  // ---- 2 & 3. Missing Dependency / Circular Dependency ----------------------
  const deps = new Map(); // id -> [{to, via, node}]
  const pushDep = (id, to, via, node) => {
    if (!deps.has(id)) deps.set(id, []);
    deps.get(id).push({ to, via, node });
  };
  for (const n of tree.nodes) {
    if (n.parentId) pushDep(n.id, n.parentId, 'parent', n);
    if (n.kind === 'research' && n.research) {
      for (const r of n.research.requiresList) pushDep(n.id, r, 'requires', n);
    }
  }
  // cycle detection (iterative DFS, white/grey/black)
  const color = new Map();
  const stack = [];
  const cycles = [];
  const MAX_CYCLES = 20;
  const dfs = (startId) => {
    const call = [[startId, deps.get(startId) || [], 0]];
    color.set(startId, 1); stack.push(startId);
    while (call.length) {
      const frame = call[call.length - 1];
      const [id, list, idx] = frame;
      if (idx >= list.length) { color.set(id, 2); stack.pop(); call.pop(); continue; }
      frame[2]++;
      const edge = list[idx];
      const c = color.get(edge.to) || 0;
      if (c === 1) {
        const at = stack.indexOf(edge.to);
        if (at >= 0 && cycles.length < MAX_CYCLES) {
          cycles.push(stack.slice(at).concat(edge.to));
        }
      } else if (c === 0) {
        color.set(edge.to, 1); stack.push(edge.to);
        call.push([edge.to, deps.get(edge.to) || [], 0]);
      }
    }
  };
  for (const id of deps.keys()) if (!color.get(id)) dfs(id);
  const seenCycle = new Set();
  for (const cyc of cycles) {
    const key = [...cyc].sort().join('>');
    if (seenCycle.has(key)) continue;
    seenCycle.add(key);
    add(P('error', 'CircularDependency', `循环依赖: ${cyc.join(' → ')}`, {
      nodeId: cyc[0], cycle: cyc, sourceFile: tree.byId.get(cyc[0])?.sourceFile,
    }));
  }

  // missing references of every kind
  for (const n of tree.nodes) {
    if (n.parentId && !tree.byId.has(n.parentId)) {
      add(P('error', 'MissingDependency', `缺失依赖: "${n.id}" parent → "${n.parentId}" 不存在`,
        { nodeId: n.id, missingTarget: n.parentId, sourceFile: n.sourceFile, line: n.sourceLine }));
    }
    if (n.kind === 'research' && n.research) {
      for (const r of n.research.requiresList) {
        if (!tree.byId.has(r)) {
          add(P('error', 'MissingDependency', `缺失依赖: 研究节点 "${n.id}" requires → "${r}" 不存在`,
            { nodeId: n.id, missingTarget: r, sourceFile: n.sourceFile, line: n.sourceLine }));
        }
      }
      for (const u of n.research.unlocks) {
        if (!u.name) add(P('warning', 'InvalidResearch', `研究节点 "${n.id}" 存在空 unlocks 条目`, { nodeId: n.id, sourceFile: n.sourceFile, line: u.dom?.line }));
      }
      for (const ing of n.research.ingredients) {
        if (!ing.name) add(P('warning', 'InvalidResearch', `研究节点 "${n.id}" 存在空 ingredient 条目`, { nodeId: n.id, sourceFile: n.sourceFile, line: ing.dom?.line }));
        else if (ing.count && !/^\d+$/.test(String(ing.count))) add(P('warning', 'InvalidResearch', `研究节点 "${n.id}" ingredient "${ing.name}" 数量非法 "${ing.count}"`, { nodeId: n.id, sourceFile: n.sourceFile, line: ing.dom?.line }));
      }
      if (!n.parentId && !n.research.unlocked && n.research.requiresList.length === 0 && n.research.posX == null) {
        add(P('warning', 'InvalidResearch', `研究节点 "${n.id}" 是孤立节点（无父级、无 requires、无坐标）`, { nodeId: n.id, sourceFile: n.sourceFile, line: n.sourceLine }));
      }
    }
  }

  // ---- 4. Invalid XML -------------------------------------------------------
  for (const pe of tree.meta.parseErrors || []) {
    add(P('error', 'InvalidXML', `${pe.file}:${pe.line} — ${pe.message}`, { sourceFile: pe.file, line: pe.line }));
  }

  // ---- 5. Missing Localization (research desc keys) -------------------------
  for (const n of tree.nodes) {
    if (n.descKey && n.descKey !== 'null') {
      const found = tree.localization.en.has(n.descKey) || tree.localization.zh.has(n.descKey);
      if (!found) {
        add(P('warning', 'MissingLocalization', `${n.id}: desc="${n.descKey}" 在 Mod 与本体本地化中均未找到`, { nodeId: n.id, sourceFile: n.sourceFile, line: n.sourceLine }));
      }
    }
  }

  // ---- 6. Unknown Structure (Unknown / Preserved markers) -------------------
  for (const n of tree.nodes) {
    for (const ua of n.unknownAttrs) {
      add(P('info', 'UnknownStructure', `${n.id}: 非常规属性 ${ua.name}="${ua.value}"（Unknown / Preserved）`, { nodeId: n.id, sourceFile: n.sourceFile, line: n.sourceLine }));
    }
    for (const uc of n.unknownChildren) {
      add(P('info', 'UnknownStructure', `${n.id}: 非常规子元素 <${uc.name}>（Unknown / Preserved）`, { nodeId: n.id, sourceFile: n.sourceFile, line: n.sourceLine }));
    }
  }
  for (const ut of tree.meta.unknownTopLevel || []) {
    add(P('warning', 'UnknownStructure', `${ut.file}:${ut.line} — 未识别的顶层元素 <${ut.name}>（已保留）`, { sourceFile: ut.file, line: ut.line }));
  }

  // ---- summary --------------------------------------------------------------
  problems.sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || (a.line || 0) - (b.line || 0));
  const summary = {
    errors: problems.filter(p => p.severity === 'error').length,
    warnings: problems.filter(p => p.severity === 'warning').length,
    infos: problems.filter(p => p.severity === 'info').length,
    total: problems.length,
  };
  return { problems, summary };
}
