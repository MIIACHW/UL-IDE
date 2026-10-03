// Round-trip XML DOM — the foundation of the "unknown data is never lost" promise.
//
// parse(text) keeps EVERY byte-relevant artifact: comments, text/whitespace nodes,
// attribute order and original quoting, self-closing forms, DOCTYPE/PI/CDATA.
// serialize(doc) reproduces the input byte-for-byte as long as nothing was edited.
// Edits go through setAttr / insertElement / removeElement which patch the DOM in
// place; the generator then serializes. The UI never touches XML strings.

export function parseXML(text, { sourceName = 'xml' } = {}) {
  const len = text.length;
  let i = 0;
  let line = 1;
  const lineStarts = [0];
  for (let k = 0; k < len; k++) if (text.charCodeAt(k) === 10) lineStarts.push(k + 1);
  const lineOf = (offset) => {
    // binary search
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };

  const doc = { kind: 'doc', children: [], sourceName };

  function makeNode(kind, start) { return { kind, start, line: lineOf(start), parent: null }; }

  function fail(msg, at) {
    const err = new Error(`${sourceName}:${lineOf(at)}: ${msg}`);
    err.line = lineOf(at);
    err.xmlParse = true;
    throw err;
  }

  function parseOpenTag() {
    // text[i] === '<'
    const start = i;
    i++; // consume '<'
    let j = i;
    while (j < len && /[^\s/>]/.test(text[j])) j++;
    const name = text.slice(i, j);
    if (!name) fail('Empty element name', start);
    i = j;
    const node = makeNode('element', start);
    node.name = name;
    node.attrs = [];
    node.children = [];
    // attributes (whitespace between them is captured on each attr as .pre)
    const captureWs = () => { const s = i; while (i < len && /\s/.test(text[i])) i++; return text.slice(s, i); };
    let ws = captureWs();
    for (;;) {
      if (i >= len) fail('Unexpected EOF in tag', start);
      if (text[i] === '>') { i++; node.selfClosing = false; node.tailWs = ws; break; }
      if (text[i] === '/' && text[i + 1] === '>') { i += 2; node.selfClosing = true; node.tailWs = ws; break; }
      // attr name
      let a = i;
      while (i < len && /[^\s=/>]/.test(text[i])) i++;
      const aname = text.slice(a, i);
      if (!aname) fail('Cannot parse attribute', a);
      while (i < len && /\s/.test(text[i])) i++;
      let value = null, quote = '"';
      if (text[i] === '=') {
        i++;
        while (i < len && /\s/.test(text[i])) i++;
        if (text[i] === '"' || text[i] === "'") { quote = text[i]; i++; } else fail('Expected quoted attribute value', i);
        let v = i;
        while (i < len && text[i] !== quote) i++;
        if (i >= len) fail('Unterminated attribute value', a);
        value = text.slice(v, i);
        i++; // closing quote
      }
      const attr = { name: aname, value, quote, start: a, pre: '' };
      // keep the raw file bytes for byte-identical round-trip; decoded for consumers
      attr.raw = value;
      attr.value = value === null ? null : decodeEntities(value);
      attr.decoded = attr.value;
      attr.pre = ws;
      node.attrs.push(attr);
      ws = captureWs();
    }
    return node;
  }

  const rootStack = [doc];
  while (i < len) {
    const parent = rootStack[rootStack.length - 1];
    if (text[i] === '<') {
      if (text.startsWith('<!--', i)) {
        const start = i;
        const end = text.indexOf('-->', i + 4);
        if (end < 0) fail('Unterminated comment', start);
        const node = makeNode('comment', start);
        node.text = text.slice(i + 4, end);
        i = end + 3;
        parent.children.push(node); node.parent = parent;
        continue;
      }
      if (text.startsWith('<![CDATA[', i)) {
        const start = i;
        const end = text.indexOf(']]>', i + 9);
        if (end < 0) fail('Unterminated CDATA', start);
        const node = makeNode('cdata', start);
        node.text = text.slice(i + 9, end);
        i = end + 3;
        parent.children.push(node); node.parent = parent;
        continue;
      }
      if (text.startsWith('<!', i)) {
        const start = i;
        const end = text.indexOf('>', i);
        if (end < 0) fail('Unterminated <! declaration', start);
        const node = makeNode('doctype', start);
        node.text = text.slice(i + 2, end);
        i = end + 1;
        parent.children.push(node); node.parent = parent;
        continue;
      }
      if (text.startsWith('<?', i)) {
        const start = i;
        const end = text.indexOf('?>', i + 2);
        if (end < 0) fail('Unterminated processing instruction', start);
        const node = makeNode('pi', start);
        node.text = text.slice(i + 2, end);
        i = end + 2;
        parent.children.push(node); node.parent = parent;
        continue;
      }
      if (text.startsWith('</', i)) {
        const start = i;
        const end = text.indexOf('>', i);
        if (end < 0) fail('Unterminated closing tag', start);
        const name = text.slice(i + 2, end).trim();
        i = end + 1;
        if (parent === doc || parent.kind !== 'element') fail(`Unexpected closing </${name}>`, start);
        if (parent.name !== name) fail(`Mismatched closing tag: expected </${parent.name}> got </${name}>`, start);
        rootStack.pop();
        continue;
      }
      // open tag
      const el = parseOpenTag();
      el.parent = parent;
      parent.children.push(el);
      if (!el.selfClosing) rootStack.push(el);
      continue;
    }
    // text node
    const start = i;
    const next = text.indexOf('<', i);
    const end = next < 0 ? len : next;
    const node = makeNode('text', start);
    node.text = text.slice(start, end);
    parent.children.push(node); node.parent = parent;
    i = end;
  }
  if (rootStack.length > 1) fail(`Unclosed element <${rootStack[rootStack.length - 1].name}>`, len - 1);
  return doc;
}

