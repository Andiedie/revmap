import MarkdownIt from 'markdown-it';
import { lines, Note, Review, Side } from './model';
import { CodeRow, diffRows, exportMarkdown, Feedback, initialFeedback, location, Range, revealRows, Row, Thread } from './view';

const review: Review = JSON.parse(document.getElementById('review-data')!.textContent!);
const suffixCounts = new Map<string, number>();
for (const file of review.files) {
  let suffix = '';
  for (const part of file.path.split('/').reverse()) {
    suffix = suffix ? `${part}/${suffix}` : part;
    suffixCounts.set(suffix, (suffixCounts.get(suffix) || 0) + 1);
  }
}
const fileLabels = review.files.map(file => {
  const parts = file.path.split('/'), name = parts.pop()!;
  if (suffixCounts.get(name) === 1) return { name, directory: '' };
  let depth = 1;
  while (depth < parts.length && suffixCounts.get(`${parts.slice(-depth).join('/')}/${name}`)! > 1) depth++;
  return { name, directory: parts.slice(-depth).join('/') || '.' };
});
const md = new MarkdownIt({ html: false, linkify: false, breaks: true }).disable('image');
const escape = (text: unknown) => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const markdown = (text: string) => md.render(text).replace(/<a /g, '<a target="_blank" rel="noreferrer noopener" ');
const icon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5v14M7 8h7a3 3 0 0 1 3 3v8"/><circle cx="7" cy="5" r="2"/><circle cx="7" cy="19" r="2"/><circle cx="17" cy="19" r="2"/></svg>';
interface FileState extends Feedback { open: boolean; loaded: boolean; budget: number; ranges: Range[]; rows?: Row[] }
const states: FileState[] = initialFeedback(review).map((feedback, i) => ({ ...feedback, open: review.files[i].priority !== 'low', loaded: false, budget: 600, ranges: [] }));
interface Editor { file: number; text: string; initialText?: string; originLine?: number; anchor?: Note; thread?: string; reply?: string; editRoot?: boolean; preview?: boolean; error?: string; invalid?: 'text'; selectingEnd?: boolean }
interface SavedFeedback { version: 1; feedback: Feedback[]; editor: Pick<Editor, 'file' | 'text' | 'initialText' | 'originLine' | 'anchor' | 'thread' | 'reply' | 'editRoot'> | null; sequence: number }
interface Drag { pointer: number; target: HTMLElement; file: number; side: Side; first: number; last: number; x: number; y: number; moved: boolean }
let drag: Drag | null = null, dragFrame = 0, ignorePointerClick = false;
let editor: Editor | null = null, sequence = 0, copyAttempt = 0, layout = 'unified', filter = '', query = '', navOpen = false;
const mobile = matchMedia('(max-width: 760px)');
const dark = matchMedia('(prefers-color-scheme: dark)');
let theme = 'system';
const app = document.getElementById('app')!;
const storageKey = document.querySelector<HTMLMetaElement>('meta[name="revmap-storage-key"]')!.content;
let savedFeedback = feedbackString(), restoreFailed = false;

function button(action: string, text: string, attributes = '', classes = ''): string {
  return `<button type="button" class="${classes}" data-action="${action}" ${attributes}>${text}</button>`;
}
function attr(i: number): string { return `data-file="${i}"`; }
function stats(i: number): { added: number; removed: number } {
  const rows = states[i].rows ||= diffRows(review.files[i]);
  return { added: rows.filter(row => row.kind === 'add').length, removed: rows.filter(row => row.kind === 'remove').length };
}
function isLarge(i: number): boolean { const s = stats(i); return s.added + s.removed > 2000; }
function humanCount(i: number): number { return states[i].threads.reduce((n, t) => n + (t.author === 'You' ? 1 : 0) + t.replies.length, 0); }
function visible(i: number): boolean {
  return `${review.files[i].path} ${review.files[i].oldPath || ''}`.toLowerCase().includes(query) && (!filter || (filter === 'unviewed' ? !states[i].viewed : humanCount(i) > 0));
}

app.innerHTML = `
  <a class="skip-link" href="#content">Skip to review files</a>
  <header class="topbar"><a class="brand" href="#">${icon}<span>revmap</span></a><span class="repo-name">${escape(review.repository)}</span><span class="local-badge">Local snapshot</span>
    <label class="theme-control"><span class="sr-only">Theme</span><select id="theme"><option value="system">System theme</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
  </header>
  <div class="review-heading"><div><div class="eyebrow">REVIEW MAP</div><h1>Review changes <span class="count">${review.files.length}</span></h1><p class="snapshot"><code>${review.base ? escape(review.base.slice(0, 8)) : 'empty'}</code><span>→</span>Working tree<span class="snapshot-time">· ${escape(new Date(review.createdAt).toLocaleString())}</span></p><div id="storage-warning" class="error" role="alert" hidden><span></span> ${button('retry-save', 'Retry save')}</div></div>
    <div class="heading-actions">${button('nav', 'Files', 'aria-expanded="false" aria-controls="sidebar"', 'mobile-nav')}${button('export', 'Copy review <span aria-hidden="true">↗</span>', '', 'primary copy-review')}</div>
  </div>
  <div class="workspace"><aside id="sidebar"><div class="sidebar-top"><h2>Review order</h2><span id="progress-text"></span></div><progress id="progress" max="${review.files.length}" value="0" aria-label="Files viewed"></progress>
    <label class="search"><span class="sr-only">Filter files</span><input id="search" type="search" placeholder="Filter files…" autocomplete="off"></label>
    <div class="filters" role="group" aria-label="File filters">${button('filter', 'All', 'data-filter="" aria-pressed="true"')}${button('filter', 'Unviewed', 'data-filter="unviewed" aria-pressed="false"')}${button('filter', 'Discussed', 'data-filter="discussed" aria-pressed="false"')}</div><nav id="file-nav" aria-label="Files in review order"></nav>
  </aside><main id="content" tabindex="-1"><div class="content-toolbar"><span id="visible-count"></span><div class="layout-controls" role="group" aria-label="Diff layout">${button('layout', 'Unified', 'data-layout="unified" aria-pressed="true"')}${button('layout', 'Split', 'data-layout="split" aria-pressed="false"')}</div></div>
    <div id="files">${review.files.map((_, i) => `<section class="file-card" id="file-${i}" aria-label="${escape(review.files[i].path)}" data-index="${i}"></section>`).join('')}</div>
    <div id="empty" class="empty" hidden><h2>No matching files</h2>${button('clear-filter', 'Clear filters')}</div>
  </main></div>
  <div id="announcement" class="sr-only" role="status" aria-live="polite"></div>
  <dialog id="export-dialog" aria-labelledby="export-title"><div class="dialog-heading"><h2 id="export-title">Review feedback</h2>${button('close-export', 'Close')}</div><label for="markdown-output">Markdown</label><textarea id="markdown-output" readonly spellcheck="false"></textarea><div class="export-bottom"><p id="copy-status" role="status"></p><div>${button('select-output', 'Select all')}${button('copy-output', 'Copy Markdown', '', 'primary')}</div></div></dialog>`;

