// UI localization — the IDE's own chrome in Chinese and English.
// t(key, params) interpolates {name} placeholders; static index.html elements carry
// data-i18n / data-i18n-title / data-i18n-ph attributes applied by applyStatic().
// Dynamic panels (left/bottom/inspector/exporter) call t() at render time and are
// re-rendered on language switch by the top-bar toggle in app.js.
const STRINGS = {
  zh: {
    'topbar.open': '打开 Mod', 'topbar.undo': '撤销', 'topbar.redo': '重做',
    'topbar.validate': '校验', 'topbar.diff': '差异', 'topbar.save': '保存',
    'topbar.saveTitle': 'Ctrl+S — 校验→备份→写入 Mod', 'topbar.export': '导出',
    'topbar.researchLabel': '研究树', 'topbar.fit': '⤢ 适配', 'topbar.fitTitle': 'F',
    'panel.left': '科技树', 'panel.inspector': '节点检查器',
    'center.hint': '滚轮缩放 · 拖动平移 · Shift+拖动框选 · 双击节点聚焦 · 可拖入科技树 XML 自动识别',
    'tab.problems': '问题', 'tab.xml': 'XML 预览', 'tab.diff': '差异',
    'dialog.title': '打开 Mod 文件夹',
    'dialog.hint': '输入 Mods 目录（自动扫描其中所有 Mod 的科技树 XML）或单个 Mod 目录：',
    'dialog.useCurrent': '使用当前 Mod (UndeadLegacy)', 'dialog.go': '扫描并打开',

    'status.unloaded': '未加载',
    'status.mods': '{n} 个 Mod', 'status.nodesEdges': '节点 {n} · 边 {m}',
    'status.dirty': '● 有未导出修改 ({n} 文件)', 'status.clean': '○ 与原始文件一致',
    'status.viewDirty': '布局已调整（仅视图，不写入 XML）', 'status.selected': '选中 {n}',
    'status.undoAvailable': '撤销可用: {label}', 'status.validation': 'validation: ✖{e} ⚠{w} ℹ{i}',

    'toast.scanning': '扫描 Mods 文件夹…',
    'toast.loaded': '已加载 {n} 个 Mod: {nodes} 节点 / {edges} 边（{m} 个 Mod 含科技树）',
    'toast.initFailed': '初始化失败: {msg}',
    'toast.scanFallback': '自动扫描失败 — 请通过 打开 Mod 手动指定 Mods 目录',
    'toast.opFailed': '操作失败: {msg}', 'toast.undoFailed': '撤销失败: {msg}',
    'toast.undone': '撤销: {label}', 'toast.redone': '重做: {label}',
    'confirm.reloadDirty': '重新加载将丢弃未导出的修改。继续?',
    'locate.missing': '节点 "{id}" 不存在',
    'drop.noXml': '请拖入 .xml 文件',
    'drop.unknown': '无法识别 {name}（未找到 research/progression 结构）',
    'drop.roleResearch': '研究树', 'drop.roleProgression': '进度树',
    'drop.recognized': '已识别 {name} → {role}',
    'confirm.dropReload': '拖入将按当前扫描+已拖入文件重建模型，未导出的修改会丢失。继续?',
    'toast.droppedDownloaded': '拖入的 {n} 个文件已通过浏览器下载（无对应 Mod 路径可写）',
    'confirm.langReload': '添加语言文件将重新加载工作区，未导出的修改会丢失。继续?',
    'toast.langAdded': '已添加语言文件 {name}（{n} 条）—— 搜索与名称联想现在支持该语言',
    'toast.langEmpty': '语言文件为空或无法解析（需要 Key,译文 两列 CSV，UTF-8）',
    'toast.langAddFailed': '添加语言文件失败: {msg}', 'toast.langDelFailed': '删除语言文件失败: {msg}',
    'toast.langDeleted': '已删除语言文件 {name}',
    'confirm.langDelete': '删除语言文件 "{name}"？该语言的译文将不再参与搜索。',

    'left.searchPh': '搜索 ID / 中文名 / 描述…',
    'left.includeProgression': '包含进度树 (progression)', 'left.mods': 'Mod',
    'left.branches': '研究分支（对应游戏左侧大类）',
    'left.edgeTypes': '边类型', 'left.edgeParent': '层级 parent', 'left.edgeRequires': '额外前置 requires',
    'left.langTitle': '语言文件（多语言搜索）', 'left.langEntries': '{n} 条',
    'left.addLang': '＋ 添加语言文件',
    'left.addLangTitle': '选择一个 Key,译文 格式的 .txt 文件，确认后其译文可用于搜索与名称联想',
    'left.langDelTitle': '删除该语言文件',
    'left.onlyProblems': '只显示有问题的节点',

    'bottom.runValidation': '▶ 运行完整 Validation', 'bottom.clickLocate': '点击在图中定位',
    'bottom.moreCount': '… 共 {n} 条',
    'bottom.genDiff': '⟳ 生成 Diff（当前模型 vs 原始文件）', 'bottom.autoRegen': '导出前会自动重新生成',
    'bottom.noDiff': '✓ 无差异 — 模型与原始文件一致',
    'bottom.diffSummary': '{n} 个文件有变更: 属性修改 {a} · 属性新增 {b} · 属性删除 {c} · 元素新增 {d} · 元素删除 {e}',

    'insp.emptyHtml': '点击图中节点查看与编辑属性。<br><br>双击节点可快速聚焦。<br>节点下方显示的是本地化中文名称。<br>支持把任意科技树 XML 拖入窗口识别。',
    'insp.identity': '标识', 'insp.desc': '描述 desc', 'insp.iconSymbol': '图标 icon（符号）',
    'insp.researchSettings': '研究设置', 'insp.parent': '前置研究 parent',
    'insp.pos': '坐标 pos（布局提示）', 'insp.area': '区域 area', 'insp.category': '分类 category',
    'insp.unlocked': '初始解锁 unlocked', 'insp.requires': '额外前置 requires',
    'insp.unlocks': '解锁物品 unlocks', 'insp.add': '＋ 添加',
    'insp.sameName': '同名{kind}', 'insp.kindItem': '物品', 'insp.kindBlock': '方块', 'insp.kindRecipe': '配方',
    'insp.sameNameTitle': '研究名与同名{kind}——游戏自动解锁它的制作配方。改名会同步改变隐式解锁目标。',
    'insp.noUnlocks': '无解锁（研究名不同名任何物品/方块/配方，也没有显式 unlocks）',
    'insp.ingredients': '研究消耗 ingredients', 'insp.countTitle': '数量',
    'insp.noDict': '（词典中无此键 — 可加入 TechTreeIDE/dictionary.csv）',
    'insp.notFound': '⚠ 未找到', 'insp.rawXml': '原始 XML', 'insp.duplicate': '复制节点',
    'insp.deleteNode': '删除节点', 'insp.source': '来源', 'insp.line': '行 {n}',
    'insp.unknownSection': 'Unknown / Preserved ({n})',
    'insp.rootOption': '（根节点）', 'insp.idExists': 'ID "{v}" 已存在',
    'insp.delConfirm': '删除节点 "{id}"？\n\n该节点被 {refs} 处属性引用（将一并失效，Validation 会报告悬空引用）。\n删除可通过 Undo 撤销。',
    'insp.nameKey': '名称键 name_key', 'insp.descKey': '描述键 desc_key', 'insp.icon': '图标 icon',
    'insp.levelCost': '等级与消耗', 'insp.hierarchy': '层级与前置',
    'insp.parentNode': '父节点 parent', 'insp.prereqList': 'ProgressionLevel 前置引用:',
    'insp.noPrereq': '无 ProgressionLevel 前置（效果体内的条件已保留在 XML 中）',
    'insp.kind.attribute': '属性大类', 'insp.kind.skill': '技能', 'insp.kind.book_group': '书组',
    'insp.kind.perk': 'Perk', 'insp.kind.book': '书', 'insp.kind.progression': '进度节点', 'insp.kind.research': '研究节点',

    'exp.blocked': 'Validation 未通过：{n} 个 error（导出被阻止）', 'exp.nothing': '没有需要导出的修改。',
    'exp.confirm': '即将写入 Mod 文件夹：\n{list}\n\n变更统计: 属性改 {a} / 增 {b} / 删 {c}，元素增 {d} / 删 {e}\n\n流程: 自动备份原始文件 → 写入新 XML（TechTreeIDE/export/ 留副本）。\n确认导出?',
    'exp.droppedNote': '拖入文件 — 将通过浏览器下载',
    'exp.backupFail': '备份失败，导出中止: {msg}', 'exp.exportFail': '导出失败（原始文件已备份）: {msg}',
    'exp.done': '导出完成: {files}（备份: {dir}）',
  },
  en: {
    'topbar.open': 'Open Mod', 'topbar.undo': 'Undo', 'topbar.redo': 'Redo',
    'topbar.validate': 'Validate', 'topbar.diff': 'Diff', 'topbar.save': 'Save',
    'topbar.saveTitle': 'Ctrl+S — validate → backup → write to mod', 'topbar.export': 'Export',
    'topbar.researchLabel': 'Research Tree', 'topbar.fit': '⤢ Fit', 'topbar.fitTitle': 'F',
    'panel.left': 'Technologies', 'panel.inspector': 'Node Inspector',
    'center.hint': 'wheel zoom · drag pan · Shift+drag box-select · double-click to focus · drop tech-tree XML files to load them',
    'tab.problems': 'Problems', 'tab.xml': 'XML Preview', 'tab.diff': 'Diff',
    'dialog.title': 'Open mod folder',
    'dialog.hint': 'Enter a Mods folder (all mods in it are scanned for tech-tree XML) or a single mod folder:',
    'dialog.useCurrent': 'Use current mod (UndeadLegacy)', 'dialog.go': 'Scan and open',

    'status.unloaded': 'Not loaded',
    'status.mods': '{n} mods', 'status.nodesEdges': '{n} nodes · {m} edges',
    'status.dirty': '● unsaved changes ({n} files)', 'status.clean': '○ matches original files',
    'status.viewDirty': 'layout adjusted (view only, never written to XML)', 'status.selected': '{n} selected',
    'status.undoAvailable': 'undo: {label}', 'status.validation': 'validation: ✖{e} ⚠{w} ℹ{i}',

    'toast.scanning': 'Scanning Mods folder…',
    'toast.loaded': 'Loaded {n} mods: {nodes} nodes / {edges} edges ({m} mods with tech trees)',
    'toast.initFailed': 'Initialization failed: {msg}',
    'toast.scanFallback': 'Auto-scan failed — pick a Mods folder via Open Mod',
    'toast.opFailed': 'Operation failed: {msg}', 'toast.undoFailed': 'Undo failed: {msg}',
    'toast.undone': 'Undone: {label}', 'toast.redone': 'Redone: {label}',
    'confirm.reloadDirty': 'Reloading discards unsaved changes. Continue?',
    'locate.missing': 'Node "{id}" does not exist',
    'drop.noXml': 'Please drop .xml files',
    'drop.unknown': 'Unrecognized {name} (no research/progression structure)',
    'drop.roleResearch': 'research tree', 'drop.roleProgression': 'progression tree',
    'drop.recognized': 'Recognized {name} → {role}',
    'confirm.dropReload': 'Dropping rebuilds the model from the current scan plus dropped files; unsaved changes are lost. Continue?',
    'toast.droppedDownloaded': '{n} dropped file(s) downloaded via browser (no mod path to write)',
    'confirm.langReload': 'Adding a language file reloads the workspace; unsaved changes are lost. Continue?',
    'toast.langAdded': 'Language file {name} added ({n} entries) — search and name suggestions now support it',
    'toast.langEmpty': 'Language file empty or unparseable (needs a two-column Key,Translation CSV, UTF-8)',
    'toast.langAddFailed': 'Failed to add language file: {msg}', 'toast.langDelFailed': 'Failed to delete language file: {msg}',
    'toast.langDeleted': 'Language file {name} deleted',
    'confirm.langDelete': 'Delete language file "{name}"? Its translations will no longer be searchable.',

    'left.searchPh': 'Search id / name / description…',
    'left.includeProgression': 'Include progression tree', 'left.mods': 'Mods',
    'left.branches': 'Research branches (game left-side categories)',
    'left.edgeTypes': 'Edge types', 'left.edgeParent': 'parent', 'left.edgeRequires': 'requires',
    'left.langTitle': 'Language files (multi-language search)', 'left.langEntries': '{n} entries',
    'left.addLang': '+ Add language file',
    'left.addLangTitle': 'Pick a Key,Translation .txt file; after confirming, its translations feed search and name suggestions',
    'left.langDelTitle': 'Remove this language file',
    'left.onlyProblems': 'Show only nodes with problems',

    'bottom.runValidation': '▶ Run full validation', 'bottom.clickLocate': 'Click to locate in graph',
    'bottom.moreCount': '… {n} total',
    'bottom.genDiff': '⟳ Generate diff (current model vs original files)', 'bottom.autoRegen': 'regenerated automatically before export',
    'bottom.noDiff': '✓ no differences — model matches the original files',
    'bottom.diffSummary': '{n} file(s) changed: attrs changed {a} · added {b} · removed {c} · elements added {d} · removed {e}',

    'insp.emptyHtml': 'Click a node in the graph to view and edit it.<br><br>Double-click focuses a node.<br>Names below nodes are localized display names.<br>Drop any tech-tree XML onto the window to load it.',
    'insp.identity': 'Identity', 'insp.desc': 'desc', 'insp.iconSymbol': 'icon (symbol)',
    'insp.researchSettings': 'Research settings', 'insp.parent': 'parent research',
    'insp.pos': 'pos (layout hint)', 'insp.area': 'area', 'insp.category': 'category',
    'insp.unlocked': 'unlocked', 'insp.requires': 'extra requires',
    'insp.unlocks': 'unlocks', 'insp.add': '+ Add',
    'insp.sameName': 'implicit {kind}', 'insp.kindItem': 'item', 'insp.kindBlock': 'block', 'insp.kindRecipe': 'recipe',
    'insp.sameNameTitle': 'The research shares its name with this {kind} — the game unlocks its crafting recipe automatically. Renaming the research moves the implicit unlock target.',
    'insp.noUnlocks': 'No unlocks (name matches no item/block/recipe and no explicit unlocks)',
    'insp.ingredients': 'ingredient costs', 'insp.countTitle': 'count',
    'insp.noDict': '(no dictionary entry — add it to TechTreeIDE/dictionary.csv)',
    'insp.notFound': '⚠ not found', 'insp.rawXml': 'Raw XML', 'insp.duplicate': 'Duplicate node',
    'insp.deleteNode': 'Delete node', 'insp.source': 'Source', 'insp.line': 'line {n}',
    'insp.unknownSection': 'Unknown / Preserved ({n})',
    'insp.rootOption': '(root)', 'insp.idExists': 'ID "{v}" already exists',
    'insp.delConfirm': 'Delete node "{id}"?\n\nIt is referenced by {refs} attribute value(s) (they will dangle; validation reports them).\nThe deletion can be undone.',
    'insp.nameKey': 'name_key', 'insp.descKey': 'desc_key', 'insp.icon': 'icon',
    'insp.levelCost': 'Levels & costs', 'insp.hierarchy': 'Hierarchy & prerequisites',
    'insp.parentNode': 'parent', 'insp.prereqList': 'ProgressionLevel references:',
    'insp.noPrereq': 'No ProgressionLevel prerequisites (in-effect conditions are preserved in the XML)',
    'insp.kind.attribute': 'attribute', 'insp.kind.skill': 'skill', 'insp.kind.book_group': 'book group',
    'insp.kind.perk': 'perk', 'insp.kind.book': 'book', 'insp.kind.progression': 'progression node', 'insp.kind.research': 'research node',

    'exp.blocked': 'Validation failed: {n} error(s) — export blocked', 'exp.nothing': 'Nothing to export.',
    'exp.confirm': 'About to write to mod folders:\n{list}\n\nChanges: attrs changed {a} / added {b} / removed {c}, elements added {d} / removed {e}\n\nFlow: originals are backed up automatically → new XML written (copy kept in TechTreeIDE/export/).\nConfirm export?',
    'exp.droppedNote': 'dropped file — downloaded via browser',
    'exp.backupFail': 'Backup failed, export aborted: {msg}', 'exp.exportFail': 'Export failed (originals backed up): {msg}',
    'exp.done': 'Exported: {files} (backup: {dir})',
  },
};

let lang = 'zh';
try { lang = localStorage.getItem('ul-ide-lang') === 'en' ? 'en' : 'zh'; } catch { /* default zh */ }

export function t(key, params) {
  let s = STRINGS[lang][key] ?? STRINGS.zh[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split('{' + k + '}').join(String(v));
  return s;
}
export function getLang() { return lang; }
export function setLang(l) {
  lang = l === 'en' ? 'en' : 'zh';
  try { localStorage.setItem('ul-ide-lang', lang); } catch { /* private mode */ }
}

// Apply translations to the static chrome in index.html (data-i18n / -title / -ph attrs).
export function applyStatic(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
  root.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
}
