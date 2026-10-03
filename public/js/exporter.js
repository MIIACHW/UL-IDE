// Export pipeline — Validate → Create Backup → Generate XML → Generate Diff → Export.
// Validation errors BLOCK the final write (per spec). Backups happen server-side
// into TechTreeIDE/backups/<timestamp>/ before anything touches the mod folder.
import { validate } from './validator.js';
import { generateFiles } from './generator.js';
import { lineDiff, structuredDiff, summarizeStructured } from './differ.js';
import { apiBackup, apiExport } from './api.js';

export function createExporter(ctx) {
  // ctx: {tree, modRoot, showProblems(), toast(msg, kind), log(msg)}
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
    const files = generateFiles(tree);
    const changedFiles = Object.entries(files)
      .filter(([p, text]) => (tree.sourceFiles.find(f => f.path === p)?.text !== text))
      .map(([p]) => p);

    if (changedFiles.length === 0) {
      ctx.toast('没有需要导出的修改。', 'info');
      return { ok: true, nothingToDo: true, summary };
    }

    // 3. preview diff summary for the confirm dialog
    const struct = summarizeStructured(structuredDiff(tree));
    const fileList = changedFiles.map(p => {
      const d = lineDiff(tree.sourceFiles.find(f => f.path === p).text, files[p]);
      const adds = d.rows.filter(r => r.type === 'add').length;
      const dels = d.rows.filter(r => r.type === 'del').length;
      return `  • ${p}  (+${adds} / -${dels} 行)`;
    }).join('\n');

    const msg = `即将写入 Mod 文件夹：\n${fileList}\n\n` +
      `变更统计: 属性改 ${struct.attrChanged} / 增 ${struct.attrAdded} / 删 ${struct.attrRemoved}，元素增 ${struct.elemAdded} / 删 ${struct.elemRemoved}\n\n` +
      `流程: 自动备份原始文件 → 写入新 XML（TechTreeIDE/export/ 留副本）。\n确认导出?`;
    if (confirmWrite && !confirm(msg)) return { ok: false, cancelled: true, summary };

    // 4. backup
    let backup;
    try {
      backup = await apiBackup(ctx.modRoot, changedFiles);
      ctx.log(`已备份 → ${backup.backupDir}`);
    } catch (e) {
      ctx.toast('备份失败，导出中止: ' + e.message, 'error');
      return { ok: false, backupFailed: true, summary };
    }

    // 5. export
    try {
      const toWrite = Object.fromEntries(changedFiles.map(p => [p, files[p]]));
      const res = await apiExport(ctx.modRoot, toWrite);
      ctx.toast(`导出完成: ${res.written.join(', ')}（备份: ${backup.backupDir}）`, 'ok');
      return { ok: true, written: res.written, backupDir: backup.backupDir, summary };
    } catch (e) {
      ctx.toast('导出失败（原始文件已备份）: ' + e.message, 'error');
      return { ok: false, exportFailed: true, summary };
    }
  }
  return { run };
}
