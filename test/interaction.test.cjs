const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createPatch } = require('diff');
const { renderHTML } = require('../dist/core.cjs');
const enabled = process.env.REVMAP_EDGE_BROWSER === '1';
const options = { skip: !enabled, timeout: 30000 };
const artifacts = path.resolve('.test-output');
let browser, url;
before(async () => {
  if (!enabled) return;
  const old = Array.from({ length: 85 }, (_, i) => `const value${i + 1} = ${i + 1};`).join('\n') + '\n';
  const text = old.replace('const value20 = 20;', `const value20 = "${'long source '.repeat(80)}";`);
  const file = (name, before, after, priority = 'normal') => ({ path: name, priority, comments: [], kind: 'text', status: after === null ? 'deleted' : before ? 'modified' : 'added',
    before: before ? { text: before, bytes: before.length, mode: '100644' } : null,
    after: after === null ? null : { text: after, bytes: after.length, mode: '100644' }, patch: createPatch('file', before, after || '') });
  const review = { repository: 'interaction-check', base: null, createdAt: '2026-01-01T00:00:00.000Z', files: [
    file('src/git.ts', old, text), file('src/web.ts', '', 'one\ntwo\nthree\n'), file('src/deep/' + 'long-directory/'.repeat(8) + 'file.ts', '', 'one\ntwo\n', 'low'),
    file('src/deleted.ts', 'one\ntwo\nthree\n', null)
  ] };
  fs.mkdirSync(artifacts, { recursive: true });
  const output = path.join(artifacts, 'interactions.html'); fs.writeFileSync(output, renderHTML(review)); url = pathToFileURL(output).href;
  const { chromium, webkit } = require('playwright');
  const engine = process.env.PLAYWRIGHT_ENGINE === 'webkit' ? webkit : chromium;
  browser = await engine.launch(engine === webkit || process.env.PLAYWRIGHT_CHANNEL === 'bundled' ? {} : { channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
});
after(async () => { if (browser) await browser.close(); });
async function pageFor(t, mobile = false) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, hasTouch: mobile, isMobile: mobile, colorScheme: 'dark' });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true }));
  await page.goto(url); await page.locator('#file-0 .code-row').first().waitFor();
  return page;
}

test('file disclosure is centered, borderless on hover, and usable through the filename and keyboard', options, async t => {
  const page = await pageFor(t);
  await page.locator('.skip-link').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'content');
  const toggle = page.locator('#file-0 .file-toggle');
  await toggle.hover(); await page.waitForTimeout(150);
  await page.locator('#file-0 .file-header').screenshot({ path: path.join(artifacts, 'disclosure-hover.png') });
  assert.ok(await toggle.evaluate(el => { const s = getComputedStyle(el); return s.borderWidth === '0px' || s.borderColor === 'rgba(0, 0, 0, 0)'; }), 'ghost disclosure must not acquire the global button border');
  assert.equal(await toggle.locator('svg').count(), 1, 'use a geometric chevron, not a baseline-dependent text glyph');
  const box = await toggle.boundingBox(), icon = await toggle.locator('svg').boundingBox();
  assert.ok(Math.abs(box.y + box.height / 2 - icon.y - icon.height / 2) < 1);
  await page.locator('#file-0 .file-title').click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  // macOS WebKit uses Option+Tab to include buttons, following the browser's keyboard-navigation preference.
  const webkit = process.env.PLAYWRIGHT_ENGINE === 'webkit';
  await page.keyboard.press(webkit ? 'Alt+Tab' : 'Tab'); await page.keyboard.press(webkit ? 'Alt+Shift+Tab' : 'Shift+Tab');
  assert.equal(await toggle.evaluate(el => el === document.activeElement && el.matches(':focus-visible')), true);
  await page.keyboard.press('Space');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await toggle.evaluate(el => el === document.activeElement), true);
  await page.locator('#file-0 .file-header').screenshot({ path: path.join(artifacts, 'disclosure-keyboard.png') });
});

test('responsive rerender preserves the focused draft and its selection', options, async t => {
  const page = await pageFor(t);
  await page.locator('#file-0 [data-action="file-comment"]').click();
  await page.locator('#comment-text').fill('Keep the caret and this unsaved comment.');
  await page.locator('#comment-text').evaluate(el => el.setSelectionRange(5, 14));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  assert.deepEqual(await page.locator('#comment-text').evaluate(el => [document.activeElement === el, el.selectionStart, el.selectionEnd]), [true, 5, 14]);
});

