import { describe, expect, it } from 'vitest';
import { createContext, runInContext } from 'node:vm';
import { absoluteExportBrowserScript } from '../../../tools/review-absolute-browser.ts';
import { validateAbsoluteReviewExport } from '../../../tools/review-absolute-export.ts';

const manifest = { reviewId: 'review-closure-2026-10-27-v2', manifestSha256: 'a'.repeat(64),
  groups: [{ id: 204, variants: [{ variantId: 'original' }, { variantId: 'new' }] }] };

function browser(votes: object) {
  class Element {
    children: Element[] = []; style = {}; textContent = ''; value = ''; hidden = false; readOnly = false;
    id = ''; parentElement?: Element; onclick?: () => unknown; selected = false;
    append(...items: Element[]) { for (const item of items) { this.children.push(item); item.parentElement = this; } }
    insertBefore(item: Element, before: Element) { this.children.splice(this.children.indexOf(before), 0, item); item.parentElement = this; }
    setAttribute() {} focus() {} select() { this.selected = true; } remove() {}
  }
  const body = new Element(), actions = new Element(), button = new Element(), status = new Element();
  actions.append(button, status); body.append(actions);
  const context = createContext({ votes, Blob, Date, setTimeout: () => 0,
    URL: { createObjectURL() { throw Error('Downloads blocked'); } },
    navigator: { clipboard: { async writeText() { throw Error('Clipboard blocked'); } } },
    document: { body, createElement: () => new Element(), getElementById: (id: string) => id === 'export' ? button : status } });
  runInContext(absoluteExportBrowserScript(manifest), context);
  return { body, actions, button, status, panel: body.children[1], field: body.children[1].children[1] };
}

describe('local listening export fallback', () => {
  it('retains valid JSON and stable group IDs when downloads are blocked and no headings are available', () => {
    const ui = browser({ original: { rating: 'acceptable', defects: ['two-voices'], comment: '' }, new: { rating: 'bad', defects: ['energy'], comment: 'Музыка кончилась' } });
    ui.button.onclick!();
    expect(ui.panel.hidden).toBe(false);
    const result = JSON.parse(ui.field.value);
    expect(validateAbsoluteReviewExport(result, manifest)).toBe(true);
    expect(result.variantVotes.map((v: { groupId: number }) => v.groupId)).toEqual([204, 204]);
    expect(result.variantVotes[1].comment).toBe('Музыка кончилась');
    expect(ui.status.textContent).toContain('Скачивание недоступно');
  });
  it('offers manual copying when clipboard is denied and preserves missing votes as unrated', async () => {
    const ui = browser({ original: { rating: 'good', defects: ['energy', 'invalid', 'energy'], comment: '</script>' } });
    ui.actions.children[1].onclick!();
    expect(ui.field.selected).toBe(true);
    await ui.panel.children[2].onclick!();
    expect(ui.status.textContent).toContain('Ctrl+C');
    const result = JSON.parse(ui.field.value);
    expect(validateAbsoluteReviewExport(result, manifest)).toBe(true);
    expect(result.variantVotes[0].defects).toEqual(['energy']);
    expect(result.variantVotes[0].comment).toBe('</script>');
    expect(result.variantVotes[1].rating).toBe('unrated');
  });
});
