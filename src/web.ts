import MarkdownIt from 'markdown-it';
import { lines, Note, Review, Side } from './model';
import { CodeRow, diffRows, exportMarkdown, Feedback, initialFeedback, initialThreads, location, Range, revealRows, Row, Thread } from './view';

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
interface Scope { file?: number; group?: number }
const reviewState = { threads: initialThreads(review.comments ?? [], 'a-review') };
const groupStates = (review.groups ?? []).map((group, i) => ({ threads: initialThreads(group.comments, `a-group-${i}`), open: true }));
const fileGroups = new Map(review.groups?.flatMap((group, i) => group.files.map(file => [file, i] as const)));
interface Editor extends Scope { text: string; initialText?: string; originLine?: number; anchor?: Note; thread?: string; reply?: string; editRoot?: boolean; preview?: boolean; error?: string; invalid?: 'text'; selectingEnd?: boolean }
interface SavedFeedback { version: 1 | 2; feedback: Feedback[]; review?: Thread[]; groups?: Thread[][]; editor: Pick<Editor, 'file' | 'group' | 'text' | 'initialText' | 'originLine' | 'anchor' | 'thread' | 'reply' | 'editRoot'> | null; sequence: number }
interface Drag { pointer: number; target: HTMLElement; file: number; side: Side; first: number; last: number; x: number; y: number; moved: boolean }
let drag: Drag | null = null, dragFrame = 0, ignorePointerClick = false;
let editor: Editor | null = null, sequence = 0, copyAttempt = 0, copyReset = 0, toolbarFrame = 0, layout = 'unified', filter = '', query = '', navOpen = false;
let navigationJump: (Scope & { thread?: string; y: number }) | null = null;
const mobile = matchMedia('(max-width: 760px)');
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
function scopeState(scope: Scope): { threads: Thread[] } { return scope.file !== undefined ? states[scope.file] : scope.group !== undefined ? groupStates[scope.group] : reviewState; }
function scopeAttributes(scope: Scope): string { return scope.file !== undefined ? attr(scope.file) : scope.group !== undefined ? `data-group="${scope.group}"` : ''; }
function scopeElement(scope: Scope): HTMLElement { return document.getElementById(scope.file !== undefined ? `file-${scope.file}` : scope.group !== undefined ? `group-discussions-${scope.group}` : 'review-discussions')!; }
function sameScope(a: Scope | null, b: Scope): boolean { return !!a && a.file === b.file && a.group === b.group; }
function scopeFromElement(el: HTMLElement): Scope { return el.dataset.file !== undefined ? { file: Number(el.dataset.file) } : el.dataset.group !== undefined ? { group: Number(el.dataset.group) } : {}; }
function humanCount(i: number): number { return threadCount(states[i].threads); }
function threadCount(threads: Thread[]): number { return threads.reduce((n, t) => n + (t.author === 'You' ? 1 : 0) + t.replies.length, 0); }
function groupVisible(i: number): boolean { return review.groups![i].files.some(visible) || threadCount(groupStates[i].threads) > 0 || (sameScope(editor, { group: i }) && hasDraft()); }
function fileCard(i: number): string { return `<section class="file-card" id="file-${i}" aria-label="${escape(review.files[i].path)}" data-index="${i}"></section>`; }
function visible(i: number): boolean {
  return `${review.files[i].path} ${review.files[i].oldPath || ''}`.toLowerCase().includes(query) && (!filter || (filter === 'unviewed' ? !states[i].viewed : humanCount(i) > 0));
}

