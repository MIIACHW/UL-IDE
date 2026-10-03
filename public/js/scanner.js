// Scanner — walks the server scan payload and assembles the raw material bundle
// (mod definition files + localization + vanilla reference files) for the parser.
import { apiVanilla, apiReadMod } from './api.js';

// The file that defines the research tech tree (verified against the installed mod).
export const SOURCE_MATCHERS = [
  { path: 'config/custom/recipes_research.xml', role: 'research' },
];

export function roleOf(relPath) {
  const n = String(relPath).toLowerCase().replace(/\\/g, '/');
  return SOURCE_MATCHERS.find(m => n === m.path)?.role || 'other';
}

export async function scanWorkspace(scanResult, log = () => {}) {
  const bundle = {
    modRoot: scanResult.modRoot,
    modInfo: scanResult.modInfo,
    scannedAt: new Date().toISOString(),
    sourceFiles: [],
    localizationFiles: [],   // [{path, text, bom, lang}]
    communityLocalization: [], // [{mod, path, text, lang}] — sibling-mod Chinese, load order
    atlases: scanResult.atlases || [],
    nameIndex: scanResult.nameIndex || { items: [], blocks: [], recipes: [] },
    vanilla: {},             // {localization: {text, bom, sha1}}
    warnings: [],
  };

  // 1. tech tree definition files (content already delivered by the scan)
  for (const sf of scanResult.sourceFiles) {
    bundle.sourceFiles.push({ ...sf, role: roleOf(sf.path) });
    log(`来源文件: ${sf.path} (${sf.size} bytes) [${bundle.sourceFiles[bundle.sourceFiles.length - 1].role}]`);
  }
  if (!bundle.sourceFiles.some(s => s.role === 'research')) {
    bundle.warnings.push('未找到 Config/Custom/recipes_research.xml — 目标文件夹可能不是 Undead Legacy。');
  }

  // 2. localization files (mod level, override vanilla keys)
  for (const locPath of scanResult.localization || []) {
    try {
      const res = await apiReadMod(locPath, scanResult.modRoot);
      if (res.ok) {
        const lang = locPath.split('/').pop().replace(/\.txt$/i, '');
        bundle.localizationFiles.push({ path: locPath, text: res.text, bom: res.bom, lang });
      }
    } catch (e) {
      bundle.warnings.push('本地化读取失败 ' + locPath + ': ' + e.message);
    }
  }
  log(`本地化文件: ${bundle.localizationFiles.length} 个`);

  // 2b. community Chinese from sibling localization mods (already delivered by the scan)
  bundle.communityLocalization = scanResult.communityLocalization || [];
  if (bundle.communityLocalization.length) {
    log(`社区中文翻译: ${bundle.communityLocalization.map(c => c.mod).join(', ')}`);
  }

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
