# Undead Legacy Research Tree IDE

一个**本地运行的 7 Days to Die / Undead Legacy 科技树编辑 IDE**：
扫描真实 Mod 的 XML → 转换为统一科技树模型 → 图中可视化查看与编辑 → Validation → Diff → Backup → Export。

- **当前主功能：Research Tree**，数据来源 `Config/Custom/recipes_research.xml`（UL 的研究解锁系统，由 `UndeadLegacy.dll` 加载）。
- Progression Tree（`Config/progression.xml`，原版 perk/skill 格式）是**可选的次级数据**，需在界面里显式勾选才会加载。
- `Config/Custom/recipes_skills.xml` 中约 630 个径向技能布局节点（radial skill / graph layout，`radius/angle/links`）**明确排除**：不属于默认 Research Graph，不会被解析或显示。
- 零 npm 依赖，Node 18+ 即可运行。所有处理都在本机完成，除写回 Mod 文件外无任何网络行为。

## 功能总览

- **多 Mod 扫描**：一次扫描 Mods 目录下**所有**含 `ModInfo.xml` 的 Mod，自动识别科技树 XML 并按 Mod 区分（左栏可按 Mod 过滤）。
- **Research Graph**：SVG 画布查看研究树；滚轮缩放、拖动平移、Shift+拖动框选、双击聚焦、F 键适配视图；可拖入任意科技树 XML 自动识别。
- **Inspector 编辑**：ID 改名（级联更新所有引用文件）、desc / icon / 前置研究 / pos / area / category / unlocked / requires、unlocks 与 ingredients 的增删改（名称支持中文联想）、Unknown / Preserved 数据查看与编辑。
- **Undo / Redo**：所有编辑走命令栈（Ctrl+Z / Ctrl+Y），删除节点同样可撤销。
- **Validation**：Duplicate ID、悬空引用、循环依赖、非法 XML 等；问题面板点击可定位到节点。
- **Localization**：中英文显示（Mod 本地化 → 本体 `Localization.txt` 回退 → 兄弟汉化 Mod 叠加 → `dictionary.csv` 用户词典优先级最高）；可添加任意语言的 `Key,译文` 文件（`langs/*.txt`），其译文参与搜索与名称联想。
- **Icon 解析**：按"研究名（=物品名）→ 首个 unlocks → `symbol_*` 图标（含模糊匹配）"的回退链取图，来源为本体 `ItemIcons/` 与各 Mod 的 `UIAtlases/`（Icon 继承链随 `Extends`/`Icon` 属性解析）。
- **XML round-trip 保真**：未修改的文件序列化输出与原文件**逐字节一致**（含注释、Tab 对齐、属性顺序、未知标签、BOM）；schema 外的数据一律标记 Unknown / Preserved 保留，绝不丢弃。
- **Diff**：行级差异 + 属性/元素级结构摘要，按文件展示。
- **Backup / Export**：导出前自动备份原始文件（时间戳目录），只写有变化的文件，写回后留副本。

## 快速开始

### 1. 启动服务

IDE 本身就是一个 Mod 形式的文件夹（本仓库），放进游戏的 `Mods/` 目录即可（例如 `Mods/ULTechTreeIDE/`）。它不影响游戏运行。

```bash
# 在仓库根目录执行（package.json: npm start = node server.js）
node server.js
# 或
npm start
```

控制台会打印实际端口。浏览器打开 **http://localhost:8899**（端口被占用时自动 +1 重试，最多 10 次，以控制台输出为准）。

### 2. 扫描 Mods

服务启动后页面**自动扫描默认 Mods 目录**并加载 Research Tree。默认目录的判定规则（`server.js`）：

- IDE 文件夹的直接上级目录就是 Mods 目录（本仓库的典型安装位置 `Mods/ULTechTreeIDE/` → 扫描 `Mods/`）；
- 若上级目录本身是一个 Mod（含 `ModInfo.xml`，即 IDE 被放进了单个 Mod 里），则再向上一级；
- 也可以用环境变量 `UL_MODS_DIR` 显式指定，或在页面顶栏 **Open Mod** 里输入任意 Mods 目录（或单个 Mod 目录），点"扫描并打开"。

