# Undead Legacy Tech Tree IDE

一个真正可编辑 Undead Legacy（7 Days to Die）科技树的本地 IDE：
扫描真实 Mod XML → 统一模型 → 图中查看/编辑 → Validation → Diff → Backup → Export。

## 启动

```
cd TechTreeIDE
node server.js
```

浏览器打开 http://localhost:8899（端口被占用时自动 +1，看控制台输出）。
零 npm 依赖，Node 18+ 即可。

默认自动扫描上级目录的 Mod（即 UndeadLegacy 本体）；也可用 Open Mod 输入其他
Mod 根目录路径（必须包含 ModInfo.xml）。

## 功能

- **层级视图**：attributes → skills/book_groups → perks/books 按分类分带排布；
  **UL 径向图**：按 recipes_skills.xml 的 radius/angle 还原游戏内职业图
  （TANK/RANGER/SCOUT/SUPPORT/WARRIOR）。
- 拖拽节点（图节点拖拽会把 radius/angle 写回 XML）、端口拖拽连线、Shift 框选、
  滚轮缩放、拖动平移、F/⤢ 适配、双击聚焦。
- Inspector：ID（改名级联更新所有引用）、name_key/desc_key（实时显示本地化解析）、
  图标、父节点、max_level、点数消耗、前置依赖增删改、requirements/effects 增删改、
  Unknown/Preserved 数据查看（绝不丢弃）、来源文件与行号、原始 XML。
- Problems：Duplicate ID / Missing Dependency / Circular Dependency / Invalid
  Requirement / Invalid Effect / Invalid Level / Missing Localization / Missing Icon /
  Invalid XML / Unknown Structure，点击定位到图与 Inspector。
- Diff：行级差异 + 属性/元素级结构摘要。
- Save/Export：Validate（有 error 则阻止）→ 自动备份到 `TechTreeIDE/backups/<时间戳>/`
  → 写入 Mod（`TechTreeIDE/export/` 留副本）。

## 数据流（架构约束）

```
Raw XML → Scanner → Parser → Unified TechTree Model → IDE UI
        → Edit Model(Command/Undo) → Validator → XML Generator → Diff → Backup → Export
```

UI 永远不直接字符串替换 XML。所有编辑通过命令栈（Ctrl+Z / Ctrl+Y）作用于
round-trip DOM——未修改的文件序列化输出与原文件逐字节一致（含注释、Tab 对齐、
属性顺序、未知标签、BOM）。

## 测试

```
node test/run-tests.js
```

25 项断言，核心断言是未修改文件的 round-trip 逐字节一致、原始数据的引用闭合、
以及编辑→Undo→字节还原。

## 已知事项

- 出厂 UL 2.7.01 自带 1 处悬空引用（progression.xml:1131 →
  `perkSpearHunter6PuncturedLung` 未定义），Validation 会报 MissingDependency
  error 并阻止导出——在 IDE 中修复该引用后即可导出。
- Mod 的 Localization 缺少部分 ulm* 键（如 ulmPerkGiftOfLifeName），游戏会回退
  显示键名；Validation 以 warning 报告。