test('folding and Viewed preserve drafts; copy reveals a draft even from Preview', options, async t => {
  const page = await pageFor(t);
  await page.locator('#file-0 [data-action="file-comment"]').click();
  await page.locator('#comment-text').fill('Keep this draft when folding.');
  await page.locator('#file-0 .file-toggle').click();
  assert.equal(await page.locator('#file-0 .file-body').isVisible(), false, 'folding must not require discarding a draft');
  await page.locator('#file-0 .file-toggle').click();
  assert.equal(await page.locator('#comment-text').inputValue(), 'Keep this draft when folding.');
  await page.locator('[data-viewed="0"]').check();
  await page.locator('[data-action="export"]').click();
  assert.equal(await page.locator('#comment-text').inputValue(), 'Keep this draft when folding.');
  await page.locator('[data-action="preview-tab"]').click();
  await page.evaluate(() => scrollTo(0, 0));
  await page.locator('[data-action="export"]').click();
  assert.equal(await page.locator('#comment-text').isVisible(), true);
  assert.equal(await page.locator('#comment-text').evaluate(el => el === document.activeElement), true);
});

test('destructive controls confirm and saving/cancelling return keyboard focus to the relevant control', options, async t => {
  const page = await pageFor(t);
  await page.locator('#file-0 [data-action="file-comment"]').click();
  await page.locator('#comment-text').fill('Do not accidentally delete this.');
  let dialogs = 0;
  page.on('dialog', dialog => { dialogs++; void dialog.dismiss(); });
  await page.locator('[data-action="cancel-comment"]').click();
  assert.equal(dialogs, 1, 'cancelling a modified draft must ask');
  assert.equal(await page.locator('#comment-text').inputValue(), 'Do not accidentally delete this.');
  await page.locator('#composer button[type="submit"]').click();
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), 'reply');
  await page.locator('[data-action="delete-root"]').click();
  assert.equal(dialogs, 2, 'deleting a saved comment must ask, even without replies');
  assert.equal(await page.locator('#file-0 .thread').count(), 1);
  await page.locator('[data-action="edit-root"]').click();
  await page.locator('[data-action="cancel-comment"]').click();
  assert.equal(dialogs, 2, 'cancelling an unchanged edit should not ask');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), 'edit-root');
});

test('Shift selection keeps its original anchor without manual line fields; empty comments remain validated', options, async t => {
  const page = await pageFor(t);
  await page.locator('#file-0 [data-action="line"][data-side="new"][data-line="20"]').first().click();
  await page.locator('#file-0 [data-action="line"][data-side="new"][data-line="19"]').first().click({ modifiers: ['Shift'] });
  await page.locator('#file-0 [data-action="line"][data-side="new"][data-line="22"]').first().click({ modifiers: ['Shift'] });
  assert.equal(await page.locator('#comment-range').textContent(), 'new L20–L22');
  assert.equal(await page.locator('#composer input[type="number"]').count(), 0);
  assert.equal(await page.locator('#file-0 .line-number [data-side="new"].selected-line').count(), 3);
  await page.locator('#comment-text').press('Control+Enter');
  assert.equal(await page.locator('#comment-text').evaluate(el => document.activeElement === el && el.getAttribute('aria-invalid') === 'true'), true);
  assert.equal(await page.locator('#comment-text').evaluate(el => getComputedStyle(el).borderColor === getComputedStyle(document.getElementById('composer-error')).color), true);
  await page.locator('#comment-text').fill('Check the exact range.');
  assert.equal(await page.locator('#composer .error').count(), 0);
});