export function decodeEntities(s) {
  return s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
export function encodeEntities(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function encodeAttrValue(s, quote) {
  let out = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (quote === '"') out = out.replace(/"/g, '&quot;');
  else out = out.replace(/'/g, '&apos;');
  return out;
}

export function serializeXML(node) {
  if (node.kind === 'doc') return node.children.map(serializeXML).join('');
  if (node.kind === 'text' || node.kind === 'comment' || node.kind === 'cdata' || node.kind === 'pi' || node.kind === 'doctype') {
    if (node.kind === 'text') return node.text;
    if (node.kind === 'comment') return '<!--' + node.text + '-->';
    if (node.kind === 'cdata') return '<![CDATA[' + node.text + ']]>';
    if (node.kind === 'pi') return '<?' + node.text + '?>';
    return '<!' + node.text + '>';
  }
  // element
  let out = '<' + node.name;
  for (const a of node.attrs) {
    out += (a.pre != null ? a.pre : ' ') + a.name;
    if (a.value !== null) out += '=' + a.quote + (a.raw != null ? a.raw : encodeAttrValue(a.decoded != null ? a.decoded : a.value, a.quote)) + a.quote;
  }
  if (node.tailWs) out += node.tailWs;
  if (node.selfClosing && node.children.length === 0) return out + '/>';
  out += '>';
  out += node.children.map(serializeXML).join('');
  out += '</' + node.name + '>';
  return out;
}

// ------------------------------------------------------------- edit helpers
export function getAttr(el, name) {
  const a = el.attrs.find(a => a.name === name);
  return a ? a.decoded : undefined;
}
export function hasAttr(el, name) { return el.attrs.some(a => a.name === name); }

export function setAttr(el, name, value) {
  let a = el.attrs.find(a => a.name === name);
  if (value === undefined || value === null) {
    el.attrs = el.attrs.filter(x => x !== a);
    return null;
  }
  value = String(value);
  if (!a) { a = { name, value, quote: '"', start: -1 }; el.attrs.push(a); }
  a.decoded = value;
  a.raw = encodeAttrValue(value, a.quote); // set raw so serialization uses our escaped form
  return a;
}

export function childElements(el) { return el.children.filter(c => c.kind === 'element'); }

export function textBefore(el) {
  const s = el.parent ? el.parent.children : [];
  const idx = s.indexOf(el);
  if (idx <= 0) return null;
  const prev = s[idx - 1];
  return prev && prev.kind === 'text' ? prev : null;
}
function indentOf(ws) {
  const m = /\r?\n([ \t]*)$/.exec(ws || '');
  return m ? m[1] : null;
}

// Guess the indentation used for the children of el (based on an existing child element's preceding whitespace).
function childIndent(el) {
  for (const c of el.children) {
    if (c.kind === 'element') {
      const ind = indentOf((textBefore(c) || {}).text);
      if (ind !== null) return ind;
    }
  }
  return null;
}

// Insert newEl immediately before refEl (both children of the same parent).
// Convention: an inserted element always carries its own leading whitespace node
// (flagged _auto) so a later delete can remove exactly what was added.
export function insertElementBefore(parent, newEl, refEl) {
  const kids = parent.children;
  const idx = refEl ? kids.indexOf(refEl) : -1;
  newEl.parent = parent;
  newEl.children = newEl.children || [];
  if (idx < 0) return appendElement(parent, newEl);
  // whitespace node directly before refEl supplies the indentation pattern
  const prev = idx > 0 ? kids[idx - 1] : null;
  const ws = prev && prev.kind === 'text' && /\n/.test(prev.text) ? prev : null;
  const wsClone = { kind: 'text', text: ws ? ws.text : ' ', _auto: true, parent };
  kids.splice(ws ? kids.indexOf(ws) : idx, 0, wsClone, newEl);
  return newEl;
}

export function appendElement(parent, newEl) {
  const kids = parent.children;
  newEl.parent = parent;
  newEl.children = newEl.children || [];
  // find trailing whitespace-only text node that ends with newline (the indentation of the closing tag)
  let endWs = null;
  for (let k = kids.length - 1; k >= 0; k--) {
    const c = kids[k];
    if (c.kind === 'text' && /^\s*$/.test(c.text) && /\n/.test(c.text)) { endWs = c; break; }
    if (c.kind === 'element') break;
  }
  const ind = childIndent(parent) ?? indentOf((endWs || {}).text) ?? '\t';
  const wsNew = { kind: 'text', text: '\n' + ind, _auto: true, parent };
  if (endWs) kids.splice(kids.indexOf(endWs), 0, wsNew, newEl);
  else kids.push(wsNew, newEl);
  return newEl;
}

export function removeElement(el) {
  if (!el.parent) return [el];
  const kids = el.parent.children;
  const idx = kids.indexOf(el);
  if (idx < 0) return [];
  // inserted elements own their leading _auto whitespace — remove the pair
  const prev = kids[idx - 1];
  if (prev && prev.kind === 'text' && prev._auto && /^\s*$/.test(prev.text)) {
    kids.splice(idx - 1, 2);
    return [prev, el];
  }
  // original element: remove el plus the whitespace that followed it (its line indent)
  const after = kids[idx + 1];
  if (after && after.kind === 'text' && /^\s*$/.test(after.text) && /\n/.test(after.text)) {
    kids.splice(idx, 2);
    return [el, after];
  }
  kids.splice(idx, 1);
  return [el];
}

export function makeElement(name, attrs = {}, { selfClosing = true } = {}) {
  const el = { kind: 'element', name, attrs: [], children: [], selfClosing, parent: null, start: -1, line: -1 };
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    const a = { name: k, value: String(v), quote: '"', start: -1 };
    a.decoded = String(v);
    a.raw = encodeAttrValue(String(v), '"');
    el.attrs.push(a);
  }
  return el;
}

// Deep-clone a subtree (used by duplicate node), keeping raw attr values.
export function cloneElement(el) {
  const c = { kind: el.kind, name: el.name, selfClosing: el.selfClosing, parent: null, start: -1, line: -1, children: [], attrs: [] };
  for (const a of el.attrs) c.attrs.push({ ...a });
  for (const ch of el.children) {
    const cc = cloneElement(ch);
    cc.parent = c;
    c.children.push(cc);
  }
  return c;
}

export function serializeNode(el) { return serializeXML(el); }

// DOM path like /Subquake/set/perks/perk[12] for locating nodes
export function domPath(el) {
  const parts = [];
  let cur = el;
  while (cur && cur.kind === 'element') {
    const siblings = cur.parent ? cur.parent.children.filter(c => c.kind === 'element' && c.name === cur.name) : [];
    const idx = siblings.indexOf(cur) + 1;
    parts.unshift(siblings.length > 1 ? `${cur.name}[${idx}]` : cur.name);
    cur = cur.parent;
  }
  return '/' + parts.join('/');
}

export function findRoot(doc, name) {
  for (const c of doc.children) if (c.kind === 'element' && c.name === name) return c;
  return null;
}
