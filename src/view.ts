import { parsePatch } from 'diff';
import { lines, Note, Review, ReviewFile, Side } from './model';

export interface Reply { id: string; text: string }
export interface Thread extends Note { id: string; author: 'Agent' | 'You'; replies: Reply[] }
export interface Feedback { viewed: boolean; threads: Thread[] }
export interface CodeRow { kind: 'context' | 'add' | 'remove'; text: string; old?: number; new?: number }
export interface Gap { kind: 'gap'; old: number; new: number; count: number }
export type Row = CodeRow | Gap;
export interface Range { side: Side; start: number; end: number }

export function initialFeedback(review: Review): Feedback[] {
  return review.files.map((file, i) => ({
    viewed: false,
    threads: file.comments.map((note, j) => ({ ...note, id: `a-${i}-${j}`, author: 'Agent', replies: [] }))
  }));
}

export function diffRows(file: ReviewFile): Row[] {
  if (file.kind === 'binary' || file.kind === 'submodule') return [];
  const before = lines(file.before?.text), after = lines(file.after?.text);
  const hunks = file.patch ? parsePatch(file.patch)[0]?.hunks || [] : [];
  const rows: Row[] = [];
  let old = 1, current = 1;
  for (const hunk of hunks) {
    const missing = Math.max(0, hunk.oldStart - old);
    if (missing) rows.push({ kind: 'gap', old, new: current, count: missing });
    old += missing;
    current += missing;
    for (const line of hunk.lines) {
      const text = line.slice(1).replace(/\r$/, '');
      if (line[0] === ' ') rows.push({ kind: 'context', text, old: old++, new: current++ });
      else if (line[0] === '-') rows.push({ kind: 'remove', text, old: old++ });
      else if (line[0] === '+') rows.push({ kind: 'add', text, new: current++ });
    }
  }
  const remaining = Math.min(before.length - old + 1, after.length - current + 1);
  if (remaining > 0) rows.push({ kind: 'gap', old, new: current, count: remaining });
  return rows;
}

// Gaps keep full-file context out of the DOM until the reviewer asks for it.
export function revealRows(rows: Row[], file: ReviewFile, ranges: Range[]): Row[] {
  const text = lines(file.after?.text);
  return rows.flatMap(row => {
    if (row.kind !== 'gap') return [row];
    const intervals = ranges.map(range => {
      const start = row[range.side];
      return [Math.max(0, range.start - start), Math.min(row.count, range.end - start + 1)];
    }).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
    const merged: number[][] = [];
    for (const [a, b] of intervals) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    const result: Row[] = [];
    let position = 0;
    const gap = (end: number) => {
      if (end > position) result.push({ kind: 'gap', old: row.old + position, new: row.new + position, count: end - position });
    };
    for (const [a, b] of merged) {
      gap(a);
      for (let i = a; i < b; i++) result.push({ kind: 'context', old: row.old + i, new: row.new + i, text: text[row.new + i - 1] || '' });
      position = b;
    }
    gap(row.count);
    return result;
  });
}

export function location(note: Note): string {
  if (note.line === undefined) return 'File';
  return `${note.side === 'old' ? 'old' : 'new'} L${note.line}${note.endLine && note.endLine !== note.line ? `–L${note.endLine}` : ''}`;
}

function backticks(text: string, minimum: number): string {
  let longest = minimum - 1;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return '`'.repeat(longest + 1);
}
function inlineCode(text: string): string {
  if (/[\\"\u0000-\u001f\u007f]/.test(text)) text = JSON.stringify(text);
  const fence = backticks(text, 1);
  return `${fence} ${text} ${fence}`;
}
function codeBlock(text: string): string {
  const fence = backticks(text, 3);
  return `${fence}\n${text}\n${fence}`;
}
function quote(text: string): string { return text.split('\n').map(line => `> ${line}`).join('\n'); }

export function exportMarkdown(review: Review, feedback: Feedback[]): string {
  const result = [
    '# Review feedback', '',
    `Repository: ${inlineCode(review.repository)}`,
    `Base: ${review.base ? inlineCode(review.base) : 'Empty repository'} → working tree snapshot`,
    `Snapshot: ${review.createdAt}`, '', '## Files', ''
  ];
  review.files.forEach((file, i) => {
    const rename = file.oldPath ? `${inlineCode(file.oldPath)} → ` : '';
    result.push(`- [${feedback[i].viewed ? 'x' : ' '}] ${rename}${inlineCode(file.path)}`);
  });
  result.push('', 'Checked = viewed; unchecked = not marked viewed. Neither is an approval.');
  review.files.forEach((file, i) => {
    const threads = feedback[i].threads.filter(thread => thread.author === 'You' || thread.replies.length);
    if (!threads.length) return;
    result.push('', `## ${inlineCode(file.path)}`);
    for (const thread of threads) {
      result.push('', `### ${location(thread)}`, '');
      if (thread.line !== undefined) {
        const source = lines((thread.side === 'old' ? file.before : file.after)?.text);
        const end = thread.endLine ?? thread.line;
        const excerpt = source.slice(thread.line - 1, Math.min(end, thread.line + 19)).join('\n');
        result.push(codeBlock(excerpt));
        if (end - thread.line >= 20) result.push(`_Excerpt shortened; full range: ${location(thread)}._`);
        result.push('');
      }
      if (thread.author === 'Agent') result.push('Agent context:', quote(thread.text));
      else result.push(thread.text);
      for (const reply of thread.replies) result.push('', '**You — reply:**', '', reply.text);
    }
  });
  return result.join('\n').trim() + '\n';
}