const lineControl = (page, file, side, line, plus = false) => page.locator(`#file-${file} ${plus ? '.line-plus' : '.line-number button'}[data-side="${side}"][data-line="${line}"]`);
async function point(locator) {
  const box = await locator.boundingBox();
  assert.ok(box, 'line must be rendered');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function beginDrag(page, file, side, line) {
  const start = lineControl(page, file, side, line, true);
  await start.hover();
  const p = await point(start);
  await page.mouse.move(p.x, p.y); await page.mouse.down();
}
async function dragTo(page, file, side, line) {
  const p = await point(lineControl(page, file, side, line));
  await page.mouse.move(p.x, p.y, { steps: 6 });
}

test('dragging plus previews a range without moving the DOM, then opens one focused composer and exports that range', options, async t => {
  const page = await pageFor(t);
  const end = await point(lineControl(page, 0, 'new', 22));
  await beginDrag(page, 0, 'new', 18);
  assert.equal(await page.locator('#composer').count(), 0);
  await dragTo(page, 0, 'new', 22);
  await page.mouse.move(end.x + 100, end.y); // Dropping over source text also selects that row.
  assert.equal(await page.locator('#file-0 .line-number [data-side="new"].selected-line').count(), 5);
  assert.deepEqual(await point(lineControl(page, 0, 'new', 22)), end, 'no editor insertion or reflow during the gesture');
  assert.equal(await page.evaluate(() => getSelection().toString()), '', 'drag must not select source text');
  await page.mouse.up();
  assert.equal(await page.locator('#composer').count(), 1);
  assert.equal(await page.locator('#comment-range').textContent(), 'new L18–L22');
  assert.equal(await page.locator('#comment-text').evaluate(el => el === document.activeElement), true);
  await page.locator('#comment-text').fill('Drag-selected feedback');
  await page.locator('#comment-text').press('Control+Enter');
  await page.locator('[data-action="export"]').click();
  assert.match(await page.locator('#markdown-output').inputValue(), /### new L18–L22\n/);
});

test('reverse drags preserve their origin and draft; Escape and pointer cancellation restore the previous selection', options, async t => {
  const page = await pageFor(t);
  await beginDrag(page, 0, 'new', 22); await dragTo(page, 0, 'new', 18); await page.mouse.up();
  assert.equal(await page.locator('#comment-range').textContent(), 'new L18–L22');
  await page.locator('#comment-text').fill('Keep this draft');
  await lineControl(page, 0, 'new', 23).click({ modifiers: ['Shift'] });
  assert.equal(await page.locator('#comment-range').textContent(), 'new L22–L23');
  for (const cancel of ['Escape', 'pointercancel']) {
    await beginDrag(page, 0, 'new', 18); await dragTo(page, 0, 'new', 19);
    if (cancel === 'Escape') await page.keyboard.press('Escape');
    else await lineControl(page, 0, 'new', 18, true).dispatchEvent('pointercancel', { pointerId: 1 });
    await page.mouse.up();
    assert.equal(await page.locator('#comment-range').textContent(), 'new L22–L23');
    assert.equal(await page.locator('#comment-text').inputValue(), 'Keep this draft');
    assert.equal(await page.locator('body.selecting-lines').count(), 0);
  }
  await beginDrag(page, 0, 'new', 18); await dragTo(page, 0, 'new', 19); await page.mouse.up();
  assert.equal(await page.locator('#comment-range').textContent(), 'new L18–L19');
  assert.equal(await page.locator('#comment-text').inputValue(), 'Keep this draft');
});

test('replacing another draft asks only after releasing the drag and declining preserves its text', options, async t => {
  const page = await pageFor(t);
  await page.locator('#file-0 [data-action="file-comment"]').click();
  await page.locator('#comment-text').fill('Do not discard this draft');
  await page.locator('#file-nav [data-file="1"]').click();
  let prompts = 0;
  page.on('dialog', dialog => { prompts++; void dialog.dismiss(); });
  await beginDrag(page, 1, 'new', 1); await dragTo(page, 1, 'new', 3);
  assert.equal(prompts, 0);
  await page.mouse.up();
  assert.equal(prompts, 1);
  assert.equal(await page.locator('#file-0 #comment-text').inputValue(), 'Do not discard this draft');
  assert.equal(await page.locator('#file-1 #composer').count(), 0);
  assert.equal(await page.locator('#file-1 .selected-line').count(), 0);
});

test('split drags stay on one side and in one file; deleted files select old lines', options, async t => {
  const page = await pageFor(t);
  await page.locator('[data-layout="split"]').click();
  await beginDrag(page, 0, 'old', 17);
  const opposite = await point(lineControl(page, 0, 'new', 17));
  await page.mouse.move(opposite.x, opposite.y);
  await dragTo(page, 0, 'new', 19);
  assert.equal(await page.locator('#file-0 .line-number [data-side="old"].selected-line').count(), 1, 'crossing sides must not reinterpret coordinates');
  await dragTo(page, 0, 'old', 19); await page.mouse.up();
  assert.equal(await page.locator('#comment-range').textContent(), 'old L17–L19');
  await page.locator('[data-action="cancel-comment"]').click();
  await page.locator('#file-nav [data-file="3"]').click();
  await beginDrag(page, 3, 'old', 3); await dragTo(page, 3, 'old', 1); await page.mouse.up();
  assert.equal(await page.locator('#comment-range').textContent(), 'old L1–L3');
  await page.locator('[data-action="cancel-comment"]').click();
  await beginDrag(page, 3, 'old', 2);
  await page.locator('#file-0').scrollIntoViewIfNeeded();
  await dragTo(page, 0, 'old', 19); await page.mouse.up();
  assert.equal(await page.locator('#comment-range').textContent(), 'old L2', 'releasing over another file keeps the last valid endpoint');
});

test('touch and keyboard users can select an endpoint without dragging or typing line numbers', options, async t => {
  const page = await pageFor(t, true);
  await lineControl(page, 0, 'new', 20, true).tap();
  await page.locator('#comment-text').fill('Touch selection');
  await page.locator('[data-action="select-end"]').tap();
  await lineControl(page, 0, 'old', 19).tap();
  assert.equal(await page.locator('[data-action="select-end"]').getAttribute('aria-pressed'), 'true');
  await lineControl(page, 0, 'new', 22).tap();
  assert.equal(await page.locator('#comment-range').textContent(), 'new L20–L22');
  assert.equal(await page.locator('#comment-text').inputValue(), 'Touch selection');
  await page.locator('[data-action="select-end"]').focus(); await page.keyboard.press('Enter');
  await lineControl(page, 0, 'new', 23).focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#comment-range').textContent(), 'new L20–L23');
});

test('dragging at the viewport edge scrolls and keeps extending until release', options, async t => {
  const page = await pageFor(t);
  await page.locator('#file-0 [data-action="expand-context"][data-start="25"][data-amount="all"]').click();
  await page.evaluate(() => scrollTo(0, 0));
  await beginDrag(page, 0, 'new', 21);
  const x = (await point(lineControl(page, 0, 'new', 21))).x;
  await page.mouse.move(x, 992, { steps: 8 });
  await page.waitForFunction(() => scrollY > 150);
  await page.mouse.up();
  const label = await page.locator('#comment-range').textContent();
  assert.match(label, /^new L21–L\d+$/);
  assert.ok(Number(label.split('–L')[1]) > 30);
  assert.equal(await page.locator('body.selecting-lines').count(), 0);
});

test('a real touch drag on plus selects lines instead of scrolling the page', { ...options, skip: !enabled || process.env.PLAYWRIGHT_ENGINE === 'webkit' }, async t => {
  const page = await pageFor(t, true);
  const start = await point(lineControl(page, 0, 'new', 18, true));
  const end = await point(lineControl(page, 0, 'new', 22));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [end] });
  assert.equal(await page.locator('#composer').count(), 0);
  assert.equal(await page.locator('#file-0 .line-number [data-side="new"].selected-line').count(), 5);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal(await page.locator('#comment-range').textContent(), 'new L18–L22');
});

