// Thin fetch wrappers for the local IDE server.
async function j(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({ ok: false, error: 'Bad JSON from server' }));
  if (!res.ok && data && !data.error) data.error = res.statusText;
  return data;
}

export function apiDefaults() { return j('/api/defaults'); }
export function apiScan(modRoot) {
  return j('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: modRoot }) });
}
export function apiVanilla(relPath) { return j('/api/vanilla?path=' + encodeURIComponent(relPath)); }
export function apiReadMod(relPath, modRoot) { return j('/api/readmod?path=' + encodeURIComponent(relPath) + '&root=' + encodeURIComponent(modRoot)); }
export function apiBackup(modRoot, files) {
  return j('/api/backup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modRoot, files }) });
}
export function apiExport(modRoot, files) {
  return j('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modRoot, files, confirm: true }) });
}
export function apiLangs() { return j('/api/langs'); }
export function apiAddLang(name, text) {
  return j('/api/langs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, text }) });
}
export function apiDeleteLang(name) { return j('/api/langs?name=' + encodeURIComponent(name), { method: 'DELETE' }); }
