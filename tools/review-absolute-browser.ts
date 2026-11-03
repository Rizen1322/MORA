import { ABSOLUTE_DEFECTS, buildAbsoluteReviewExport, type AbsoluteReviewManifest } from './review-absolute-export.ts';

/** Inline UI for local-file reviews: a readable export remains available even
 * when the embedded browser blocks Blob downloads or clipboard access. */
export function absoluteExportBrowserScript(manifest: AbsoluteReviewManifest): string {
  buildAbsoluteReviewExport(manifest, {}, '2026-10-27T00:00:00.000Z');
  const encoded = JSON.stringify(manifest).replaceAll('<', '\\u003c');
  return `(() => {
    const identity = ${encoded}, allowedDefects = ${JSON.stringify(ABSOLUTE_DEFECTS)};
    const button = document.getElementById('export'), status = document.getElementById('status');
    const actions = button.parentElement; actions.style.flexWrap = 'wrap';
    const showButton = document.createElement('button'); showButton.textContent = 'Показать оценки текстом'; actions.insertBefore(showButton, status);
    const panel = document.createElement('section'); panel.id = 'export-text-panel'; panel.hidden = true;
    const help = document.createElement('p'); help.textContent = 'Если файл не скачивается, скопируйте этот текст и отправьте в чат. Можно выделить его и нажать Ctrl+C.';
    const field = document.createElement('textarea'); field.readOnly = true; field.setAttribute('aria-label', 'Оценки в формате JSON'); field.style.minHeight = '240px';
    const copy = document.createElement('button'); copy.textContent = 'Скопировать текст';
    panel.append(help, field, copy); document.body.append(panel);
    function collect() {
      const variantVotes = identity.groups.flatMap(group => group.variants.map(variant => {
        const v = votes[variant.variantId] || {};
        return { groupId: group.id, variantId: variant.variantId,
          rating: ['good','acceptable','bad'].includes(v.rating) ? v.rating : 'unrated',
          defects: Array.isArray(v.defects) ? [...new Set(v.defects.filter(d => allowedDefects.includes(d)))] : [],
          comment: typeof v.comment === 'string' ? v.comment : '' };
      }));
      return JSON.stringify({ schema: 'mora-listening-absolute-1', version: 1, reviewId: identity.reviewId,
        manifestSha256: identity.manifestSha256, exportedAt: new Date().toISOString(), variantVotes }, null, 2);
    }
    function show() { field.value = collect(); panel.hidden = false; return field.value; }
    showButton.onclick = () => { show(); field.focus(); field.select(); status.textContent = 'Текст оценок готов для копирования'; };
    copy.onclick = async () => {
      const text = show(); field.focus(); field.select();
      try { await navigator.clipboard.writeText(text); status.textContent = 'Текст оценок скопирован'; }
      catch { status.textContent = 'Текст выделен — нажмите Ctrl+C'; }
    };
    button.onclick = () => {
      const text = show(); let url, link;
      try {
        url = URL.createObjectURL(new Blob([text], {type:'application/json'})); link = document.createElement('a');
        link.href = url; link.download = identity.reviewId + '-notes.json'; document.body.append(link); link.click();
        status.textContent = 'Если файл не скачался, ниже доступен текст оценок';
      } catch { status.textContent = 'Скачивание недоступно — скопируйте текст оценок ниже'; }
      finally { if (link) link.remove(); if (url) setTimeout(() => URL.revokeObjectURL(url), 30000); }
    };
  })();`;
}