test('horizontal inspection survives rerenders and comment editors remain within the viewport', options, async t => {
  const page = await pageFor(t);
  await page.locator('#file-0 .diff-scroll').evaluate(el => el.scrollLeft = 300);
  await page.locator('#file-0 [data-action="file-comment"]').click();
  assert.equal(await page.locator('#file-0 .diff-scroll').evaluate(el => el.scrollLeft), 300);
  await page.locator('[data-action="cancel-comment"]').click();
  await page.locator('#file-0 .diff-scroll').evaluate(el => el.scrollLeft = 0);
  await page.locator('#file-0 [data-action="line"][data-side="new"][data-line="20"]').first().click();
  await page.locator('#file-0 .diff-scroll').evaluate(el => el.scrollLeft = 500);
  const bounds = await page.locator('#composer').boundingBox();
  const viewport = await page.locator('#file-0 .diff-scroll').boundingBox();
  assert.ok(bounds.x >= viewport.x && bounds.x + bounds.width <= viewport.x + viewport.width, 'horizontal scrolling must not clip the inline editor');
  await page.locator('#file-0').screenshot({ path: path.join(artifacts, 'horizontal-comment.png') });
});

test('inline reply editor and actions fit inside the visible diff at every scroll position', options, async t => {
  const page = await pageFor(t);
  await page.locator('#file-0 [data-action="line"][data-side="new"][data-line="20"]').first().click();
  await page.locator('#comment-text').fill('Check this line.');
  await page.locator('#composer button[type="submit"]').click();
  await page.locator('#thread-u-1 [data-action="reply"]').click();
  const bounds = async () => page.evaluate(() => {
    const viewport = document.querySelector('#file-0 .diff-scroll').getBoundingClientRect();
    const thread = document.querySelector('#thread-u-1').getBoundingClientRect();
    return ['#comment-text', '#composer button[type="submit"]'].map(selector => {
      const box = document.querySelector(selector).getBoundingClientRect();
      return { selector, right: box.right, edge: Math.min(viewport.right, thread.right) };
    });
  });
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const scrollLeft of [0, 500]) {
      await page.locator('#file-0 .diff-scroll').evaluate((el, left) => { el.scrollLeft = left; }, scrollLeft);
      for (const box of await bounds()) assert.ok(box.right <= box.edge - 1, `${box.selector} clipped at width=${width} scrollLeft=${scrollLeft}: ${JSON.stringify(box)}`);
    }
  }
});