app.innerHTML = `
  <a class="skip-link" href="#content">Skip to review files</a>
  <header class="topbar"><a class="brand" href="#">${icon}<span>revmap</span></a><span class="repo-name">${escape(review.repository)}</span></header>
  <nav id="review-toolbar" aria-label="Review navigation and actions"><div class="toolbar-inner"><div class="toolbar-navigation">
    ${(['file', 'comment'] as const).map(kind => `<div class="step-group" role="group" aria-label="${kind === 'file' ? 'File' : 'Comment'} navigation">${button(`previous-${kind}`, '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg>', `aria-label="Previous ${kind}"`, 'step-button')}<span class="step-caption">${kind === 'file' ? 'File' : 'Comments'}<span id="${kind}-position"></span></span>${button(`next-${kind}`, '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6"/></svg>', `aria-label="Next ${kind}"`, 'step-button')}</div>`).join('')}
    </div><div class="toolbar-actions">${button('nav', 'Files', 'aria-expanded="false" aria-controls="sidebar" popovertarget="sidebar"', 'mobile-nav')}<div class="layout-controls" role="group" aria-label="Diff layout">${button('layout', 'Unified', 'data-layout="unified" aria-pressed="true"')}${button('layout', 'Split', 'data-layout="split" aria-pressed="false"')}</div>${button('export', 'Copy feedback', '', 'primary copy-review')}</div></div></nav>
  <div class="review-heading"><div><div class="eyebrow">REVIEW MAP</div><h1>Review changes <span class="count">${review.files.length}</span></h1><p class="snapshot"><code>${review.base ? escape(review.base.slice(0, 8)) : 'empty'}</code><span>→</span>Working tree<span class="snapshot-time">· ${escape(new Date(review.createdAt).toLocaleString())}</span></p><div id="storage-warning" class="error" role="alert" hidden><span></span> ${button('retry-save', 'Retry save')}</div></div>
  </div>
  <div class="workspace"><aside id="sidebar"><div class="sidebar-top"><h2>Review order</h2><span id="progress-text"></span></div><progress id="progress" max="${review.files.length}" value="0" aria-label="Files viewed"></progress>
    <label class="search"><span class="sr-only">Filter files</span><input id="search" type="search" placeholder="Filter files…" autocomplete="off"></label>
    <div class="filters" role="group" aria-label="File filters">${button('filter', 'All', 'data-filter="" aria-pressed="true"')}${button('filter', 'Unviewed', 'data-filter="unviewed" aria-pressed="false"')}${button('filter', 'Discussed', 'data-filter="discussed" aria-pressed="false"')}</div><nav id="file-nav" aria-label="Files in review order"></nav>
  </aside><main id="content" tabindex="-1">
    <section id="review-overview" class="context-block" aria-labelledby="overview-title"><div class="context-heading"><h2 id="overview-title">Review overview</h2><span class="draft-badge" data-draft-review hidden>Draft</span>${button('review-comment', '+ Review comment')}</div><div id="review-discussions" class="scope-discussions"></div></section>
    <div id="files">${review.groups ? review.groups.map((group, i) => `<section class="review-group" id="group-${i}" aria-labelledby="group-title-${i}"><div class="group-heading">${button('toggle-group', `<svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg><span id="group-title-${i}">${escape(group.title)}</span><span class="count">${group.files.length}</span>`, `data-group="${i}" aria-expanded="true" aria-controls="group-files-${i}"`, 'group-toggle')}<span class="group-draft" data-draft-group="${i}" hidden>Draft</span>${button('group-comment', '+ Group comment', `data-group="${i}"`)}</div><div id="group-discussions-${i}" class="scope-discussions"></div><div id="group-files-${i}">${group.files.map(fileCard).join('')}</div></section>`).join('') : review.files.map((_, i) => fileCard(i)).join('')}</div>
    <div id="empty" class="empty" hidden><h2>No matching files</h2>${button('clear-filter', 'Clear filters')}</div>
  </main></div>
  <div id="announcement" class="sr-only" role="status" aria-live="polite"></div>
  <dialog id="export-dialog" aria-labelledby="export-title"><div class="dialog-heading"><h2 id="export-title">Review feedback</h2>${button('close-export', 'Close')}</div><label for="markdown-output">Markdown</label><textarea id="markdown-output" readonly spellcheck="false"></textarea><div class="export-bottom"><p id="copy-status" role="status"></p><div>${button('select-output', 'Select all')}${button('copy-output', 'Copy Markdown', '', 'primary')}</div></div></dialog>`;