function hasDraft(): boolean { return !!(editor && (editor.text.trim() || editor.initialText?.trim())); }
function anchorData({ text, line, endLine, side }: Note): Note { return { text, line, endLine, side }; }
function feedbackSnapshot(): SavedFeedback {
  let draft: SavedFeedback['editor'] = null;
  if (editor && hasDraft() && editor.text !== editor.initialText) {
    const { file, text, initialText, originLine, anchor, thread, reply, editRoot } = editor;
    draft = { file, text, initialText, originLine, anchor, thread, reply, editRoot };
  }
  return { version: 1, feedback: states.map(({ viewed, threads }) => ({ viewed, threads })), editor: draft, sequence };
}
function feedbackString(data = feedbackSnapshot()): string { return JSON.stringify({ feedback: data.feedback, editor: data.editor }); }
function storageWarning(message: string): void {
  const warning = document.getElementById('storage-warning')!;
  warning.hidden = !message;
  warning.querySelector('span')!.textContent = message;
  warning.querySelector('button')!.textContent = restoreFailed ? 'Reload' : 'Retry save';
}
function saveFeedback(force = false): void {
  if (restoreFailed) return; // Keep an unread cache intact; recovery requires a reload.
  const data = feedbackSnapshot(), current = feedbackString(data);
  if (!force && current === savedFeedback) return;
  try {
    // ponytail: one writer per snapshot; concurrent tabs need conflict handling.
    localStorage.setItem(storageKey, JSON.stringify(data));
    savedFeedback = current;
    storageWarning('');
  } catch {
    storageWarning('Browser save failed. Leaving may lose your changes.');
  }
}
function restoreFeedback(): void {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw === null) return;
    const saved = JSON.parse(raw) as SavedFeedback;
    if (!saved || saved.version !== 1 || !Number.isSafeInteger(saved.sequence) || saved.sequence < 0 || saved.sequence >= Number.MAX_SAFE_INTEGER || !Array.isArray(saved.feedback) || saved.feedback.length !== states.length) throw new Error('Invalid feedback');
    const ids = new Set<string>();
    const userId = (id: string) => typeof id === 'string' && /^u-[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id.slice(2))) && Number(id.slice(2)) <= saved.sequence;
    const uniqueId = (id: string) => !ids.has(id) && !!ids.add(id);
    const validAnchor = (note: Note, i: number): boolean => {
      if (!note || typeof note.text !== 'string' || (note.side !== undefined && note.side !== 'old' && note.side !== 'new')) return false;
      if (note.line === undefined) return note.endLine === undefined;
      if (note.endLine !== undefined && !Number.isSafeInteger(note.endLine)) return false;
      const end = note.endLine ?? note.line, max = lines((note.side === 'old' ? review.files[i].before : review.files[i].after)?.text).length;
      return Number.isSafeInteger(note.line) && note.line > 0 && Number.isSafeInteger(end) && end >= note.line && end <= max;
    };
    if (!saved.feedback.every((feedback, i) => {
      if (!feedback || typeof feedback.viewed !== 'boolean' || !Array.isArray(feedback.threads)) return false;
      const originals = states[i].threads;
      return feedback.threads.every(thread => {
        if (!thread || !validAnchor(thread, i) || !Array.isArray(thread.replies)) return false;
        if (thread.author === 'Agent') {
          const original = originals.find(note => note.id === thread.id);
          if (!original || thread.text !== original.text || thread.line !== original.line || thread.endLine !== original.endLine || thread.side !== original.side) return false;
        } else if (thread.author !== 'You' || !userId(thread.id) || !thread.text.trim()) return false;
        return uniqueId(thread.id) && thread.replies.every(reply => reply && userId(reply.id) && uniqueId(reply.id) && typeof reply.text === 'string' && !!reply.text.trim());
      }) && originals.every(note => feedback.threads.some(thread => thread.id === note.id && thread.author === 'Agent'));
    })) throw new Error('Invalid threads');
    const draft = saved.editor;
    if (draft !== null) {
      if (!draft || !Number.isInteger(draft.file) || draft.file < 0 || draft.file >= states.length || typeof draft.text !== 'string' || typeof draft.initialText !== 'string' || (draft.editRoot !== undefined && typeof draft.editRoot !== 'boolean')) throw new Error('Invalid draft');
      if (draft.thread !== undefined) {
        const thread = saved.feedback[draft.file].threads.find(thread => thread.id === draft.thread);
        const reply = thread?.replies.find(reply => reply.id === draft.reply);
        if (!thread || draft.anchor !== undefined || draft.originLine !== undefined || (draft.editRoot && (thread.author !== 'You' || draft.reply !== undefined)) || (draft.reply !== undefined && !reply) || draft.initialText !== (draft.editRoot ? thread.text : reply ? reply.text : '')) throw new Error('Invalid draft target');
      } else if (draft.editRoot || draft.reply !== undefined || draft.initialText !== '' || (draft.anchor !== undefined && !validAnchor(draft.anchor, draft.file))) throw new Error('Invalid draft anchor');
      if (draft.originLine !== undefined && (!Number.isSafeInteger(draft.originLine) || draft.anchor?.line === undefined || draft.originLine < draft.anchor.line || draft.originLine > (draft.anchor.endLine ?? draft.anchor.line))) throw new Error('Invalid draft origin');
    }
    saved.feedback.forEach((feedback, i) => {
      states[i].viewed = feedback.viewed;
      states[i].open = !feedback.viewed && review.files[i].priority !== 'low';
      states[i].threads = feedback.threads.map(thread => ({ ...anchorData(thread), id: thread.id, author: thread.author, replies: thread.replies.map(({ id, text }) => ({ id, text })) }));
    });
    sequence = saved.sequence;
    if (draft) {
      const { file, text, initialText, originLine, thread, reply, editRoot } = draft;
      editor = { file, text, initialText, originLine, thread, reply, editRoot, anchor: draft.anchor && anchorData(draft.anchor) };
      states[file].open = true; states[file].loaded = true;
    }
    savedFeedback = feedbackString();
  } catch {
    restoreFailed = true;
    storageWarning('Saved feedback could not be restored. Changes are not being saved. Reload to retry.');
  }
}
function draftBadge(i: number): string { return `<span class="draft-badge" data-draft-file="${i}" ${editor?.file === i && hasDraft() ? '' : 'hidden'}>Draft</span>`; }
function updateNavigation(): void {
  const focusedFile = document.activeElement?.closest<HTMLElement>('.file-card');
  const viewed = states.filter(s => s.viewed).length;
  document.getElementById('progress-text')!.textContent = `${viewed} / ${states.length} viewed`;
  (document.getElementById('progress') as HTMLProgressElement).value = viewed;
  document.getElementById('file-nav')!.innerHTML = review.files.map((file, i) => !visible(i) ? '' : `<a href="#file-${i}" data-action="navigate" data-file="${i}" title="${escape(file.path)}" class="nav-file ${states[i].viewed ? 'is-viewed' : ''}"><span class="nav-order">${states[i].viewed ? '✓' : i + 1}</span><span class="nav-path"><span class="nav-name">${escape(fileLabels[i].name)}</span>${fileLabels[i].directory ? `<span class="nav-directory">${escape(fileLabels[i].directory)}</span>` : ''}</span>${draftBadge(i)}<span class="priority-dot ${file.priority}" title="${file.priority} priority"><span class="sr-only">${file.priority} priority</span></span>${humanCount(i) ? `<span class="nav-count" aria-label="${humanCount(i)} feedback comments">${humanCount(i)}</span>` : ''}</a>`).join('');
  let count = 0;
  states.forEach((_, i) => { const shown = visible(i); document.getElementById(`file-${i}`)!.hidden = !shown; if (shown) count++; });
  document.getElementById('visible-count')!.textContent = `${count} file${count === 1 ? '' : 's'}`;
  document.getElementById('empty')!.hidden = count !== 0;
  document.querySelectorAll<HTMLButtonElement>('[data-action="filter"]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.filter === filter)));
  if (focusedFile?.hidden) {
    const previous = Number(focusedFile.dataset.index);
    const next = states.findIndex((_, i) => i > previous && visible(i));
    const fallback = next < 0 ? states.findIndex((_, i) => visible(i)) : next;
    (fallback < 0 ? document.querySelector<HTMLElement>('[data-action="clear-filter"]') : document.querySelector<HTMLElement>(`#file-${fallback} .file-toggle`))?.focus();
  }
}
function threadHTML(i: number, thread: Thread): string {
  const controls = `data-file="${i}" data-thread="${thread.id}"`;
  const content = (author: string, text: string, tools: string) => `<div class="comment-heading"><span class="avatar ${author === 'Agent' ? 'agent' : ''}" aria-hidden="true">${author === 'Agent' ? 'A' : 'Y'}</span><strong>${author}</strong>${tools}</div><div class="markdown-body">${markdown(text)}</div>`;
  let html = `<article class="thread" id="thread-${thread.id}"><div class="thread-anchor">${thread.line === undefined ? 'File discussion' : escape(location(thread))}</div>`;
  html += content(thread.author, thread.text, thread.author === 'You' ? `<div class="comment-tools">${button('edit-root', 'Edit', controls)}${button('delete-root', 'Delete', controls)}</div>` : '<span class="agent-label">note</span>');
  for (const reply of thread.replies) html += `<div class="reply">${content('You', reply.text, `<div class="comment-tools">${button('edit-reply', 'Edit', `${controls} data-reply="${reply.id}"`)}${button('delete-reply', 'Delete', `${controls} data-reply="${reply.id}"`)}</div>`)}</div>`;
  html += editor?.file === i && editor.thread === thread.id ? composerHTML() : `<div class="reply-action">${button('reply', 'Reply…', controls)}</div>`;
  return html + '</article>';
}
function composerHTML(): string {
  if (!editor) return '';
  const invalid = (field: string) => editor?.invalid === field ? 'aria-invalid="true" aria-describedby="composer-error"' : '';
  const error = editor.error ? `<p id="composer-error" class="error" role="alert">${escape(editor.error)}</p>` : '';
  const range = editor.anchor?.line !== undefined && !editor.thread ? `<div class="comment-range"><span id="comment-range">${escape(location(editor.anchor))}</span>${button('select-end', editor.selectingEnd ? 'Cancel selection' : 'Select end line', `aria-pressed="${!!editor.selectingEnd}"`)}</div>` : '';
  return `<form class="composer" id="composer" novalidate><div class="composer-tabs">${button('write-tab', 'Write', `aria-pressed="${!editor.preview}"`)}${button('preview-tab', 'Preview', `aria-pressed="${!!editor.preview}"`)}<span>Markdown supported</span></div>${range}
    <textarea id="comment-text" name="comment" autocomplete="off" aria-label="Comment" ${invalid('text')} ${range && !editor.invalid ? 'aria-describedby="comment-range"' : ''} placeholder="Leave a review comment…" ${editor.preview ? 'hidden' : ''}>${escape(editor.text)}</textarea>${editor.preview ? `<div class="markdown-body comment-preview">${editor.text.trim() ? markdown(editor.text) : '<span class="muted">Nothing to preview</span>'}</div>` : ''}
    ${error}<div class="composer-actions">${button('cancel-comment', 'Cancel')}<button type="submit" class="primary">${editor.editRoot || editor.reply ? 'Save changes' : editor.thread ? 'Add reply' : 'Add comment'}</button></div></form>`;
}
function requestedRanges(i: number): Range[] {
  const anchors: Note[] = [...states[i].threads];
  if (editor?.file === i && editor.anchor) anchors.push(editor.anchor);
  return [...states[i].ranges, ...anchors.flatMap(note => note.line === undefined ? [] : [
    { side: note.side || 'new', start: Math.max(1, note.line - 3), end: note.line + 3 },
    { side: note.side || 'new', start: Math.max(1, (note.endLine ?? note.line) - 3), end: (note.endLine ?? note.line) + 3 }
  ])];
}
function selected(i: number, side: Side, line: number): boolean {
  if (drag?.file === i) return drag.side === side && line >= Math.min(drag.first, drag.last) && line <= Math.max(drag.first, drag.last);
  return editor?.file === i && editor.anchor?.line !== undefined && (editor.anchor.side || 'new') === side && line >= editor.anchor.line && line <= (editor.anchor.endLine ?? editor.anchor.line);
}
function highlightSelection(i: number): void {
  document.querySelectorAll<HTMLElement>(`#file-${i} .line-number button`).forEach(button => button.classList.toggle('selected-line', selected(i, button.dataset.side as Side, Number(button.dataset.line))));
}
function lineButton(i: number, side: Side, line?: number): string {
  return line === undefined ? '' : button('line', String(line), `${attr(i)} data-side="${side}" data-line="${line}" aria-label="Comment on ${side} line ${line}"`, selected(i, side, line) ? 'selected-line' : '');
}
function rowHTML(i: number, row: CodeRow, right?: CodeRow | null): string {
  const split = layout === 'split' && !mobile.matches;
  const plus = (side: Side, line?: number) => line === undefined ? '' : button('line', '+', `${attr(i)} data-side="${side}" data-line="${line}" aria-label="Add comment on ${side} line ${line}"`, 'line-plus');
  const cell = (text: string, kind: string) => `<td class="code ${kind}"><span class="sign" aria-hidden="true">${kind === 'add' ? '+' : kind === 'remove' ? '−' : ' '}</span><code>${escape(text)}</code></td>`;
  if (!split) {
    const side = row.new !== undefined ? 'new' : 'old';
    return `<tr class="code-row ${row.kind}"><td class="gutter">${plus(side, row[side])}</td><td class="line-number">${lineButton(i, 'old', row.old)}</td><td class="line-number">${lineButton(i, 'new', row.new)}</td>${cell(row.text, row.kind)}</tr>`;
  }
  const left = row.old !== undefined ? row : null;
  const next = right === undefined ? (row.new !== undefined ? row : null) : right;
  return `<tr class="code-row"><td class="gutter ${left?.kind || 'blank'}">${plus('old', left?.old)}</td><td class="line-number ${left?.kind || 'blank'}">${lineButton(i, 'old', left?.old)}</td>${left ? cell(left.text, left.kind) : '<td class="code blank"></td>'}<td class="gutter ${next?.kind || 'blank'}">${plus('new', next?.new)}</td><td class="line-number ${next?.kind || 'blank'}">${lineButton(i, 'new', next?.new)}</td>${next ? cell(next.text, next.kind) : '<td class="code blank"></td>'}</tr>`;
}
function diffHTML(i: number): string {
  const file = review.files[i], state = states[i], split = layout === 'split' && !mobile.matches, columns = split ? 6 : 4;
  if (file.kind === 'binary') return '<div class="file-notice">Binary content is not displayed. You can leave a file comment.</div>';
  if (file.kind === 'submodule') return `<div class="file-notice">Submodule <code>${escape(file.before?.text || '(absent)')}</code> → <code>${escape(file.after?.text || '(absent)')}</code></div>`;
  state.rows ||= diffRows(file);
  const rows = revealRows(state.rows, file, requestedRanges(i));
  let html = `<div class="diff-scroll" tabindex="0" role="region" aria-label="Diff for ${escape(file.path)}"><table class="diff-table ${split ? 'split' : ''}"><caption class="sr-only">${escape(file.path)}. Drag a plus button to select lines, or click a line then Select end line. Shift-click also selects a range.</caption><colgroup>${split ? '<col class="gutter-col"><col class="number-col"><col class="code-col"><col class="gutter-col"><col class="number-col"><col class="code-col">' : '<col class="gutter-col"><col class="number-col"><col class="number-col"><col>'}</colgroup><tbody>`;
  const displayed = new Set<string>();
  let editorShown = false;
  function discussions(codes: CodeRow[]): string {
    let result = '';
    for (const thread of state.threads) {
      const side = thread.side || 'new', anchor = thread.endLine ?? thread.line;
      if (thread.line !== undefined && !displayed.has(thread.id) && codes.some(code => code[side] === anchor)) {
        displayed.add(thread.id);
        result += `<tr class="discussion-row"><td colspan="${columns}">${threadHTML(i, thread)}</td></tr>`;
      }
    }
    if (editor?.file === i && !editor.thread && editor.anchor?.line !== undefined && !editorShown && codes.some(code => code[editor!.anchor!.side || 'new'] === (editor!.anchor!.endLine ?? editor!.anchor!.line))) {
      editorShown = true;
      result += `<tr class="discussion-row"><td colspan="${columns}">${composerHTML()}</td></tr>`;
    }
    return result;
  }
  let count = 0, position = 0, truncated = false;
  while (position < rows.length && count < state.budget) {
    const row = rows[position++];
    if (row.kind === 'gap') {
      const data = `${attr(i)} data-start="${row.new}" data-count="${row.count}"`;
      html += `<tr class="context-gap"><td colspan="${columns}"><div class="context-actions"><span>↕ ${row.count} unchanged lines</span>${button('expand-context', `Expand ${Math.min(row.count, 20)}`, `${data} data-amount="20"`)}${row.count > 20 ? button('expand-context', 'Expand all', `${data} data-amount="all"`) : ''}</div></td></tr>`;
      continue;
    }
    if (split && row.kind === 'remove') {
      const removed = [row], added: CodeRow[] = [];
      while (position < rows.length && rows[position].kind === 'remove') removed.push(rows[position++] as CodeRow);
      while (position < rows.length && rows[position].kind === 'add') added.push(rows[position++] as CodeRow);
      for (let n = 0; n < Math.max(removed.length, added.length); n++) {
        if (count >= state.budget) { truncated = true; break; }
        const a = removed[n], b = added[n];
        html += rowHTML(i, a || b, b || null) + discussions([a, b].filter(Boolean));
        count++;
      }
    } else {
      html += rowHTML(i, row) + discussions([row]);
      count++;
    }
  }
  html += '</tbody></table></div>';
  if (!rows.length) html += `<div class="file-notice">${file.status === 'unchanged' ? 'No changes' : 'No text changes'}${file.before?.mode !== file.after?.mode ? ` · mode ${escape(file.before?.mode || '—')} → ${escape(file.after?.mode || '—')}` : ''}</div>`;
  if (position < rows.length || truncated) html += `<div class="load-more">${button('more-lines', 'Show more lines', attr(i))}</div>`;
  // Offscreen discussions remain reachable even when a large diff is paginated.
  const remaining = state.threads.filter(thread => thread.line !== undefined && !displayed.has(thread.id));
  if (remaining.length) html += `<div class="remaining-threads"><h3>More line discussions</h3>${remaining.map(thread => threadHTML(i, thread)).join('')}</div>`;
  if (editor?.file === i && !editor.thread && editor.anchor?.line !== undefined && !editorShown) html += composerHTML();
  const endings = (['old', 'new'] as const).filter(side => { const text = (side === 'old' ? file.before : file.after)?.text; return text && !text.endsWith('\n'); });
  if (endings.length) html += `<div class="newline-note">No newline at end of file (${endings.join(', ')})</div>`;
  return html;
}

function renderFile(i: number): void {
  if (drag?.file === i) finishDrag(false);
  const file = review.files[i], state = states[i], changes = stats(i);
  const commentCount = state.threads.length + state.threads.reduce((n, t) => n + t.replies.length, 0);
  const card = document.getElementById(`file-${i}`)!;
  const focused = card.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const focusData = focused ? Object.entries(focused.dataset) : [];
  const selection = focused instanceof HTMLTextAreaElement ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] as const : null;
  const editorScroll = focused?.scrollTop || 0;
  const scrollLeft = card.querySelector('.diff-scroll')?.scrollLeft || 0;
  card.classList.toggle('viewed', state.viewed);
  const title = `<svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg><span class="file-title">${file.oldPath ? `<span class="old-path">${escape(file.oldPath)} → </span>` : ''}<strong>${escape(file.path)}</strong><span class="file-status">${escape(file.status)}</span></span>`;
  card.innerHTML = `<div class="file-header">${button('toggle-file', title, `${attr(i)} aria-expanded="${state.open}" aria-controls="file-body-${i}" aria-label="${state.open ? 'Collapse' : 'Expand'} ${escape(file.path)} (${escape(file.status)})"`, 'file-toggle')}
    <span class="priority ${file.priority}">${file.priority === 'high' ? 'Focus' : file.priority === 'low' ? 'Can skim' : 'Normal'}</span>${draftBadge(i)}${file.kind !== 'binary' && file.kind !== 'submodule' ? `<span class="diff-stats"><span class="add-text">+${changes.added}</span> <span class="remove-text">−${changes.removed}</span></span>` : ''}${commentCount ? `<span class="comment-count" title="${commentCount} comments">${commentCount} comments</span>` : ''}
    <label class="viewed-control"><input type="checkbox" data-viewed="${i}" ${state.viewed ? 'checked' : ''}>Viewed</label></div>
    <div id="file-body-${i}" class="file-body" ${state.open ? '' : 'hidden'}>${state.open ? `<div class="file-actions"><span>${file.kind === 'symlink' ? 'Symbolic link · target only' : file.kind === 'text' ? file.status === 'unchanged' ? 'No changes' : 'Changes' : file.kind === 'binary' ? `Binary file · ${file.before?.bytes || 0} → ${file.after?.bytes || 0} bytes` : 'Submodule'}${file.before && file.after && file.before.mode !== file.after.mode ? ` · mode ${escape(file.before.mode)} → ${escape(file.after.mode)}` : ''}</span>${button('file-comment', '+ File comment', attr(i))}</div>
      <div class="file-discussions">${state.threads.filter(t => t.line === undefined).map(t => threadHTML(i, t)).join('')}${editor?.file === i && !editor.thread && editor.anchor?.line === undefined ? composerHTML() : ''}</div>
      ${state.loaded ? diffHTML(i) : `<div class="load-file">${isLarge(i) ? `<p>Large diff · ${changes.added + changes.removed} changed lines</p>` : '<p>Ready to review</p>'}${button('load-file', 'Load diff', attr(i))}</div>`}` : ''}</div>`;
  const diff = card.querySelector('.diff-scroll');
  if (diff) diff.scrollLeft = scrollLeft;
  if (focused) {
    const replacement = focused.id ? card.querySelector<HTMLElement>(`#${focused.id}`)
      : focused.getAttribute('name') ? card.querySelector<HTMLElement>(`[name="${focused.getAttribute('name')}"]`)
      : focused.matches('.diff-scroll') ? card.querySelector<HTMLElement>('.diff-scroll')
      : focusData.length ? Array.from(card.querySelectorAll<HTMLElement>('button,input')).find(el => focusData.every(([key, value]) => el.dataset[key] === value) && el.classList.contains('line-plus') === focused.classList.contains('line-plus')) : null;
    (replacement || card.querySelector<HTMLElement>('.file-toggle'))?.focus({ preventScroll: true });
    if (selection && replacement instanceof HTMLTextAreaElement) {
      replacement.setSelectionRange(...selection);
      replacement.scrollTop = editorScroll;
    }
  }
}
function focusEditor(): void { (document.querySelector<HTMLElement>('#composer [aria-invalid="true"]') || document.getElementById('comment-text'))?.focus(); }
function canReplaceEditor(): boolean { return !editor || editor.text === editor.initialText || !hasDraft() || confirm('Discard the unfinished comment?'); }
function returnFromEditor(previous: Editor): void {
  const card = document.getElementById(`file-${previous.file}`)!;
  const target = previous.thread
    ? card.querySelector<HTMLElement>(`#thread-${previous.thread} [data-action="${previous.editRoot ? 'edit-root' : previous.reply ? 'edit-reply' : 'reply'}"]${previous.reply ? `[data-reply="${previous.reply}"]` : ''}`)
    : previous.anchor?.line !== undefined ? card.querySelector<HTMLElement>(`[data-action="line"][data-side="${previous.anchor.side || 'new'}"][data-line="${previous.anchor.line}"]`)
    : card.querySelector<HTMLElement>('[data-action="file-comment"]');
  (target || card.querySelector<HTMLElement>('.file-toggle'))?.focus({ preventScroll: true });
}
function openEditor(next: Editor): void {
  if (!canReplaceEditor()) return;
  const previous = editor?.file;
  editor = { ...next, initialText: next.text, originLine: next.originLine ?? next.anchor?.line };
  if (editor.anchor?.line !== undefined) editor.anchor.endLine ??= editor.anchor.line;
  states[next.file].open = true;
  states[next.file].loaded = true;
  if (previous !== undefined && previous !== next.file) renderFile(previous);
  renderFile(next.file); updateNavigation();
  saveFeedback(); focusEditor();
}
function saveComment(): void {
  if (!editor) return;
  const i = editor.file, state = states[i], text = editor.text;
  if (!text.trim()) { editor.error = 'Write a comment before adding it.'; editor.invalid = 'text'; editor.preview = false; renderFile(i); focusEditor(); return; }
  if (editor.anchor?.line !== undefined && !editor.thread) {
    const max = lines((editor.anchor.side === 'old' ? review.files[i].before : review.files[i].after)?.text).length;
    const end = editor.anchor.endLine ?? editor.anchor.line;
    if (!Number.isInteger(editor.anchor.line) || !Number.isInteger(end) || editor.anchor.line < 1 || end < editor.anchor.line || end > max) {
      editor.error = `Select valid lines from 1 to ${max} in this file.`;
      editor.invalid = undefined; editor.preview = false;
      renderFile(i); focusEditor(); return;
    }
  }
  const thread = state.threads.find(t => t.id === editor!.thread);
  if (editor.editRoot && thread) thread.text = text;
  else if (editor.reply && thread) thread.replies.find(r => r.id === editor!.reply)!.text = text;
  else if (thread) thread.replies.push({ id: `u-${++sequence}`, text });
  else state.threads.push({ ...editor.anchor, id: `u-${++sequence}`, text, author: 'You', replies: [] });
  const edited = editor.editRoot || editor.reply;
  const saved = thread || state.threads[state.threads.length - 1];
  editor = null;
  renderFile(i); updateNavigation(); saveFeedback();
  document.querySelector<HTMLElement>(`#thread-${saved.id} [data-action="reply"]`)?.focus();
  document.getElementById('announcement')!.textContent = edited ? 'Comment updated.' : 'Comment added to this review.';
}
function applyTheme(): void { document.documentElement.dataset.theme = theme === 'system' ? dark.matches ? 'dark' : 'light' : theme; }
function setNav(open: boolean): void {
  navOpen = open;
  document.getElementById('sidebar')!.classList.toggle('mobile-open', open);
  document.querySelector('[data-action="nav"]')!.setAttribute('aria-expanded', String(open));
}
async function copyOutput(): Promise<void> {
  const output = document.getElementById('markdown-output') as HTMLTextAreaElement;
  const status = document.getElementById('copy-status')!;
  const dialog = document.getElementById('export-dialog') as HTMLDialogElement;
  const copyButton = dialog.querySelector<HTMLButtonElement>('[data-action="copy-output"]')!;
  const attempt = ++copyAttempt, text = output.value;
  copyButton.disabled = true; status.textContent = 'Copying…';
  try {
    if (!navigator.clipboard?.writeText) throw new Error('unavailable');
    await navigator.clipboard.writeText(text);
    if (attempt === copyAttempt && dialog.open) status.textContent = 'Copied to clipboard.';
  } catch {
    if (attempt === copyAttempt && dialog.open) {
      status.textContent = 'Automatic copy is unavailable. Select the text and use your browser’s Copy action.';
      output.focus(); output.select();
    }
  } finally {
    if (attempt === copyAttempt) copyButton.disabled = false;
  }
}
function exportReview(): void {
  if (editor && hasDraft()) {
    editor.error = 'Add your comment or cancel it before copying the review.';
    editor.invalid = undefined; editor.preview = false;
    setNav(false);
    if (!visible(editor.file)) {
      query = ''; filter = '';
      (document.getElementById('search') as HTMLInputElement).value = '';
      updateNavigation();
    }
    states[editor.file].open = true;
    renderFile(editor.file); focusEditor(); return;
  }
  (document.getElementById('markdown-output') as HTMLTextAreaElement).value = exportMarkdown(review, states);
  (document.getElementById('export-dialog') as HTMLDialogElement).showModal();
  document.getElementById('copy-status')!.textContent = '';
  void copyOutput();
}

