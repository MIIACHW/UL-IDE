// XML Generator — serializes the (edited) DOM back to file texts.
// All edits were applied to the DOM by commands; nothing is string-replaced.
// Files are keyed "<ModName>/<Config-relative path>" for multi-mod export.
import { serializeXML } from './xmldom.js';

export function generateFiles(tree) {
  const files = {};
  for (const sf of tree.sourceFiles) {
    let text = serializeXML(sf.dom);
    if (sf.bom === 'utf8') text = '\uFEFF' + text;
    files[`${sf.mod}/${sf.path}`] = text;
  }
  return files;
}

export function isDirty(tree, generated) {
  for (const [key, text] of Object.entries(generated)) {
    const sf = tree.sourceFiles.find(f => `${f.mod}/${f.path}` === key);
    if (!sf) return true;
    // generated text carries the BOM (written back for the game); sf.text stores it stripped
    if (sf.text !== text.replace(/^\uFEFF/, '')) return true;
  }
  return false;
}
