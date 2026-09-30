const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPatch } = require('diff');
const { diffRows, revealRows, initialFeedback, exportMarkdown, renderHTML } = require('../dist/core.cjs');

const before = 'first\nsecond\nthird\n', after = 'first\nnew second\nthird\n';
const file = { path: 'src/`danger`.ts', priority: 'high', comments: [{ text: 'Agent context' }, { text: 'untouched Agent note', line: 3 }], status: 'modified', kind: 'text', before: { text: before, mode: '100644', bytes: before.length }, after: { text: after, mode: '100644', bytes: after.length }, patch: createPatch('file', before, after, '', '', { context: 0 }) };
const review = { repository: 'demo', base: 'abc123', createdAt: '2026-01-01T00:00:00.000Z', files: [file] };

test('diff rows use blob line numbers; context is disclosed without losing coordinates', () => {
  assert.deepEqual(diffRows(file), [
    { kind: 'gap', old: 1, new: 1, count: 1 },
    { kind: 'remove', old: 2, text: 'second' },
    { kind: 'add', new: 2, text: 'new second' },
    { kind: 'gap', old: 3, new: 3, count: 1 }
  ]);
  const expanded = revealRows(diffRows(file), file, [{ side: 'old', start: 1, end: 3 }]);
  assert.equal(expanded[0].text, 'first');
  assert.equal(expanded[3].new, 3);
  const added = { ...file, before: null, after: { ...file.after, text: 'new\n' }, patch: createPatch('file', '', 'new\n') };
  assert.deepEqual(diffRows(added), [{ kind: 'add', new: 1, text: 'new' }]);
});

test('export contains final Viewed state, human feedback, parent context, side and safe code fences', () => {
  const feedback = initialFeedback(review);
  feedback[0].viewed = true;
  feedback[0].threads[0].replies.push({ id: 'reply', text: 'Please simplify.' });
  feedback[0].threads.push({ id: 'human', author: 'You', text: 'Keep this behavior.', line: 2, side: 'old', replies: [] });
  const output = exportMarkdown(review, feedback);
  assert.match(output, /- \[x\] `` src\/`danger`\.ts ``/);
  assert.match(output, /> Agent context/);
  assert.match(output, /\*\*User — reply:\*\*\n\nPlease simplify\./);
  assert.match(output, /\*\*User:\*\*\n\nKeep this behavior\./);
  assert.doesNotMatch(output, /\bYou\b/);
  assert.match(output, /### old L2/);
  assert.match(output, /```\nsecond\n```/);
  assert.doesNotMatch(output, /untouched Agent note/);
  feedback[0].viewed = false;
  feedback[0].threads.pop();
  assert.match(exportMarkdown(review, feedback), /- \[ \]/);
  assert.doesNotMatch(exportMarkdown(review, feedback), /Keep this behavior/);
});

test('export includes review and group feedback, preserves grouped checklists, and omits untouched Agent explanations', () => {
  const grouped = { ...review, comments: [{ text: 'Overall scope' }], groups: [{ title: 'Behavior `and` safety', comments: [{ text: 'Group context' }], files: [0] }] };
  const feedback = initialFeedback(grouped);
  const reviewThreads = [{ id: 'a-review-0', author: 'Agent', text: 'Overall scope', replies: [{ id: 'u-1', text: 'Review-wide feedback' }] }];
  const groups = [[{ id: 'a-group-0-0', author: 'Agent', text: 'Group context', replies: [] }, { id: 'u-2', author: 'You', text: 'Group-wide feedback', replies: [] }]];
  const output = exportMarkdown(grouped, feedback, { review: reviewThreads, groups });
  assert.match(output, /Overall scope/); assert.match(output, /Review-wide feedback/);
  assert.match(output, /Behavior.*and.*safety/); assert.match(output, /\*\*User:\*\*\n\nGroup-wide feedback/);
  assert.match(output, /\*\*User — reply:\*\*\n\nReview-wide feedback/);
  assert.doesNotMatch(output, /\bYou\b/);
  assert.doesNotMatch(output, /Group context|untouched Agent note/);
  assert.match(output, /- \[ \] `` src\/`danger`\.ts ``/);
});

test('HTML is self-contained and data cannot terminate its script element', () => {
  const hostile = JSON.parse(JSON.stringify(review));
  hostile.files[0].comments[0].text = '</script><script>globalThis.pwned=true</script>';
  const html = renderHTML(hostile);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('Content-Security-Policy'));
  assert.ok(!html.includes('<script>globalThis.pwned=true</script>'));
  assert.ok(!/<script[^>]+src=/.test(html));
  const match = html.match(/<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/);
  assert.equal(JSON.parse(match[1]).files[0].comments[0].text, hostile.files[0].comments[0].text);
});