function selectLines(i: number, side: Side, first: number, last = first, extend = false): void {
  const sameAnchor = editor?.file === i && !editor.thread && editor.anchor?.line !== undefined && editor.anchor.side === side;
  if (editor?.selectingEnd && !sameAnchor) {
    document.getElementById('announcement')!.textContent = `Select a ${editor.anchor!.side} line in ${review.files[editor.file].path}.`;
    return;
  }
  if (sameAnchor && editor) {
    if (extend || editor.selectingEnd) first = editor.originLine ?? editor.anchor!.line!;
    editor.originLine = first;
    editor.anchor = { text: '', side, line: Math.min(first, last), endLine: Math.max(first, last) };
    editor.selectingEnd = false; editor.preview = false; editor.error = undefined; editor.invalid = undefined;
    renderFile(i); saveFeedback(); focusEditor();
  } else openEditor({ file: i, text: '', originLine: first, anchor: { text: '', side, line: Math.min(first, last), endLine: Math.max(first, last) } });
}
function updateDrag(): void {
  if (!drag) return;
  const cell = document.elementFromPoint(drag.x, Math.max(0, Math.min(innerHeight - 1, drag.y)))?.closest('td');
  const row = cell?.closest('.code-row');
  if (!row || row.closest('.file-card')?.id !== `file-${drag.file}`) return;
  if (row.closest('.split') && (cell!.cellIndex < 3 ? 'old' : 'new') !== drag.side) return;
  const line = row.querySelector<HTMLElement>(`.line-number [data-side="${drag.side}"]`);
  if (line && Number(line.dataset.line) !== drag.last) {
    drag.last = Number(line.dataset.line);
    highlightSelection(drag.file);
  }
}
function scrollDrag(): void {
  if (!drag) return;
  if (drag.moved) {
    const rect = document.getElementById(`file-${drag.file}`)!.getBoundingClientRect();
    if (drag.x >= rect.left && drag.x <= rect.right) {
      const speed = drag.y < 48 && rect.top < 0 ? -Math.min(20, (48 - drag.y) / 2)
        : drag.y > innerHeight - 48 && rect.bottom > innerHeight ? Math.min(20, (drag.y - innerHeight + 48) / 2) : 0;
      if (speed) { window.scrollBy(0, speed); updateDrag(); }
    }
  }
  dragFrame = requestAnimationFrame(scrollDrag);
}
function finishDrag(commit: boolean): void {
  if (!drag) return;
  const ended = drag;
  drag = null; cancelAnimationFrame(dragFrame);
  document.body.classList.remove('selecting-lines');
  if (ended.target.hasPointerCapture(ended.pointer)) ended.target.releasePointerCapture(ended.pointer);
  highlightSelection(ended.file);
  if (commit) selectLines(ended.file, ended.side, ended.first, ended.last);
}
document.addEventListener('pointerdown', event => {
  if (drag) return;
  ignorePointerClick = false;
  const target = (event.target as Element).closest<HTMLElement>('.line-plus');
  if (!target || event.button !== 0 || !event.isPrimary || event.shiftKey || editor?.selectingEnd) return;
  event.preventDefault();
  target.focus({ preventScroll: true });
  drag = { pointer: event.pointerId, target, file: Number(target.dataset.file), side: target.dataset.side as Side, first: Number(target.dataset.line), last: Number(target.dataset.line), x: event.clientX, y: event.clientY, moved: false };
  ignorePointerClick = true;
  target.setPointerCapture(event.pointerId);
  document.body.classList.add('selecting-lines');
  highlightSelection(drag.file);
  dragFrame = requestAnimationFrame(scrollDrag);
});
document.addEventListener('pointermove', event => {
  if (!drag || drag.pointer !== event.pointerId) return;
  drag.moved ||= Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) > 2;
  drag.x = event.clientX; drag.y = event.clientY;
  updateDrag();
});
document.addEventListener('pointerup', event => {
  if (!drag || drag.pointer !== event.pointerId) return;
  drag.x = event.clientX; drag.y = event.clientY;
  updateDrag(); finishDrag(true);
});
for (const type of ['pointercancel', 'lostpointercapture']) document.addEventListener(type, event => {
  if (drag?.pointer === (event as PointerEvent).pointerId) finishDrag(false);
});
window.addEventListener('blur', () => finishDrag(false));

