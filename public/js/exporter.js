// Export pipeline — Validate → Create Backup → Generate XML → Generate Diff → Export.
// Validation errors BLOCK the final write (per spec). Backups happen server-side
// into TechTreeIDE/backups/<timestamp>/<ModName>/ before anything touches mod folders.
// Files are keyed "<ModName>/<Config-relative path>"; dropped (unsaved) files are
// offered as browser downloads instead.
import { validate } from './validator.js';
import { generateFiles } from './generator.js';
import { lineDiff, structuredDiff, summarizeStructured } from './differ.js';
import { apiBackup, apiExport } from './api.js';

export function createExporter(ctx) {
  // ctx: {tree, modsDir, showProblems(), toast(msg, kind), log(msg)}
  async function run({ confirmWrite = false } = {}) {
    const tree = ctx.tree;
    // 1. validate
    const { problems, summary } = validate(tree);
    ctx.problems = { problems, summary };
    ctx.showProblems();
    if (summary.errors > 0) {
      ctx.toast(`Validation 未通过：${summary.errors} 个 error（导出被阻止）`, 'error');
      return { ok: false, blocked: true, summary, problems };
    }

    // 2. generate
    const files = generateFiles(tree); // key: "<Mod>/<Config-relative path>" or "(drop)/<name>"
    const writable = {};
    const dropped = [];
    for (const [key, text] of Object.entries(files)) {
      const sf = tree.sourceFiles.find(f => `${f.mod}/${f.path}` === key);
      if (!sf) continue;
      if (sf.text !== text.replace(/^﻿/, '')) {
        if (sf.modRoot) writable[key] = text;
        else dropped.push({ key, text });
      }
    }

    if (Object.keys(writable).length === 0 && dropped.length === 0) {
      ctx.toast('没有需要导出的修改。', 'info');
      return { ok: true, nothingToDo: true, summary };
    }

    // 3. preview diff summary for the confirm dialog
    const struct = summarizeStructured(structuredDiff(tree));
    const fileList = Object.keys(writable).map(key => {
      const sf = tree.sourceFiles.find(f => `${f.mod}/${f.path}` === key);
      const d = lineDiff(sf.text, files[key]);
      const adds = d.rows.filter(r => r.type === 'add').length;
      const dels = d.rows.filter(r => r.type === 'del').length;
      return `  • ${key}  (+${adds} / -${dels} 行)`;
    });
    for (const d of dropped) fileList.push(`  • ${d.key}  (拖入文件 — 将通过浏览器下载)`);

    const msg = `即将写入 Mod 文件夹：\n${fileList.join('\n')}\n\n` +
      `变更统计: 属性改 ${struct.attrChanged} / 增 ${struct.attrAdded} / 删 ${struct.attrRemoved}，元素增 ${struct.elemAdded} / 删 ${struct.elemRemoved}\n\n` +
      `流程: 自动备份原始文件 → 写入新 XML（TechTreeIDE/export/ 留副本）。\n确认导出?`;
    if (confirmWrite && !confirm(msg)) return { ok: false, cancelled: true, summary };

    // 4. backup + export (writable files only)
    let backup = null;
    if (Object.keys(writable).length) {
      try {
        backup = await apiBackup(ctx.modsDir, Object.keys(writable));
        ctx.log(`已备份 → ${backup.backupDir}`);
      } catch (e) {
        ctx.toast('备份失败，导出中止: ' + e.message, 'error');
        return { ok: false, backupFailed: true, summary };
      }
      try {
        const res = await apiExport(ctx.modsDir, writable);
        ctx.toast(`导出完成: ${res.written.join(', ')}（备份: ${backup.backupDir}）`, 'ok');
      } catch (e) {
        ctx.toast('导出失败（原始文件已备份）: ' + e.message, 'error');
        return { ok: false, exportFailed: true, summary };
      }
    }

    // 5. dropped files — browser download (no server path to write to)
    for (const d of dropped) {
      const blob = new Blob([d.text], { type: 'application/xml' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = d.key.split('/').pop();
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
    if (dropped.length) ctx.toast(`拖入的 ${dropped.length} 个文件已通过浏览器下载（无对应 Mod 路径可写）`, 'info');
    return { ok: true, written: Object.keys(writable), dropped: dropped.map(d => d.key), backupDir: backup?.backupDir, summary };
  }
  return { run };
}