### 3. 环境变量与路径配置

| 环境变量 | 作用 | 默认值 |
|---|---|---|
| `UL_IDE_PORT` | 服务端口 | `8899` |
| `UL_MODS_DIR` | Mods 根目录 | IDE 上级目录（规则见上） |
| `UL_VANILLA_CONFIG` | 游戏本体 `Data/Config` 路径（**只读**，用于本地化键回退与图标参考） | `E:\STEAM\steamapps\common\7 Days To Die\Data\Config` |

> 注意：`UL_VANILLA_CONFIG` 的默认值是硬编码的本机路径。**在其他机器上运行时必须设置它**，否则本地化键回退与本体图标不可用（IDE 仍可运行，会以 warning 提示降级）。读取测试断言时另有 `UL_VANILLA_ROOT` 环境变量，见"测试"一节。

其他文件约定：

- `dictionary.csv`（仓库根目录）：用户词典，两列 CSV `Key,schinese`，优先级高于一切本地化来源；改完刷新页面生效。
- `langs/`：添加的额外语言文件（`<语言名>.txt`，两列 CSV `Key,译文`），见"本地化与图标解析规则"。
- `backups/`：导出前的自动备份（见下文 Export）。
- `export/`：每次写回 Mod 时的副本。

## 推荐使用流程

```
启动服务 → 打开浏览器 → 自动扫描 Mods → 加载 Research Tree
        → 搜索/过滤 → 选择节点 → Inspector 修改 →（Undo/Redo 可随时回退）
        → Validation → 查看 Diff → Export（自动 Backup → 写回 Mod）
```

逐步说明：

1. **启动并加载**：`node server.js` → 打开 http://localhost:8899 。左栏显示搜索框、Mod 列表、研究分支（对应游戏左侧 12 个大类）、边类型过滤；状态栏显示 Mod 数、节点/边数、修改状态、选中数。
2. **浏览 Research Tree**：滚轮缩放、拖动平移；`F` 或顶栏"⤢ 适配"回到全局视图；左栏勾选分支/Mod 过滤，或搜索 ID / 中文名 / 描述；勾选"只显示有问题的节点"聚焦 Validation 命中项。
3. **选择节点**：单击选中（Ctrl+单击可多选，Shift+拖动框选），右侧 Inspector 显示该节点；双击节点快速聚焦。
4. **编辑（Inspector）**：
   - **ID**：改名会级联更新其他 XML 里的 `parent` / `requires` / `progression_name` 引用（跨文件的改动也会全部进入 dirty 跟踪）。
   - **desc / icon**：描述键与图标符号；本地化解析结果实时显示在输入框下方（找不到会标 ⚠）。
   - **前置研究 parent**：下拉选择；选"（根节点）"即断开父级——节点在图中立即按根节点样式显示。
   - **pos / area / category / unlocked / requires**：对应 research 元素上的同名 XML 属性。
   - **unlocks（解锁物品）**：可增删改；名称输入框支持中文联想（数据来自本地化与词典）。研究名与同名物品/方块/配方的**隐式解锁**会单独列出（改名会同步改变隐式解锁目标）。
   - **ingredients（研究消耗）**：名称与数量的增删改。
   - **Unknown / Preserved**：schema 外的属性/子元素原样展示，可编辑，序列化时原样保留。
   - 底部按钮：原始 XML（底部 XML Preview 定位到该节点所在行）、复制节点、删除节点（可 Undo）。