document.addEventListener('click', event => {
  // Completing a drag replaces its button; do not let the following click open a second editor.
  if (ignorePointerClick && event.detail > 0) { ignorePointerClick = false; event.preventDefault(); return; }
  const target = (event.target as Element).closest<HTMLElement>('[data-action]');
  if (!target) return;
  event.preventDefault();
  // WebKit does not focus clicked buttons; keep action/keyboard continuity across rerenders.
  target.focus({ preventScroll: true });
  const action = target.dataset.action, i = Number(target.dataset.file), thread = states[i]?.threads.find(t => t.id === target.dataset.thread);
  switch (action) {
    case 'toggle-file':
      states[i].open = !states[i].open;
      if (states[i].open && !isLarge(i)) states[i].loaded = true;
      renderFile(i); break;
    case 'load-file':
      states[i].loaded = true; renderFile(i);
      document.querySelector<HTMLElement>(`#file-${i} .line-number button`)?.focus({ preventScroll: true }); break;
    case 'more-lines': {
      const count = document.querySelectorAll(`#file-${i} .code-row`).length;
      states[i].budget += 600; renderFile(i);
      document.querySelectorAll(`#file-${i} .code-row`)[count]?.querySelector<HTMLElement>('.line-number button')?.focus({ preventScroll: true }); break;
    }
    case 'expand-context': {
      const start = Number(target.dataset.start), count = Number(target.dataset.count), amount = target.dataset.amount === 'all' ? count : Math.min(count, 20);
      states[i].ranges.push({ side: 'new', start, end: start + amount - 1 });
      renderFile(i);
      document.querySelector<HTMLElement>(`#file-${i} .line-number [data-side="new"][data-line="${start}"]`)?.focus({ preventScroll: true }); break;
    }
    case 'line': selectLines(i, target.dataset.side as Side, Number(target.dataset.line), Number(target.dataset.line), event.shiftKey); break;
    case 'select-end':
      editor!.selectingEnd = !editor!.selectingEnd;
      renderFile(editor!.file);
      if (editor!.selectingEnd) {
        document.getElementById('announcement')!.textContent = `Select the end line on the ${editor!.anchor!.side} side of this file.`;
        document.querySelector<HTMLElement>(`#file-${editor!.file} .line-number [data-side="${editor!.anchor!.side}"][data-line="${editor!.anchor!.endLine}"]`)?.focus({ preventScroll: true });
      }
      break;
    case 'file-comment': openEditor({ file: i, text: '' }); break;
    case 'reply': openEditor({ file: i, text: '', thread: thread!.id }); break;
    case 'edit-root': openEditor({ file: i, text: thread!.text, thread: thread!.id, editRoot: true }); break;
    case 'edit-reply': openEditor({ file: i, text: thread!.replies.find(r => r.id === target.dataset.reply)!.text, thread: thread!.id, reply: target.dataset.reply }); break;
    case 'delete-root':
      if (!confirm(thread!.replies.length ? 'Delete this comment and all its replies?' : 'Delete this comment?')) return;
      if (editor?.thread === thread!.id) editor = null;
      states[i].threads = states[i].threads.filter(t => t !== thread); renderFile(i); updateNavigation(); saveFeedback(); break;
    case 'delete-reply':
      if (!confirm('Delete this reply?')) return;
      if (editor?.reply === target.dataset.reply) editor = null;
      thread!.replies = thread!.replies.filter(r => r.id !== target.dataset.reply); renderFile(i); updateNavigation(); saveFeedback(); break;
    case 'cancel-comment': {
      if (!canReplaceEditor()) return;
      const previous = editor!; editor = null; renderFile(previous.file); updateNavigation(); saveFeedback(); returnFromEditor(previous); break;
    }
    case 'write-tab': case 'preview-tab': editor!.preview = action === 'preview-tab'; renderFile(editor!.file); if (!editor!.preview) focusEditor(); break;
    case 'retry-save': if (restoreFailed) window.location.reload(); else saveFeedback(true); break;
    case 'export': exportReview(); break;
    case 'copy-output': void copyOutput(); break;
    case 'select-output': { const el = document.getElementById('markdown-output') as HTMLTextAreaElement; el.focus(); el.select(); break; }
    case 'close-export': (document.getElementById('export-dialog') as HTMLDialogElement).close(); break;
    case 'filter': filter = target.dataset.filter!; updateNavigation(); break;
    case 'clear-filter': filter = ''; query = ''; (document.getElementById('search') as HTMLInputElement).value = ''; updateNavigation(); break;
    case 'layout':
      layout = target.dataset.layout!;
      document.querySelectorAll<HTMLElement>('[data-action="layout"]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.layout === layout)));
      states.forEach((s, n) => { if (s.open && s.loaded) renderFile(n); }); break;
    case 'nav': setNav(!navOpen); if (navOpen && event.detail === 0) document.getElementById('search')?.focus(); break;
    case 'navigate':
      states[i].open = true; if (!isLarge(i)) states[i].loaded = true; renderFile(i); setNav(false);
      document.getElementById(`file-${i}`)!.scrollIntoView({ block: 'start' });
      document.querySelector<HTMLButtonElement>(`#file-${i} .file-toggle`)?.focus({ preventScroll: true }); break;
  }
});
document.addEventListener('input', event => {
  const el = event.target as HTMLInputElement;
  if (editor && el.closest('#composer')) {
    editor.error = undefined; editor.invalid = undefined;
    document.getElementById('composer-error')?.remove();
    document.querySelectorAll('#composer [aria-invalid]').forEach(input => { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); });
  }
  if (el.id === 'comment-text' && editor) {
    editor.text = el.value;
    document.querySelectorAll<HTMLElement>(`[data-draft-file="${editor.file}"]`).forEach(badge => badge.hidden = !hasDraft());
    saveFeedback();
  }
  if (el.id === 'search') { query = el.value.toLowerCase(); updateNavigation(); }
});
document.addEventListener('change', event => {
  const el = event.target as HTMLInputElement;
  if (el.dataset.viewed !== undefined) {
    el.focus({ preventScroll: true });
    const i = Number(el.dataset.viewed);
    states[i].viewed = el.checked; states[i].open = !el.checked;
    if (!el.checked && !isLarge(i)) states[i].loaded = true;
    renderFile(i); updateNavigation(); saveFeedback();
  }
  if (el.id === 'theme') { theme = el.value; applyTheme(); }
});
window.addEventListener('beforeunload', event => {
  if (feedbackString() === savedFeedback) return;
  event.preventDefault();
  event.returnValue = '';
});
document.addEventListener('copy', event => {
  const output = document.getElementById('markdown-output') as HTMLTextAreaElement;
  // Native copy has no completion callback; only a trusted, complete copy reports success.
  if (!event.isTrusted || event.defaultPrevented || document.activeElement !== output || output.selectionStart !== 0 || output.selectionEnd !== output.value.length) return;
  copyAttempt++;
  (document.querySelector('[data-action="copy-output"]') as HTMLButtonElement).disabled = false;
  document.getElementById('copy-status')!.textContent = 'Copied to clipboard.';
});
document.addEventListener('submit', event => { if ((event.target as HTMLElement).id === 'composer') { event.preventDefault(); saveComment(); } });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && drag) { event.preventDefault(); finishDrag(false); return; }
  if (event.key === 'Escape' && editor?.selectingEnd) { event.preventDefault(); editor.selectingEnd = false; renderFile(editor.file); focusEditor(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && (event.target as HTMLElement).closest('#composer')) { event.preventDefault(); saveComment(); }
  if (event.key === 'Escape' && navOpen) { setNav(false); document.querySelector<HTMLElement>('[data-action="nav"]')?.focus(); }
});
mobile.addEventListener('change', () => { states.forEach((s, i) => { if (s.open && s.loaded) renderFile(i); }); setNav(false); });
dark.addEventListener('change', applyTheme);
restoreFeedback();
applyTheme();
states.forEach((_, i) => renderFile(i));
updateNavigation();
if (editor) focusEditor();
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const i = Number((entry.target as HTMLElement).dataset.index);
      if (entry.isIntersecting && states[i].open && !states[i].loaded && !isLarge(i)) { states[i].loaded = true; renderFile(i); }
    }
  }, { rootMargin: '300px' });
  document.querySelectorAll('.file-card').forEach(card => observer.observe(card));
} else states.forEach((state, i) => { if (state.open && !isLarge(i)) { state.loaded = true; renderFile(i); } });
document.getElementById('boot-error')!.hidden = true;
