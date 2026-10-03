// XML Generator — serializes the (edited) DOM back to file texts.
// All edits were applied to the DOM by commands; nothing is string-replaced.
import { serializeXML } from './xmldom.js';

export function generateFiles(tree) {
  const files = {};
  for (const sf of tree.sourceFiles) {
    let text = serializeXML(sf.dom);
    if (sf.bom === 'utf8') text = '\uFEFF' + text;
    files[sf.path] = text;
  }
  return files;
}

export function isDirty(tree, generated) {
  for (const [path, text] of Object.entries(generated)) {
    const sf = tree.sourceFiles.find(f => f.path === path);
    if (!sf || sf.text !== text) return true;
  }
  return false;
}