5. **拖拽说明**：图中**拖动节点只调整 IDE 视图布局**，保存在浏览器 localStorage，**不写入 XML、不影响导出**（状态栏会显示"布局已调整（仅视图）"）。要改 XML 里的 `pos` 属性请在 Inspector 的 pos 字段修改。
6. **Undo / Redo**：Ctrl+Z / Ctrl+Y 或顶栏按钮；每次操作（含删除）都可撤销/重做。
7. **Validation**：顶栏 **Validate** 主动运行；编辑后约 0.4s 也会自动静默运行。结果在底部 **Problems** 面板，按 error / warning / info 分级，点击条目定位到图中节点并打开 Inspector。**存在 error 时导出会被阻止**（warning / info 不阻止）。
8. **查看 Diff**：顶栏 **Diff** 或底部 **Diff** 标签页：行级差异（+/-）+ 属性/元素级变更摘要，按文件分组。**XML Preview** 标签页显示当前 DOM 的完整序列化结果（即导出将写入的内容）。
9. **导出**：顶栏 **Save**（Ctrl+S）或 **Export**。固定流程：
   1. Validate —— 有 error 则中止；
   2. Create Backup —— 原始文件复制到 `backups/<YYYYMMDD-HHMMSS>/<ModName>/<原相对路径>`；
   3. 写回 Mod 的 `Config/…`（只写有实际变化的文件），副本存 `export/<ModName>/…`；
   4. 确认对话框中会列出每个文件的增删行数统计。
   - 若曾把外部 XML 拖入窗口（无对应 Mod 路径可写），导出时该文件通过浏览器下载。

## 数据范围

| 数据 | 状态 | 说明 |
|---|---|---|
| `Config/Custom/recipes_research.xml` | **默认加载（主功能）** | 589 个 `<research>` 节点 + `<unlocks>` + `<ingredient>`，Research Graph 的唯一数据源 |
| `Config/progression.xml` 等 progression 格式文件 | 可选（勾选"包含进度树 (progression)"后重新加载） | 原版格式的 attribute/skill/book_group/perk/book；Inspector 有对应的 progression 编辑视图 |
| `Config/Custom/recipes_skills.xml` 的径向技能图（~630 个 graph 布局节点） | **明确排除** | radial skill / graph layout（`radius`/`angle`/`links`）不属于 Research Graph，不解析、不显示；该文件仅作为 xmldom 格式回归测试的样本 |

## 架构与数据流

```
Raw XML → Scanner → Parser → Unified TechTree Model → IDE UI
        → Edit Model(Command/Undo) → Validator → XML Generator → Diff → Backup → Export
```

硬性约束（改代码前必读）：

- **UI 永远不直接字符串替换 XML。** 一切修改发生在 DOM 层（`xmldom.js` 的 round-trip DOM），由命令（`model.js`）应用，由 Generator（`generator.js`）序列化输出。
- **Parser 保证 round-trip**：未修改的文档序列化输出与原文件逐字节一致（注释、Tab 缩进、属性顺序、未知标签、BOM）。测试套件的核心断言就是它。
- **Unknown / Preserved**：解析器不认识的标签/属性进入 `unknownAttrs` / `unknownChildren`，UI 明确标注并原样保留。
- **服务器写入边界**：只读根 = 各扫描的 Mod 目录 + 本体 `Data/Config`；写入根 = 扫描到的 Mod 的 `Config/*.xml`，且必须先经过备份（服务器端有路径逃逸防护）。
- **性能约束**：普通点击只更新选中态 DOM，拖拽只更新节点 transform 与相连边，Inspector 修改只同步受影响节点；全量重建仅发生在首次加载、搜索/过滤变化或真正的结构变化。`window.__ide.debug` 暴露 fullRenders / selectionUpdates / nodeCreates / iconRequests / generateFilesCalls / dirty 等指标用于回归验证。

代码结构（均在仓库根目录）：

```
server.js          本地服务（扫描/备份/导出/图标 API，零依赖）
public/js/
  xmldom.js        round-trip XML DOM（解析/序列化/属性操作）
  scanner.js       扫描结果 → 解析 bundle（research/progression 分类在此收紧）
  parser.js        XML → 统一 TechTree 模型（本地化解析、unknown 保全）
  model.js         TechNode/TechEdge + 命令栈（do/undo，跨文件级联）
  graph.js         SVG 研究树画布（增量渲染）
  inspector.js     右侧属性编辑面板
  validator.js     校验（error/warning/info）
  generator.js     DOM → XML 文本
  differ.js        行级 + 结构化 Diff
  exporter.js      Validate → Backup → Export 管线
  panels.js        左栏过滤 + 底部 Problems/XML/Diff
test/run-tests.js  回归测试
```

## 本地化与图标解析规则

