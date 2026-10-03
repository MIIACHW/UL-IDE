// Diff — line-level diff (LCS with common prefix/suffix trimming) plus a
// structured element/attribute diff between the pristine parse and the edited DOM.

function splitLines(text) {
  return text.split(/(\n)/); // keep newline tokens attached
}

export function lineDiff(oldText, newText) {
  if (oldText === newText) return { changed: false, rows: [] };
  const A = oldText.split('\n');
  const B = newText.split('\n');
  // trim common prefix / suffix so LCS stays small for localized edits
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let sA = A.length - 1, sB = B.length - 1;
  while (sA > p && sB > p && A[sA] === B[sB]) { sA--; sB--; }
  const midA = A.slice(p, sA + 1);
  const midB = B.slice(p, sB + 1);
  const rows = [];
  for (let i = 0; i < p; i++) rows.push({ type: 'same', text: A[i], oldLine: i + 1, newLine: i + 1 });
  // LCS table
  const n = midA.length, m = midB.length;
  const dp = new Int32Array((n + 1) * (m + 1));
  const at = (i, j) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] = midA[i] === midB[j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    }
  }
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) { rows.push({ type: 'same', text: midA[i], oldLine: p + i + 1, newLine: p + j + 1 }); i++; j++; }
    else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) { rows.push({ type: 'del', text: midA[i], oldLine: p + i + 1 }); i++; }
    else { rows.push({ type: 'add', text: midB[j], newLine: p + j + 1 }); j++; }
  }
  while (i < n) { rows.push({ type: 'del', text: midA[i], oldLine: p + i + 1 }); i++; }
  while (j < m) { rows.push({ type: 'add', text: midB[j], newLine: p + j + 1 }); j++; }
  for (let k = sA + 1; k < A.length; k++) rows.push({ type: 'same', text: A[k], oldLine: k + 1, newLine: sB + 1 + (k - sA) });
  return { changed: true, rows };
}

// structured diff: match elements by identity attribute (name/id) so inserted
// siblings don't shift-match everything after them
import { parseXML, childElements } from './xmldom.js';

function keyOf(el, depth) {
  const name = el.attrs.find(a => a.name === 'name') || el.attrs.find(a => a.name === 'id');
  if (name && name.decoded !== null) return name.decoded;
  const siblings = el.parent ? childElements(el.parent).filter(c => c.name === el.name) : [];
  return `<${el.name}>#${siblings.indexOf(el) + 1}`;
}
function walkPair(a, b, path, out) {
  const aAttrs = new Map(a.attrs.filter(x => x.decoded !== null).map(x => [x.name, x.decoded]));
  const bAttrs = new Map(b.attrs.filter(x => x.decoded !== null).map(x => [x.name, x.decoded]));
  for (const [k, v] of aAttrs) if (!bAttrs.has(k)) out.push({ kind: 'attr-removed', path, elem: a.name, name: k, old: v });
  for (const [k, v] of bAttrs) {
    if (!aAttrs.has(k)) out.push({ kind: 'attr-added', path, elem: a.name, name: k, new: v });
    else if (aAttrs.get(k) !== v) out.push({ kind: 'attr-changed', path, elem: a.name, name: k, old: aAttrs.get(k), new: v });
  }
  const aKids = childElements(a), bKids = childElements(b);
  const bKeys = new Map();
  for (const k of bKids) { const kk = keyOf(k); if (!bKeys.has(kk)) bKeys.set(kk, []); bKeys.get(kk).push(k); }
  const matchedB = new Set();
  for (const ka of aKids) {
    const kk = keyOf(ka);
    const cand = (bKeys.get(kk) || []).find(x => !matchedB.has(x));
    if (cand) {
      matchedB.add(cand);
      walkPair(ka, cand, path + '/' + (a.name === 'perk' || a.name === 'book' || a.name === 'skill' || a.name === 'progression' ? kk : a.name), out);
    } else {
      out.push({ kind: 'elem-removed', path, elem: a.name, name: kk });
    }
  }
  for (const kb of bKids) if (!matchedB.has(kb)) out.push({ kind: 'elem-added', path, elem: b.name, name: keyOf(kb) });
}

export function structuredDiff(tree) {
  const out = [];
  for (const sf of tree.sourceFiles) {
    let orig;
    try { orig = parseXML(sf.text, { sourceName: sf.path + ' (original)' }); } catch { continue; }
    const origRoot = orig.children.find(c => c.kind === 'element');
    const curRoot = sf.dom.children.find(c => c.kind === 'element');
    if (!origRoot || !curRoot) continue;
    const fileOut = [];
    walkPair(origRoot, curRoot, '/' + origRoot.name, fileOut);
    if (fileOut.length) out.push({ file: sf.path, changes: fileOut });
  }
  return out;
}

export function summarizeStructured(struct) {
  const s = { files: 0, attrChanged: 0, attrAdded: 0, attrRemoved: 0, elemAdded: 0, elemRemoved: 0 };
  for (const f of struct) {
    s.files++;
    for (const c of f.changes) {
      if (c.kind === 'attr-changed') s.attrChanged++;
      else if (c.kind === 'attr-added') s.attrAdded++;
      else if (c.kind === 'attr-removed') s.attrRemoved++;
      else if (c.kind === 'elem-added') s.elemAdded++;
      else if (c.kind === 'elem-removed') s.elemRemoved++;
    }
  }
  return s;
}
