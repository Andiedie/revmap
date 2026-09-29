const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createPatch } = require('diff');
const { exportMarkdown, initialFeedback, renderHTML } = require('../dist/core.cjs');

function file(name, text = 'one\ntwo\n') {
  return { path: name, priority: 'normal', comments: [], status: 'added', kind: 'text', before: null,
    after: { mode: '100644', bytes: Buffer.byteLength(text), text }, patch: createPatch('file', '', text) };
}
function review(files) {
  return { repository: 'edge-test', base: null, createdAt: '2026-01-01T00:00:00.000Z', files };
}

test('exporting a large valid line with many backtick runs does not overflow the call stack', () => {
  const snapshot = review([file('code.txt', '`x'.repeat(150000) + '\n')]);
  const feedback = initialFeedback(snapshot);
  feedback[0].threads.push({ id: 'u-1', author: 'You', text: 'Please revise this line.', line: 1, side: 'new', replies: [] });
  assert.doesNotThrow(() => exportMarkdown(snapshot, feedback));
  assert.match(exportMarkdown(snapshot, feedback), /Please revise this line\./);
});

test('export keeps literal control, space, and JSON-looking paths distinguishable', () => {
  const names = ['line\nbreak.txt', 'line\rbreak.txt', 'line break.txt', JSON.stringify('line\nbreak.txt')];
  const snapshot = review(names.map(name => file(name)));
  const output = exportMarkdown(snapshot, initialFeedback(snapshot));
  const entries = output.split('\n').filter(line => line.startsWith('- [ ]'));
  assert.equal(entries.length, names.length);
  assert.equal(new Set(entries).size, names.length, 'different Git paths must not export as the same path');
});

// Opt-in like test/browser.cjs: REVMAP_EDGE_BROWSER=1 node --test test/edge.test.cjs.
const browserOptions = { skip: process.env.REVMAP_EDGE_BROWSER !== '1', timeout: 30000 };
async function pageFor(t) {
  const { chromium } = require('playwright');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'revmap-edge-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'review.html');
  fs.writeFileSync(output, renderHTML(review([file('first.txt'), file('second.txt')])));
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL === 'bundled' ? {} : { channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { writeText: async text => { window.edgeClipboard = text; } },
  }));
  await page.goto(pathToFileURL(output).href);
  await page.locator('#boot-error').waitFor({ state: 'hidden' });
  await page.locator('#file-0 .code-row').first().waitFor();
  return page;
}

test('export makes a filtered-out unfinished draft reachable instead of silently blocking', browserOptions, async t => {
  const page = await pageFor(t);
  await page.locator('#file-0 [data-action="file-comment"]').click();
  await page.locator('#comment-text').fill('Unfinished human feedback');
  await page.locator('#search').fill('second.txt');
  assert.equal(await page.locator('#file-0').isVisible(), false);
  await page.locator('[data-action="export"]').click();
  assert.equal(await page.locator('#composer .error').isVisible(), true, 'copy must reveal the draft that blocks export');
  assert.equal(await page.locator('#comment-text').inputValue(), 'Unfinished human feedback');
});

test('keyboard submit keeps the exact selected range without manual line fields', browserOptions, async t => {
  const page = await pageFor(t);
  await page.locator('#file-0 [data-action="line"][data-side="new"][data-line="1"]').first().click();
  await page.locator('[data-action="select-end"]').click();
  await page.locator('#file-0 .line-number [data-side="new"][data-line="2"]').click();
  assert.equal(await page.locator('#composer input[type="number"]').count(), 0);
  await page.locator('#comment-text').fill('Review this exact range');
  await page.locator('#comment-text').press('Control+Enter');
  assert.equal(await page.locator('#file-0 .thread-anchor').textContent(), 'new L1–L2');
  await page.locator('[data-action="export"]').click();
  assert.match(await page.locator('#markdown-output').inputValue(), /### new L1–L2\n/);
});