test('marking the current file viewed under Unviewed moves focus to the next visible file', options, async t => {
  const page = await pageFor(t);
  await page.locator('[data-filter="unviewed"]').click();
  await page.locator('[data-viewed="0"]').check();
  assert.equal(await page.locator('#file-0').isVisible(), false);
  assert.equal(await page.evaluate(() => document.activeElement?.closest('.file-card')?.id), 'file-1');
});

test('mobile navigation works with touch and Escape restores keyboard focus', options, async t => {
  const page = await pageFor(t, true);
  const nav = page.locator('[data-action="nav"]');
  await nav.tap();
  await page.locator('#file-nav [data-file="2"]').tap();
  const toggle = page.locator('#file-2 .file-toggle');
  const bounds = await toggle.boundingBox();
  assert.ok(bounds.height >= 44 && bounds.width >= 44, 'touch disclosure target must be usable');
  await page.locator('#file-2 .file-header').screenshot({ path: path.join(artifacts, 'mobile-header.png') });
  await nav.focus(); await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'search');
  await page.keyboard.press('Escape');
  assert.equal(await nav.evaluate(el => document.activeElement === el), true);
});

async function warnsOnLeave(page) {
  return page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}
async function copyFeedback(page) {
  await page.locator('[data-action="export"]').click();
  await page.waitForFunction(() => document.getElementById('copy-status').textContent === 'Copied to clipboard.');
  await page.locator('[data-action="close-export"]').click();
}

async function reloadReview(page) {
  await page.reload();
  await page.locator('#boot-error').waitFor({ state: 'hidden' });
}
const storageKey = page => page.locator('meta[name="revmap-storage-key"]').getAttribute('content');

test('feedback, edits, replies, deletions and Viewed survive refresh without requiring a copy', options, async t => {
  const page = await pageFor(t);
  assert.equal(await warnsOnLeave(page), false);
  await page.locator('#theme').selectOption('light');
  await page.locator('[data-layout="split"]').click();
  assert.equal(await page.evaluate(() => localStorage.length), 0, 'presentation does not write feedback');
  await page.locator('[data-viewed="1"]').check();
  await page.locator('#file-0 [data-action="file-comment"]').click();
  await page.locator('#comment-text').fill('Saved feedback');
  await page.locator('#composer button[type="submit"]').click();
  await page.locator('#thread-u-1 [data-action="reply"]').click();
  await page.locator('#comment-text').fill('A reply');
  await page.locator('#composer button[type="submit"]').click();
  assert.equal(await warnsOnLeave(page), false);
  await reloadReview(page);
  assert.equal(await page.locator('[data-viewed="1"]').isChecked(), true);
  assert.match(await page.locator('#thread-u-1').textContent(), /Saved feedback.*A reply/s);
  assert.equal(await warnsOnLeave(page), false);
  await page.locator('#thread-u-1 [data-action="edit-root"]').click();
  await page.locator('#comment-text').fill('Edited feedback');
  await page.locator('#composer button[type="submit"]').click();
  await page.locator('#thread-u-1 [data-action="edit-reply"]').click();
  await page.locator('#comment-text').fill('Edited reply');
  await page.locator('#composer button[type="submit"]').click();
  await reloadReview(page);
  assert.match(await page.locator('#thread-u-1').textContent(), /Edited feedback.*Edited reply/s);
  await page.locator('#file-0 [data-action="file-comment"]').click();
  await page.locator('#comment-text').fill('Another comment');
  await page.locator('#composer button[type="submit"]').click();
  assert.equal(await page.locator('#thread-u-3').count(), 1, 'restoring must not reuse thread or reply IDs');
  await page.locator('[data-action="export"]').click();
  const output = await page.locator('#markdown-output').inputValue();
  assert.match(output, /Edited feedback/); assert.match(output, /Edited reply/); assert.match(output, /Another comment/);
  await page.locator('[data-action="close-export"]').click();
  for (const action of ['delete-reply', 'delete-root']) {
    page.once('dialog', dialog => dialog.accept());
    await page.locator(`#thread-u-1 [data-action="${action}"]`).click();
    assert.equal(await warnsOnLeave(page), false);
    await reloadReview(page);
    assert.equal(await page.locator(action === 'delete-reply' ? '#thread-u-1 .reply' : '#thread-u-1').count(), 0);
  }
});