- 键解析优先级：`dictionary.csv`（用户词典）＞ 兄弟汉化 Mod 的 `Config/Localization/SChinese.txt`（按 Mods 目录序叠加，后者生效）＞ Mod 自身 English/SChinese ＞ 本体 `Data/Config/Localization.txt`（多列 CSV 回退）。
- **添加语言文件**：左栏"语言文件（多语言搜索）"→"＋ 添加语言文件"，选择 UTF-8 的两列 CSV（`Key,译文`，与 Mod 语言文件同格式）。文件保存到 `ULTechTreeIDE/langs/<语言名>.txt`（已被 gitignore，属本地用户数据），确认后自动重新加载——该语言的译文即可用于顶部搜索框过滤和 Inspector 名称联想（联想行会显示"语言: 译文"），节点显示名仍以中/英为准。`✕` 删除后同样自动重载。
- 研究节点的本地化键 = 研究名本身（与物品同名时游戏自动解锁该物品的制作，即"隐式解锁"）。
- 图标回退链：研究名（物品名）→ 第一个 `<unlocks>` 名 → research 的 `icon="symbol_*"`（含模糊匹配与内置符号兜底）→ 占位图；图标文件来自本体 `Data/ItemIcons/` 与各 Mod 的 `UIAtlases/ItemIconAtlas/`、`UIAtlases/UISkills/`。

## 测试

```bash
npm test
# 或
node test/run-tests.js
```

覆盖：xmldom round-trip 逐字节一致（research/progression/recipes_skills/ModInfo 四个文件）、解析数量断言、双语本地化、自定义语言文件（多语言搜索语料）、validator 行为、命令（改属性/改名/删除/复制/增删 unlocks 与 ingredients）与其 Undo 的字节还原、跨文件改名 dirty 跟踪、Diff。当前 32 项断言，全绿为通过标准。

可选环境变量 `UL_VANILLA_ROOT`：指向游戏根目录（默认同 `UL_VANILLA_CONFIG` 的游戏目录），供"本体本地化键回退"相关断言使用；不可用时相关断言自动跳过。

## 已知事项

- UL 2.7.01 的 perk name_key/desc_key 大量只存在于本体 `Localization.txt` 或兄弟汉化 Mod 中——**这不是错误**；当前版本 validator 对出厂原始数据（research + progression 全量）报告 **0 error**，导出不会被阻止。找不到键时以 `MissingLocalization` warning 提示（如 `ulmPerkGiftOfLife` 等确缺失的键，游戏中回退显示键名）。
- 默认视图只含 Research Tree；`perkSpearHunter` 系列等 progression 数据需显式勾选"包含进度树"才会出现。
- 游戏内的研究树布局由 UL 的 DLL 自行整理（XML 的 `pos` 只是提示且坐标会重叠）；IDE 图中布局是等价的分层视图，拖拽仅影响 IDE 视图。
- `server.js` 里 `UL_VANILLA_CONFIG` 的默认值是硬编码的本机 Steam 路径，其他环境请务必通过环境变量覆盖。

## 本地 API 一览（供二次开发 / Agent 参考）

| 路由 | 方法 | 用途 |
|---|---|---|
| `/api/defaults` | GET | 默认 Mods 目录扫描结果（含 nameIndex、词典） |
| `/api/scan` | POST `{path}` | 扫描指定 Mods 目录（或单个 Mod 目录） |
| `/api/vanilla` | GET `?path=` | 只读读取本体文件（限 Vanilla 根内） |
| `/api/readmod` | GET `?path=&root=` | 只读读取文件（`root` 缺省为 Mods 根，限根内） |
| `/api/backup` | POST `{modRoot, files:[key]}` | 将要导出的文件备份到 `backups/<时间戳>/` |
| `/api/export` | POST `{modRoot, files:{key:text}, confirm:true}` | 写回 Mod `Config/*.xml` 并留副本到 `export/`（必须显式 `confirm:true`） |
| `/api/langs` | GET / POST `{name,text}` / DELETE `?name=` | 管理 `langs/` 下的自定义语言文件（多语言搜索） |
| `/api/icon` | GET `?name=&fuzzy=` | 按物品名/符号名取图标 PNG（含继承链与模糊匹配） |

文件键格式统一为 `<ModName>/<Config 相对路径>`（如 `UndeadLegacy/Config/Custom/recipes_research.xml`）。