function hasDraft(): boolean { return !!(editor && (editor.text.trim() || editor.initialText?.trim())); }
function anchorData({ text, line, endLine, side }: Note): Note { return { text, line, endLine, side }; }
function feedbackSnapshot(): SavedFeedback {
  let draft: SavedFeedback['editor'] = null;
  if (editor && hasDraft() && editor.text !== editor.initialText) {
    const { file, group, text, initialText, originLine, anchor, thread, reply, editRoot } = editor;
    draft = { file, group, text, initialText, originLine, anchor, thread, reply, editRoot };
  }
  return { version: 2, feedback: states.map(({ viewed, threads }) => ({ viewed, threads })), review: reviewState.threads, groups: groupStates.map(state => state.threads), editor: draft, sequence };
}
function feedbackString(data = feedbackSnapshot()): string { return JSON.stringify({ feedback: data.feedback, review: data.review, groups: data.groups, editor: data.editor }); }
function storageWarning(message: string): void {
  const warning = document.getElementById('storage-warning')!;
  warning.hidden = !message;
  warning.querySelector('span')!.textContent = message;
  warning.querySelector('button')!.textContent = restoreFailed ? 'Reload' : 'Retry save';
}
function saveFeedback(force = false): void {
  const copy = document.querySelector<HTMLButtonElement>('[data-action="export"]')!;
  if (!copy.disabled) { clearTimeout(copyReset); copy.textContent = 'Copy feedback'; }
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
    if (!saved || (saved.version !== 1 && saved.version !== 2) || (saved.version === 1 && (review.comments !== undefined || review.groups !== undefined)) || !Number.isSafeInteger(saved.sequence) || saved.sequence < 0 || saved.sequence >= Number.MAX_SAFE_INTEGER || !Array.isArray(saved.feedback) || saved.feedback.length !== states.length) throw new Error('Invalid feedback');
    const ids = new Set<string>();
    const userId = (id: string) => typeof id === 'string' && /^u-[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id.slice(2))) && Number(id.slice(2)) <= saved.sequence;
    const uniqueId = (id: string) => !ids.has(id) && !!ids.add(id);
    const validScope = (scope: Scope): boolean => scope.file !== undefined
      ? scope.group === undefined && Number.isInteger(scope.file) && scope.file >= 0 && scope.file < states.length
      : scope.group === undefined || (Number.isInteger(scope.group) && scope.group >= 0 && scope.group < groupStates.length);
    const validAnchor = (note: Note, scope: Scope): boolean => {
      if (!note || typeof note.text !== 'string' || (note.side !== undefined && note.side !== 'old' && note.side !== 'new')) return false;
      if (scope.file === undefined) return note.line === undefined && note.endLine === undefined && note.side === undefined;
      if (note.line === undefined) return note.endLine === undefined;
      if (note.endLine !== undefined && !Number.isSafeInteger(note.endLine)) return false;
      const end = note.endLine ?? note.line, max = lines((note.side === 'old' ? review.files[scope.file].before : review.files[scope.file].after)?.text).length;
      return Number.isSafeInteger(note.line) && note.line > 0 && Number.isSafeInteger(end) && end >= note.line && end <= max;
    };
    const validThreads = (threads: Thread[], originals: Thread[], scope: Scope): boolean => Array.isArray(threads) && threads.every(thread => {
      if (!thread || !validAnchor(thread, scope) || !Array.isArray(thread.replies)) return false;
      if (thread.author === 'Agent') {
        const original = originals.find(note => note.id === thread.id);
        if (!original || thread.text !== original.text || thread.line !== original.line || thread.endLine !== original.endLine || thread.side !== original.side) return false;
      } else if (thread.author !== 'You' || !userId(thread.id) || !thread.text.trim()) return false;
      return uniqueId(thread.id) && thread.replies.every(reply => reply && userId(reply.id) && uniqueId(reply.id) && typeof reply.text === 'string' && !!reply.text.trim());
    }) && originals.every(note => threads.some(thread => thread.id === note.id && thread.author === 'Agent'));
    const reviewThreads = saved.version === 1 ? [] : saved.review!;
    const groups = saved.version === 1 ? [] : saved.groups!;
    if (!saved.feedback.every((feedback, i) => feedback && typeof feedback.viewed === 'boolean' && validThreads(feedback.threads, states[i].threads, { file: i })) ||
      !validThreads(reviewThreads, reviewState.threads, {}) || !Array.isArray(groups) || groups.length !== groupStates.length ||
      !groups.every((threads, i) => validThreads(threads, groupStates[i].threads, { group: i }))) throw new Error('Invalid threads');
    const savedThreads = (scope: Scope) => scope.file !== undefined ? saved.feedback[scope.file].threads : scope.group !== undefined ? groups[scope.group] : reviewThreads;
    const draft = saved.editor;
    if (draft !== null) {
      if (!draft || !validScope(draft) || (saved.version === 1 && draft.file === undefined) || typeof draft.text !== 'string' || typeof draft.initialText !== 'string' || (draft.editRoot !== undefined && typeof draft.editRoot !== 'boolean')) throw new Error('Invalid draft');
      if (draft.thread !== undefined) {
        const thread = savedThreads(draft).find(thread => thread.id === draft.thread);
        const reply = thread?.replies.find(reply => reply.id === draft.reply);
        if (!thread || draft.anchor !== undefined || draft.originLine !== undefined || (draft.editRoot && (thread.author !== 'You' || draft.reply !== undefined)) || (draft.reply !== undefined && !reply) || draft.initialText !== (draft.editRoot ? thread.text : reply ? reply.text : '')) throw new Error('Invalid draft target');
      } else if (draft.editRoot || draft.reply !== undefined || draft.initialText !== '' || (draft.anchor !== undefined && !validAnchor(draft.anchor, draft))) throw new Error('Invalid draft anchor');
      if (draft.originLine !== undefined && (!Number.isSafeInteger(draft.originLine) || draft.anchor?.line === undefined || draft.originLine < draft.anchor.line || draft.originLine > (draft.anchor.endLine ?? draft.anchor.line))) throw new Error('Invalid draft origin');
    }
    const copyThreads = (threads: Thread[]) => threads.map(thread => ({ ...anchorData(thread), id: thread.id, author: thread.author, replies: thread.replies.map(({ id, text }) => ({ id, text })) }));
    saved.feedback.forEach((feedback, i) => {
      states[i].viewed = feedback.viewed;
      states[i].open = !feedback.viewed && review.files[i].priority !== 'low';
      states[i].threads = copyThreads(feedback.threads);
    });
    reviewState.threads = copyThreads(reviewThreads);
    groupStates.forEach((state, i) => state.threads = copyThreads(groups[i]));
    sequence = saved.sequence;
    if (draft) {
      const { file, group, text, initialText, originLine, thread, reply, editRoot } = draft;
      editor = { file, group, text, initialText, originLine, thread, reply, editRoot, anchor: draft.anchor && anchorData(draft.anchor) };
      if (file !== undefined) { states[file].open = true; states[file].loaded = true; }
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
  const fileLink = (i: number) => {
    const file = review.files[i];
    return !visible(i) ? '' : `<a href="#file-${i}" data-action="navigate" data-file="${i}" title="${escape(file.path)}" class="nav-file ${states[i].viewed ? 'is-viewed' : ''}"><span class="nav-order">${states[i].viewed ? '✓' : i + 1}</span><span class="nav-path"><span class="nav-name">${escape(fileLabels[i].name)}</span>${fileLabels[i].directory ? `<span class="nav-directory">${escape(fileLabels[i].directory)}</span>` : ''}</span>${draftBadge(i)}<span class="priority-dot ${file.priority}" title="${file.priority} priority"><span class="sr-only">${file.priority} priority</span></span>${humanCount(i) ? `<span class="nav-count" aria-label="${humanCount(i)} feedback comments">${humanCount(i)}</span>` : ''}</a>`;
  };
  document.getElementById('file-nav')!.innerHTML = `<a href="#review-overview" data-action="navigate-review" class="nav-overview">Review overview <span class="draft-badge" data-draft-review hidden>Draft</span></a>` + (review.groups ? review.groups.map((group, i) => !groupVisible(i) ? '' : `<div class="nav-group-section"><a href="#group-${i}" data-action="navigate-group" data-group="${i}" class="nav-group">${escape(group.title)}</a>${group.files.map(fileLink).join('')}</div>`).join('') : review.files.map((_, i) => fileLink(i)).join(''));
  groupStates.forEach((_, i) => {
    document.getElementById(`group-${i}`)!.hidden = !groupVisible(i);
  });
  updateDraftBadges();
  let count = 0;
  states.forEach((_, i) => { const shown = visible(i); document.getElementById(`file-${i}`)!.hidden = !shown; if (shown) count++; });
  document.getElementById('empty')!.hidden = count !== 0;
  document.querySelectorAll<HTMLButtonElement>('[data-action="filter"]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.filter === filter)));
  if (focusedFile?.hidden) {
    const previous = Number(focusedFile.dataset.index);
    const next = states.findIndex((_, i) => i > previous && visible(i));
    const fallback = next < 0 ? states.findIndex((_, i) => visible(i)) : next;
    (fallback < 0 ? document.querySelector<HTMLElement>('[data-action="clear-filter"]') : document.querySelector<HTMLElement>(`#file-${fallback} .file-toggle`))?.focus();
  }
  updateToolbar();
}
function updateDraftBadges(): void {
  document.querySelectorAll<HTMLElement>('[data-draft-file]').forEach(badge => badge.hidden = editor?.file !== Number(badge.dataset.draftFile) || !hasDraft());
  document.querySelectorAll<HTMLElement>('[data-draft-group]').forEach(badge => badge.hidden = !editor || !hasDraft() || (editor.file !== undefined ? fileGroups.get(editor.file) !== Number(badge.dataset.draftGroup) : editor.group !== Number(badge.dataset.draftGroup)));
  document.querySelectorAll<HTMLElement>('[data-draft-review]').forEach(badge => badge.hidden = !sameScope(editor, {}) || !hasDraft());
}
function toolbarItems(): { files: number[]; comments: (Scope & { id: string; element: HTMLElement | null })[] } {
  // ponytail: linear target scan per frame; cache geometry if large reviews make scrolling slow.
  const files = states.flatMap((_, i) => visible(i) ? [i] : []);
  const targets = (scope: Scope) => {
    const rendered = Array.from(scopeElement(scope).querySelectorAll<HTMLElement>('.thread'));
    const ids = rendered.map(el => el.id.slice('thread-'.length)), present = new Set(ids);
    const missing = scopeState(scope).threads.filter(thread => !present.has(thread.id));
    return [...ids, ...missing.map(thread => thread.id)].map(id => ({ ...scope, id, element: document.getElementById(`thread-${id}`) }));
  };
  const comments = targets({});
  if (review.groups) review.groups.forEach((group, i) => {
    if (groupVisible(i)) { comments.push(...targets({ group: i })); group.files.filter(visible).forEach(file => comments.push(...targets({ file }))); }
  });
  else files.forEach(file => comments.push(...targets({ file })));
  return { files, comments };
}
function updateToolbar(): void {
  const { files, comments } = toolbarItems();
  const top = document.getElementById('review-toolbar')!.getBoundingClientRect().bottom;
  if (navOpen) document.getElementById('sidebar')!.style.setProperty('--navigation-top', `${top + 8}px`);
  if (navigationJump && (navigationJump.y !== scrollY || (navigationJump.file !== undefined && !files.includes(navigationJump.file)) || (navigationJump.group !== undefined && !groupVisible(navigationJump.group)) || (navigationJump.thread && !comments.some(comment => comment.id === navigationJump!.thread)))) navigationJump = null;
  let currentFile = files.length ? 0 : -1;
  files.forEach((file, index) => {
    const group = fileGroups.get(file);
    if (group !== undefined && !groupStates[group].open && review.groups![group].files.find(visible) !== file) return;
    const card = document.getElementById(group !== undefined && !groupStates[group].open ? `group-${group}` : `file-${file}`)!;
    if (card.getBoundingClientRect().top <= top + 1) currentFile = index;
  });
  if (navigationJump?.file !== undefined) currentFile = files.indexOf(navigationJump.file);
  const file = files[currentFile], card = document.getElementById(`file-${file}`);
  const headerHeight = card && card.getClientRects().length && card.getBoundingClientRect().top <= top + 1 ? card.querySelector('.file-header')!.getBoundingClientRect().height : 0;
  const readingTop = top + headerHeight + 12;
  let currentComment = -1;
  comments.forEach((comment, index) => {
    const threshold = comment.file === file ? readingTop : top + 12;
    if ((comment.file !== undefined && comment.file < file) || (comment.element?.getClientRects().length && comment.element.getBoundingClientRect().top <= threshold + 1)) currentComment = index;
  });
  if (navigationJump?.thread) currentComment = comments.findIndex(comment => comment.id === navigationJump!.thread);
  const current = comments[currentComment];
  const insideComment = !!current && (!!navigationJump?.thread || (!!current.element && current.element.getBoundingClientRect().bottom > readingTop && current.element.getBoundingClientRect().top <= readingTop + 1));
  document.getElementById('file-position')!.textContent = `${currentFile + 1} / ${files.length}`;
  document.getElementById('comment-position')!.textContent = `${currentComment < 0 && comments.length ? '—' : currentComment + 1} / ${comments.length}`;
  for (const [action, index] of [['previous-file', currentFile - 1], ['next-file', currentFile + 1]] as const) {
    const control = document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!;
    control.disabled = index < 0 || index >= files.length;
    control.dataset.file = String(files[index]);
  }
  for (const [action, index] of [['previous-comment', currentComment - (insideComment ? 1 : 0)], ['next-comment', currentComment + 1]] as const) {
    const control = document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!;
    control.disabled = index < 0 || index >= comments.length;
    delete control.dataset.file; delete control.dataset.group;
    if (comments[index]?.file !== undefined) control.dataset.file = String(comments[index].file);
    if (comments[index]?.group !== undefined) control.dataset.group = String(comments[index].group);
    control.dataset.thread = comments[index]?.id || '';
    control.dataset.anchor = current?.id || '';
  }
  document.querySelectorAll<HTMLElement>('#file-nav .nav-file').forEach(link => {
    if (Number(link.dataset.file) === file) link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  });
}
function scheduleToolbar(): void {
  if (!toolbarFrame) toolbarFrame = requestAnimationFrame(() => { toolbarFrame = 0; updateToolbar(); });
}
function scrollPage(top: number): void {
  const root = document.scrollingElement!;
  window.scrollTo({ top: Math.max(0, Math.min(top, root.scrollHeight - root.clientHeight)), behavior: 'instant' });
}
function revealTarget(target: HTMLElement): void {
  const header = target.closest('.file-card')?.querySelector('.file-header');
  const offset = document.getElementById('review-toolbar')!.getBoundingClientRect().height + (target.classList.contains('file-card') ? 0 : header?.getBoundingClientRect().height || 0) + 12;
  scrollPage(scrollY + target.getBoundingClientRect().top - offset);
}
function navigateFile(i: number, comment?: { id: string; direction: number; anchor: string }): void {
  const group = fileGroups.get(i);
  if (group !== undefined) setGroupOpen(group, true);
  const missing = comment && !document.getElementById(`thread-${comment.id}`);
  const load = !!comment || !isLarge(i), changed = !states[i].open || (load && !states[i].loaded);
  states[i].open = true;
  if (load) states[i].loaded = true;
  if (changed) renderFile(i);
  setNav(false);
  const card = document.getElementById(`file-${i}`)!;
  let target = card;
  if (comment) {
    const threads = Array.from(card.querySelectorAll<HTMLElement>('.thread'));
    const anchor = threads.findIndex(thread => thread.id === `thread-${comment.anchor}`);
    target = missing ? threads[anchor >= 0 ? anchor + comment.direction : comment.direction > 0 ? 0 : threads.length - 1] : document.getElementById(`thread-${comment.id}`)!;
    if (!target) return;
    target.classList.add('navigation-target');
    setTimeout(() => target.classList.remove('navigation-target'), 1500);
  }
  revealTarget(target);
  (comment ? target : card.querySelector<HTMLElement>('.file-toggle'))?.focus({ preventScroll: true });
  navigationJump = { file: i, thread: comment ? target.id.slice('thread-'.length) : undefined, y: scrollY };
  updateToolbar();
}
function navigateContext(scope: Scope, thread?: string): void {
  setNav(false);
  const target = thread ? document.getElementById(`thread-${thread}`)! : document.getElementById(scope.group !== undefined ? `group-${scope.group}` : 'review-overview')!;
  if (thread) { target.classList.add('navigation-target'); setTimeout(() => target.classList.remove('navigation-target'), 1500); }
  target.tabIndex = -1;
  revealTarget(target); target.focus({ preventScroll: true });
  navigationJump = { ...scope, thread, y: scrollY }; updateToolbar();
}
function threadHTML(scope: Scope | number, thread: Thread): string {
  const target = typeof scope === 'number' ? { file: scope } : scope;
  const controls = `${scopeAttributes(target)} data-thread="${thread.id}"`;
  const content = (author: string, text: string, tools: string) => `<div class="comment-heading"><span class="avatar ${author === 'Agent' ? 'agent' : ''}" aria-hidden="true">${author === 'Agent' ? 'A' : 'U'}</span><strong>${author === 'Agent' ? 'Agent' : 'User'}</strong>${tools}</div><div class="markdown-body">${markdown(text)}</div>`;
  const label = target.file !== undefined ? 'File discussion' : target.group !== undefined ? 'Group discussion' : 'Review discussion';
  let html = `<article class="thread ${thread.line === undefined ? 'context-thread' : ''}" id="thread-${thread.id}" tabindex="-1" aria-label="${thread.line === undefined ? label : escape(location(thread))}">${target.file !== undefined ? `<div class="thread-anchor">${thread.line === undefined ? label : escape(location(thread))}</div>` : ''}`;
  html += content(thread.author, thread.text, thread.author === 'You' ? `<div class="comment-tools">${button('edit-root', 'Edit', controls)}${button('delete-root', 'Delete', controls)}</div>` : '<span class="agent-label">note</span>');
  for (const reply of thread.replies) html += `<div class="reply">${content('You', reply.text, `<div class="comment-tools">${button('edit-reply', 'Edit', `${controls} data-reply="${reply.id}"`)}${button('delete-reply', 'Delete', `${controls} data-reply="${reply.id}"`)}</div>`)}</div>`;
  html += sameScope(editor, target) && editor!.thread === thread.id ? composerHTML() : `<div class="reply-action">${button('reply', 'Reply…', controls)}</div>`;
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

function replaceContent(card: HTMLElement, html: string, fallback?: HTMLElement | null): void {
  const scrollTop = scrollY;
  const focused = card.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const focusData = focused ? Object.entries(focused.dataset) : [];
  const selection = focused instanceof HTMLTextAreaElement ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] as const : null;
  const editorScroll = focused?.scrollTop || 0;
  const scrollLeft = card.querySelector('.diff-scroll')?.scrollLeft || 0;
  card.innerHTML = html;
  const diff = card.querySelector('.diff-scroll');
  if (diff) diff.scrollLeft = scrollLeft;
  if (focused) {
    const replacement = focused.id ? card.querySelector<HTMLElement>(`#${focused.id}`)
      : focused.getAttribute('name') ? card.querySelector<HTMLElement>(`[name="${focused.getAttribute('name')}"]`)
      : focused.matches('.diff-scroll') ? card.querySelector<HTMLElement>('.diff-scroll')
      : focusData.length ? Array.from(card.querySelectorAll<HTMLElement>('button,input')).find(el => focusData.every(([key, value]) => el.dataset[key] === value) && el.classList.contains('line-plus') === focused.classList.contains('line-plus')) : null;
    (replacement || card.querySelector<HTMLElement>('.file-toggle') || fallback)?.focus({ preventScroll: true });
    if (selection && replacement instanceof HTMLTextAreaElement) {
      replacement.setSelectionRange(...selection);
      replacement.scrollTop = editorScroll;
    }
  }
  // WebKit can clamp the page scroll while replacing a tall card, before its new content restores the height.
  if (scrollY !== scrollTop) scrollPage(scrollTop);
  scheduleToolbar();
}
function renderFile(i: number): void {
  if (drag?.file === i) finishDrag(false);
  const file = review.files[i], state = states[i], changes = stats(i);
  const commentCount = state.threads.length + state.threads.reduce((n, t) => n + t.replies.length, 0);
  const card = document.getElementById(`file-${i}`)!;
  card.classList.toggle('viewed', state.viewed);
  const title = `<svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg><span class="file-title">${file.oldPath ? `<span class="old-path">${escape(file.oldPath)} → </span>` : ''}<strong>${escape(file.path)}</strong><span class="file-status">${escape(file.status)}</span></span>`;
  replaceContent(card, `<div class="file-header">${button('toggle-file', title, `${attr(i)} aria-expanded="${state.open}" aria-controls="file-body-${i}" aria-label="${state.open ? 'Collapse' : 'Expand'} ${escape(file.path)} (${escape(file.status)})"`, 'file-toggle')}
    <span class="priority ${file.priority}">${file.priority === 'high' ? 'Focus' : file.priority === 'low' ? 'Can skim' : 'Normal'}</span>${draftBadge(i)}${file.kind !== 'binary' && file.kind !== 'submodule' ? `<span class="diff-stats"><span class="add-text">+${changes.added}</span> <span class="remove-text">−${changes.removed}</span></span>` : ''}${commentCount ? `<span class="comment-count" title="${commentCount} comments">${commentCount} comments</span>` : ''}
    <label class="viewed-control"><input type="checkbox" data-viewed="${i}" ${state.viewed ? 'checked' : ''}>Viewed</label></div>
    <div id="file-body-${i}" class="file-body" ${state.open ? '' : 'hidden'}>${state.open ? `<div class="file-actions"><span>${file.kind === 'symlink' ? 'Symbolic link · target only' : file.kind === 'text' ? file.status === 'unchanged' ? 'No changes' : 'Changes' : file.kind === 'binary' ? `Binary file · ${file.before?.bytes || 0} → ${file.after?.bytes || 0} bytes` : 'Submodule'}${file.before && file.after && file.before.mode !== file.after.mode ? ` · mode ${escape(file.before.mode)} → ${escape(file.after.mode)}` : ''}</span>${button('file-comment', '+ File comment', attr(i))}</div>
      <div class="file-discussions">${state.threads.filter(t => t.line === undefined).map(t => threadHTML(i, t)).join('')}${editor?.file === i && !editor.thread && editor.anchor?.line === undefined ? composerHTML() : ''}</div>
      ${state.loaded ? diffHTML(i) : `<div class="load-file">${isLarge(i) ? `<p>Large diff · ${changes.added + changes.removed} changed lines</p>` : '<p>Ready to review</p>'}${button('load-file', 'Load diff', attr(i))}</div>`}` : ''}</div>`);
}
function commentControl(scope: Scope): HTMLElement | null {
  return document.querySelector<HTMLElement>(scope.file !== undefined ? `#file-${scope.file} [data-action="file-comment"]` : scope.group !== undefined ? `#group-${scope.group} [data-action="group-comment"]` : '[data-action="review-comment"]');
}
function renderScope(scope: Scope): void {
  if (scope.file !== undefined) { renderFile(scope.file); return; }
  replaceContent(scopeElement(scope), scopeState(scope).threads.map(thread => threadHTML(scope, thread)).join('') + (sameScope(editor, scope) && !editor!.thread ? composerHTML() : ''), commentControl(scope));
}
function setGroupOpen(i: number, open: boolean): void {
  groupStates[i].open = open;
  document.getElementById(`group-files-${i}`)!.hidden = !open;
  document.querySelector(`#group-${i} [data-action="toggle-group"]`)!.setAttribute('aria-expanded', String(open));
  scheduleToolbar();
}
function showScope(scope: Scope): void {
  if (scope.file === undefined) return;
  const group = fileGroups.get(scope.file);
  if (group !== undefined) setGroupOpen(group, true);
  states[scope.file].open = true;
  states[scope.file].loaded = true;
}
function focusEditor(): void {
  const target = document.querySelector<HTMLElement>('#composer [aria-invalid="true"]') || document.getElementById('comment-text');
  target?.focus({ preventScroll: true });
  if (target) revealTarget(target.closest<HTMLElement>('#composer')!);
}
function canReplaceEditor(): boolean { return !editor || editor.text === editor.initialText || !hasDraft() || confirm('Discard the unfinished comment?'); }
function returnFromEditor(previous: Editor): void {
  const card = scopeElement(previous);
  const target = previous.thread
    ? card.querySelector<HTMLElement>(`#thread-${previous.thread} [data-action="${previous.editRoot ? 'edit-root' : previous.reply ? 'edit-reply' : 'reply'}"]${previous.reply ? `[data-reply="${previous.reply}"]` : ''}`)
    : previous.anchor?.line !== undefined ? card.querySelector<HTMLElement>(`[data-action="line"][data-side="${previous.anchor.side || 'new'}"][data-line="${previous.anchor.line}"]`)
    : commentControl(previous);
  (target || card.querySelector<HTMLElement>('.file-toggle'))?.focus({ preventScroll: true });
}
function openEditor(next: Editor): void {
  if (!canReplaceEditor()) return;
  const previous = editor;
  editor = { ...next, initialText: next.text, originLine: next.originLine ?? next.anchor?.line };
  if (editor.anchor?.line !== undefined) editor.anchor.endLine ??= editor.anchor.line;
  showScope(next);
  if (previous && !sameScope(previous, next)) renderScope(previous);
  renderScope(next); updateNavigation();
  saveFeedback(); focusEditor();
}
function saveComment(): void {
  if (!editor) return;
  const scope = editor, state = scopeState(scope), text = editor.text;
  if (!text.trim()) { editor.error = 'Write a comment before adding it.'; editor.invalid = 'text'; editor.preview = false; renderScope(scope); focusEditor(); return; }
  if (editor.file !== undefined && editor.anchor?.line !== undefined && !editor.thread) {
    const max = lines((editor.anchor.side === 'old' ? review.files[editor.file].before : review.files[editor.file].after)?.text).length;
    const end = editor.anchor.endLine ?? editor.anchor.line;
    if (!Number.isInteger(editor.anchor.line) || !Number.isInteger(end) || editor.anchor.line < 1 || end < editor.anchor.line || end > max) {
      editor.error = `Select valid lines from 1 to ${max} in this file.`;
      editor.invalid = undefined; editor.preview = false;
      renderScope(scope); focusEditor(); return;
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
  renderScope(scope); updateNavigation(); saveFeedback();
  document.querySelector<HTMLElement>(`#thread-${saved.id} [data-action="reply"]`)?.focus();
  document.getElementById('announcement')!.textContent = edited ? 'Comment updated.' : 'Comment added to this review.';
}
function setNav(open: boolean): void {
  const sidebar = document.getElementById('sidebar')!;
  if (open && mobile.matches) {
    sidebar.style.setProperty('--navigation-top', `${document.getElementById('review-toolbar')!.getBoundingClientRect().bottom + 8}px`);
    sidebar.showPopover();
  } else if (sidebar.matches(':popover-open')) sidebar.hidePopover();
  navOpen = open && mobile.matches;
  document.querySelector('[data-action="nav"]')!.setAttribute('aria-expanded', String(navOpen));
}
function copiedFeedback(): void {
  const copy = document.querySelector<HTMLButtonElement>('[data-action="export"]')!;
  copy.textContent = 'Copied';
  document.getElementById('copy-status')!.textContent = 'Copied to clipboard.';
  document.getElementById('announcement')!.textContent = 'Feedback copied to clipboard.';
  clearTimeout(copyReset);
  copyReset = window.setTimeout(() => { copy.textContent = 'Copy feedback'; }, 1800);
}
async function copyOutput(): Promise<void> {
  const output = document.getElementById('markdown-output') as HTMLTextAreaElement;
  const status = document.getElementById('copy-status')!;
  const dialog = document.getElementById('export-dialog') as HTMLDialogElement;
  const copyButton = dialog.querySelector<HTMLButtonElement>('[data-action="copy-output"]')!;
  const copy = document.querySelector<HTMLButtonElement>('[data-action="export"]')!;
  if (copy.disabled) return;
  const attempt = ++copyAttempt, text = output.value, snapshot = feedbackString(), fromDialog = dialog.open;
  clearTimeout(copyReset);
  copy.disabled = copyButton.disabled = true;
  copy.textContent = status.textContent = 'Copying…';
  try {
    if (!navigator.clipboard?.writeText) throw new Error('unavailable');
    await navigator.clipboard.writeText(text);
    if (attempt === copyAttempt) {
      if (snapshot === feedbackString()) copiedFeedback();
      else {
        copy.textContent = 'Copy feedback';
        status.textContent = 'Earlier feedback copied. Copy again to include your changes.';
        document.getElementById('announcement')!.textContent = status.textContent;
      }
    }
  } catch {
    if (attempt === copyAttempt) {
      copy.textContent = 'Copy feedback';
      status.textContent = 'Automatic copy is unavailable. Select the text and use your browser’s Copy action.';
      if (!fromDialog && !dialog.open) dialog.showModal();
      if (dialog.open) { output.focus(); output.select(); }
    }
  } finally {
    if (attempt === copyAttempt) copy.disabled = copyButton.disabled = false;
  }
}
function exportReview(): void {
  if (editor && hasDraft()) {
    editor.error = 'Add your comment or cancel it before copying feedback.';
    editor.invalid = undefined; editor.preview = false;
    setNav(false);
    if ((editor.file !== undefined && !visible(editor.file)) || (editor.group !== undefined && !groupVisible(editor.group))) {
      query = ''; filter = '';
      (document.getElementById('search') as HTMLInputElement).value = '';
      updateNavigation();
    }
    showScope(editor);
    renderScope(editor); updateNavigation(); focusEditor(); return;
  }
  (document.getElementById('markdown-output') as HTMLTextAreaElement).value = exportMarkdown(review, states, { review: reviewState.threads, groups: groupStates.map(state => state.threads) });
  document.getElementById('copy-status')!.textContent = '';
  void copyOutput();
}

function selectLines(i: number, side: Side, first: number, last = first, extend = false): void {
  const sameAnchor = editor?.file === i && !editor.thread && editor.anchor?.line !== undefined && editor.anchor.side === side;
  if (editor?.selectingEnd && !sameAnchor) {
    document.getElementById('announcement')!.textContent = `Select a ${editor.anchor!.side} line in ${review.files[editor.file!].path}.`;
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
  const action = target.dataset.action;
  if (['previous-file', 'next-file', 'previous-comment', 'next-comment'].includes(action || '')) {
    updateToolbar();
    if ((target as HTMLButtonElement).disabled) return;
  }
  const scope = scopeFromElement(target), i = Number(target.dataset.file), thread = scopeState(scope)?.threads.find(t => t.id === target.dataset.thread);
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
      renderScope(editor!);
      if (editor!.selectingEnd) {
        document.getElementById('announcement')!.textContent = `Select the end line on the ${editor!.anchor!.side} side of this file.`;
        document.querySelector<HTMLElement>(`#file-${editor!.file} .line-number [data-side="${editor!.anchor!.side}"][data-line="${editor!.anchor!.endLine}"]`)?.focus({ preventScroll: true });
      }
      break;
    case 'toggle-group': setGroupOpen(scope.group!, !groupStates[scope.group!].open); break;
    case 'review-comment': case 'group-comment': case 'file-comment': openEditor({ ...scope, text: '' }); break;
    case 'reply': openEditor({ ...scope, text: '', thread: thread!.id }); break;
    case 'edit-root': openEditor({ ...scope, text: thread!.text, thread: thread!.id, editRoot: true }); break;
    case 'edit-reply': openEditor({ ...scope, text: thread!.replies.find(r => r.id === target.dataset.reply)!.text, thread: thread!.id, reply: target.dataset.reply }); break;
    case 'delete-root':
      if (!confirm(thread!.replies.length ? 'Delete this comment and all its replies?' : 'Delete this comment?')) return;
      if (editor?.thread === thread!.id) editor = null;
      scopeState(scope).threads = scopeState(scope).threads.filter(t => t !== thread); renderScope(scope); updateNavigation(); saveFeedback(); break;
    case 'delete-reply':
      if (!confirm('Delete this reply?')) return;
      if (editor?.reply === target.dataset.reply) editor = null;
      thread!.replies = thread!.replies.filter(r => r.id !== target.dataset.reply); renderScope(scope); updateNavigation(); saveFeedback(); break;
    case 'cancel-comment': {
      if (!canReplaceEditor()) return;
      const previous = editor!; editor = null; renderScope(previous); updateNavigation(); saveFeedback(); returnFromEditor(previous); break;
    }
    case 'write-tab': case 'preview-tab': editor!.preview = action === 'preview-tab'; renderScope(editor!); if (!editor!.preview) focusEditor(); break;
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
    case 'navigate': case 'previous-file': case 'next-file': navigateFile(i); break;
    case 'navigate-review': case 'navigate-group': navigateContext(scope); break;
    case 'previous-comment': case 'next-comment':
      if (scope.file !== undefined) navigateFile(i, { id: target.dataset.thread!, direction: action === 'next-comment' ? 1 : -1, anchor: target.dataset.anchor! });
      else navigateContext(scope, target.dataset.thread!);
      break;
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
    updateDraftBadges();
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
  (document.querySelector('[data-action="export"]') as HTMLButtonElement).disabled = false;
  copiedFeedback();
});
document.addEventListener('submit', event => { if ((event.target as HTMLElement).id === 'composer') { event.preventDefault(); saveComment(); } });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && drag) { event.preventDefault(); finishDrag(false); return; }
  if (event.key === 'Escape' && editor?.selectingEnd) { event.preventDefault(); editor.selectingEnd = false; renderScope(editor); focusEditor(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && (event.target as HTMLElement).closest('#composer')) { event.preventDefault(); saveComment(); }
  if (event.key === 'Escape' && navOpen) { setNav(false); document.querySelector<HTMLElement>('[data-action="nav"]')?.focus(); }
});
const sidebar = document.getElementById('sidebar')!;
sidebar.toggleAttribute('popover', mobile.matches);
sidebar.addEventListener('toggle', () => {
  navOpen = sidebar.matches(':popover-open');
  document.querySelector('[data-action="nav"]')!.setAttribute('aria-expanded', String(navOpen));
});
mobile.addEventListener('change', () => { setNav(false); sidebar.toggleAttribute('popover', mobile.matches); states.forEach((s, i) => { if (s.open && s.loaded) renderFile(i); }); });
const resizeToolbar = () => {
  document.documentElement.style.setProperty('--toolbar-height', `${document.getElementById('review-toolbar')!.getBoundingClientRect().height}px`);
  scheduleToolbar();
};
if ('ResizeObserver' in window) new ResizeObserver(resizeToolbar).observe(document.getElementById('review-toolbar')!);
window.addEventListener('resize', resizeToolbar);
window.addEventListener('scroll', scheduleToolbar, { passive: true });
resizeToolbar();
restoreFeedback();
states.forEach((_, i) => renderFile(i));
renderScope({});
groupStates.forEach((_, group) => renderScope({ group }));
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