test('failed or pending copies do not affect persistence or the leave guard', options, async t => {
  const page = await pageFor(t);
  await page.locator('[data-viewed="0"]').check();
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
  await page.locator('[data-action="export"]').click();
  await page.waitForFunction(() => document.getElementById('copy-status').textContent.includes('Automatic copy is unavailable'));
  assert.equal(await warnsOnLeave(page), false);
  await page.locator('[data-action="close-export"]').click();
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: () => new Promise(resolve => { window.finishCopy = resolve; })
  } }));
  await page.locator('[data-action="export"]').click();
  assert.equal(await warnsOnLeave(page), false);
  await page.locator('[data-action="close-export"]').click();
  await page.locator('[data-viewed="1"]').check();
  await page.evaluate(() => window.finishCopy());
  assert.equal(await warnsOnLeave(page), false);
  await reloadReview(page);
  assert.equal(await page.locator('[data-viewed="0"]').isChecked(), true);
  assert.equal(await page.locator('[data-viewed="1"]').isChecked(), true);
});

test('only a complete trusted manual export copy reports clipboard success', options, async t => {
  const page = await pageFor(t);
  // Capture the native-copy observer so the test never writes to the OS clipboard.
  await page.addInitScript(() => {
    const add = document.addEventListener.bind(document);
    document.addEventListener = (type, listener, options) => {
      if (type === 'copy') window.reviewCopy = listener;
      return add(type, listener, options);
    };
  });
  await page.reload();
  await page.locator('[data-viewed="0"]').check();
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
  await page.locator('[data-action="export"]').click();
  await page.waitForFunction(() => document.getElementById('copy-status').textContent.includes('Automatic copy is unavailable'));
  await page.locator('#markdown-output').evaluate(el => { el.focus(); el.setSelectionRange(0, 10); });
  await page.evaluate(() => window.reviewCopy({ isTrusted: true, defaultPrevented: false }));
  assert.match(await page.locator('#copy-status').textContent(), /Automatic copy is unavailable/);
  await page.locator('[data-action="select-output"]').click();
  await page.evaluate(() => document.dispatchEvent(new ClipboardEvent('copy', { bubbles: true })));
  assert.match(await page.locator('#copy-status').textContent(), /Automatic copy is unavailable/);
  await page.evaluate(() => window.reviewCopy({ isTrusted: true, defaultPrevented: true }));
  assert.match(await page.locator('#copy-status').textContent(), /Automatic copy is unavailable/);
  await page.evaluate(() => window.reviewCopy({ isTrusted: true, defaultPrevented: false }));
  assert.equal(await warnsOnLeave(page), false);
  assert.equal(await page.locator('#copy-status').textContent(), 'Copied to clipboard.');
});

test('closing a persisted draft needs no confirmation and reopening the same HTML restores it', options, async t => {
  const page = await pageFor(t), context = page.context();
  await page.locator('#file-0 [data-action="file-comment"]').click();
  await page.locator('#comment-text').fill('Keep this draft after closing');
  let dialogs = 0;
  page.on('dialog', dialog => { dialogs++; void dialog.accept(); });
  await Promise.all([page.waitForEvent('close'), page.close({ runBeforeUnload: true })]);
  assert.equal(dialogs, 0);
  const reopened = await context.newPage();
  await reopened.goto(url);
  await reopened.locator('#comment-text').waitFor();
  assert.equal(await reopened.locator('#comment-text').inputValue(), 'Keep this draft after closing');
  assert.equal(await warnsOnLeave(reopened), false);
});

