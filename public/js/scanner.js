// Scanner — assembles the parser bundle from the multi-mod server scan payload:
// every mod's tree-classified XML (research-style + progression-style) with content,
// per-mod localization (English/SChinese), the name index and the user dictionary.
import { apiVanilla } from './api.js';

// Client-side classifier for dropped XML files (same tightened rules as the server).
export function classifyXml(text, filename = '') {
  const lower = String(filename).toLowerCase();
  if (/<research[\s>]/.test(text)) {
    const patched = /<(set|append)\s+[^>]*xpath\s*=/i.test(text) || /<configs?\s*>/i.test(text) || /<Subquake\s*>/i.test(text);
    if (lower.includes('research') || patched) return 'research';
  }
  if (/<(attributes|skills|perks)[\s>]/.test(text) && /<(perk|skill|book_group|attribute)\s+[^>]*name="/.test(text)) return 'progression';
  return null;
}

export async function scanWorkspace(scanResult, log = () => {}, { includeProgression = false } = {}) {
  const bundle = {
    modsDir: scanResult.modsDir,
    mods: scanResult.mods || [],
    modInfo: scanResult.mods?.[0] || null,
    scannedAt: new Date().toISOString(),
    sourceFiles: [],         // [{mod, modRoot, path, role, text, bom, sha1}]
    localizationFiles: [],   // [{mod, path, lang, text, bom}]
    nameIndex: scanResult.nameIndex || { items: [], blocks: [], recipes: [] },
    customDictionary: scanResult.customDictionary || null,
    vanilla: {},
    warnings: [],
  };

  // 1. tech tree files — research always; progression only as explicit opt-in
  for (const sf of scanResult.sourceFiles || []) {
    if (sf.role === 'progression' && !includeProgression) continue;
    bundle.sourceFiles.push(sf);
    log(`科技树来源: [${sf.mod}] ${sf.path} (${sf.size} bytes) [${sf.role}]`);
  }
  if (!bundle.sourceFiles.length) {
    bundle.warnings.push('未在任何 Mod 中找到科技树 XML（research 或 progression 结构）。');
  }
  log(`来源文件: ${bundle.sourceFiles.length} 个，涉及 Mod: ${[...new Set(bundle.sourceFiles.map(s => s.mod))].join(', ')}`);

  // 2. localization (per mod, load order = folder order; later mods override earlier)
  for (const lf of scanResult.localizationFiles || []) {
    bundle.localizationFiles.push(lf);
  }
  log(`本地化文件: ${bundle.localizationFiles.length} 个`);

  // 3. vanilla reference (read-only): base Localization.txt for key fallback
  try {
    const vloc = await apiVanilla('Config/Localization.txt');
    if (vloc.ok) {
      bundle.vanilla.localization = vloc;
      log(`本体本地化已加载（键回退参考, ${vloc.text.length} chars）`);
    } else {
      bundle.warnings.push('无法读取本体 Localization.txt，键回退校验将受限: ' + vloc.error);
    }
  } catch (e) {
    bundle.warnings.push('本体参考读取失败: ' + e.message);
  }

  return bundle;
}