test('range drafts and root/reply edits restore their targets and original text, while cancellation removes the draft', options, async t => {
  const page = await pageFor(t);
  await lineControl(page, 0, 'new', 22).click();
  await lineControl(page, 0, 'new', 18).click({ modifiers: ['Shift'] });
  await page.locator('#comment-text').fill('Range draft');
  await page.locator('[data-action="select-end"]').click();
  await lineControl(page, 0, 'new', 19).click();
  await page.locator('[data-action="preview-tab"]').click();
  await reloadReview(page);
  assert.equal(await page.locator('#comment-text').inputValue(), 'Range draft');
  assert.equal(await page.locator('#comment-range').textContent(), 'new L19–L22');
  assert.equal(await page.locator('#comment-text').isVisible(), true);
  await lineControl(page, 0, 'new', 23).click({ modifiers: ['Shift'] });
  assert.equal(await page.locator('#comment-range').textContent(), 'new L22–L23', 'restore the original range origin');
  await page.locator('#comment-text').press('Control+Enter');
  await page.locator('#thread-u-1 [data-action="edit-root"]').click();
  await page.locator('#comment-text').fill('Changed root draft');
  await reloadReview(page);
  assert.equal(await page.locator('#composer button[type="submit"]').textContent(), 'Save changes');
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('[data-action="cancel-comment"]').click();
  assert.equal(await page.locator('#comment-text').inputValue(), 'Changed root draft', 'restoring must not turn a changed edit into an unchanged edit');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('[data-action="cancel-comment"]').click();
  await reloadReview(page);
  assert.equal(await page.locator('#composer').count(), 0);
  assert.match(await page.locator('#thread-u-1').textContent(), /Range draft/);
  await page.locator('#thread-u-1 [data-action="reply"]').click();
  await page.locator('#comment-text').fill('Reply draft');
  await reloadReview(page);
  assert.equal(await page.locator('#composer button[type="submit"]').textContent(), 'Add reply');
  await page.locator('#composer button[type="submit"]').click();
  await page.locator('#thread-u-1 [data-action="edit-reply"]').click();
  await page.locator('#comment-text').fill('Changed reply');
  await reloadReview(page);
  assert.equal(await page.locator('#comment-text').inputValue(), 'Changed reply');
  await page.locator('#composer button[type="submit"]').click();
  await reloadReview(page);
  assert.equal(await page.locator('#composer').count(), 0);
  assert.match(await page.locator('#thread-u-1 .reply').textContent(), /Changed reply/);
});

test('storage failures retain the leave confirmation; copying does not hide the failure and retry restores saving', options, async t => {
  for (const name of ['QuotaExceededError', 'SecurityError']) {
    const page = await pageFor(t);
    await page.evaluate(name => {
      window.nativeSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = () => { throw new DOMException('Storage unavailable', name); };
    }, name);
    await page.locator('[data-viewed="0"]').check();
    assert.equal(await page.locator('#storage-warning').isVisible(), true);
    assert.equal(await warnsOnLeave(page), true);
    await page.locator('[data-viewed="0"]').uncheck();
    assert.equal(await warnsOnLeave(page), false, 'reverting to the original snapshot does not risk data loss');
    await page.locator('#file-0 [data-action="file-comment"]').click();
    assert.equal(await warnsOnLeave(page), false, 'an empty editor is not unsaved feedback');
    await page.locator('#comment-text').fill('Protect this unsaved draft');
    const warning = page.waitForEvent('dialog');
    await page.close({ runBeforeUnload: true });
    const dialog = await warning;
    assert.equal(dialog.type(), 'beforeunload');
    await dialog.dismiss();
    assert.equal(await page.locator('#comment-text').inputValue(), 'Protect this unsaved draft');
    await page.locator('#composer button[type="submit"]').click();
    await copyFeedback(page);
    assert.equal(await warnsOnLeave(page), true, 'clipboard success is not persistence success');
    await page.evaluate(() => { Storage.prototype.setItem = window.nativeSetItem; });
    await page.locator('[data-action="retry-save"]').click();
    assert.equal(await page.locator('#storage-warning').isVisible(), false);
    assert.equal(await warnsOnLeave(page), false);
    await reloadReview(page);
    assert.match(await page.locator('#thread-u-1').textContent(), /Protect this unsaved draft/);
  }
});

test('unavailable storage on startup does not prevent reviewing or silently enable overwriting an unread cache', options, async t => {
  const page = await pageFor(t);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Denied', 'SecurityError'); } }));
  await reloadReview(page);
  assert.equal(await page.locator('#storage-warning').isVisible(), true);
  assert.equal(await warnsOnLeave(page), false);
  await page.locator('#file-0 [data-action="file-comment"]').click();
  await page.locator('#comment-text').fill('Still editable without storage');
  assert.equal(await warnsOnLeave(page), true);
  assert.deepEqual(errors, []);
});

test('malformed and unsafe caches are rejected without crashing or overwriting their contents', options, async t => {
  const page = await pageFor(t), key = await storageKey(page);
  const saved = { version: 1, sequence: 2, editor: null, feedback: Array.from({ length: 4 }, () => ({ viewed: false, threads: [] })) };
  saved.feedback[0].threads.push({ id: 'u-1', author: 'You', text: 'Cached comment', replies: [{ id: 'u-2', text: 'Cached reply' }] });
  const variants = ['{', 'null'];
  for (const corrupt of [
    value => { value.version = 2; },
    value => { value.feedback.pop(); },
    value => { value.sequence = 0; },
    value => { value.feedback[0].viewed = 'true'; },
    value => { value.feedback[0].threads[0].id = 'u-1" onclick="window.pwned=true'; },
    value => { value.feedback[0].threads[0].author = '<img src=x onerror=window.pwned=true>'; },
    value => { value.feedback[0].threads[0].replies[0].id = 'u-1'; },
    value => { Object.assign(value.feedback[0].threads[0], { line: 1, endLine: 1000, side: 'new' }); },
    value => { Object.assign(value.feedback[0].threads[0], { line: 20, endLine: 19, side: 'new' }); },
    value => { value.editor = { file: 10, text: 'Draft', initialText: '' }; },
    value => { value.editor = { file: 0, text: 'Draft', initialText: '', thread: 'missing' }; },
    value => { value.editor = { file: 0, text: 'Draft', initialText: '', thread: 'u-1', reply: 'missing' }; },
  ]) {
    const value = structuredClone(saved); corrupt(value); variants.push(JSON.stringify(value));
  }
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  for (const raw of variants) {
    await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key, raw });
    await reloadReview(page);
    assert.equal(await page.locator('#storage-warning').isVisible(), true);
    assert.equal(await page.locator('#file-0 .thread').count(), 0);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), raw, 'startup must not overwrite a damaged cache');
  }
  await page.locator('#file-0 [data-action="file-comment"]').click();
  await page.locator('#comment-text').fill('New draft while restore failed');
  assert.equal(await page.evaluate(key => localStorage.getItem(key), key), variants.at(-1), 'changes must not silently replace an unread cache');
  assert.equal(await warnsOnLeave(page), true);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  assert.deepEqual(errors, []);
});

test('changing a snapshot at the same file URL isolates feedback even with identical timestamps and paths', options, async t => {
  const page = await pageFor(t);
  const review = await page.evaluate(() => JSON.parse(document.getElementById('review-data').textContent));
  const output = path.join(artifacts, 'storage-isolation.html'), isolated = pathToFileURL(output).href;
  const original = renderHTML(review); fs.writeFileSync(output, original);
  await page.goto(isolated); await page.locator('#boot-error').waitFor({ state: 'hidden' });
  const firstKey = await storageKey(page);
  await page.locator('[data-viewed="0"]').check();
  review.files[1].after.text = 'changed\n'; review.files[1].patch = createPatch('file', '', 'changed\n');
  fs.writeFileSync(output, renderHTML(review));
  await reloadReview(page);
  assert.notEqual(await storageKey(page), firstKey);
  assert.equal(await page.locator('[data-viewed="0"]').isChecked(), false);
  assert.ok(await page.evaluate(key => localStorage.getItem(key), firstKey), 'other snapshots are not cleaned up');
  fs.writeFileSync(output, original);
  await reloadReview(page);
  assert.equal(await page.locator('[data-viewed="0"]').isChecked(), true);
});

test('clipboard waiting is visible and prevents duplicate requests without blocking manual copy or closing', options, async t => {
  const page = await pageFor(t);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: () => new Promise(resolve => { window.finishCopy = resolve; })
  } }));
  await page.locator('[data-action="export"]').click();
  assert.equal(await page.locator('#copy-status').textContent(), 'Copying…');
  assert.equal(await page.locator('[data-action="copy-output"]').isDisabled(), true);
  assert.equal(await page.locator('[data-action="select-output"]').isEnabled(), true);
  await page.locator('[data-action="close-export"]').click();
  await page.locator('#file-0 [data-action="file-comment"]').click();
  await page.evaluate(() => window.finishCopy());
  assert.equal(await page.locator('#comment-text').evaluate(el => el === document.activeElement), true);
});
