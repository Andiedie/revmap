import { isAbsolute, sep, win32 } from 'node:path';
import type { FileInput, Note, ReviewInput } from './model';

function invalid(field: string, message: string): never {
  throw new Error(`${field}: ${message}`);
}

function object(value: unknown, field: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    invalid(field, 'expected an object; use { ... }.');
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) {
      invalid(`${field}.${String(key)}`, `unknown field; use only ${keys.join(', ')}.`);
    }
  }
  return value as Record<string, unknown>;
}

function nonempty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    invalid(field, 'expected a nonempty string; supply a value.');
  }
  return value;
}

function path(value: unknown, field: string): string {
  const result = nonempty(value, field);
  if (result.includes('\0') || Buffer.from(result).toString('utf8') !== result ||
      isAbsolute(result) || win32.isAbsolute(result) || /^[a-z]:/i.test(result) ||
      (sep === '\\' && result.includes('\\')) ||
      result.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    invalid(field, 'use a literal repository-root-relative file path, without traversal, .git, or empty components.');
  }
  return result;
}

function line(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    invalid(field, 'expected a 1-based positive integer; use a line number starting at 1.');
  }
  return value;
}

function comment(value: unknown, field: string): Note {
  const entry = object(value, field, ['text', 'line', 'endLine', 'side']);
  const text = nonempty(entry.text, `${field}.text`);
  const side = 'side' in entry ? entry.side : 'new';
  if (side !== 'old' && side !== 'new') invalid(`${field}.side`, 'use "old" or "new".');
  if (!('line' in entry)) {
    if ('endLine' in entry) invalid(`${field}.endLine`, 'requires line; add line or remove endLine for a file comment.');
    return { text, side };
  }
  const start = line(entry.line, `${field}.line`);
  const end = 'endLine' in entry ? line(entry.endLine, `${field}.endLine`) : start;
  if (end < start) invalid(`${field}.endLine`, 'must be at least line; use an inclusive forward range.');
  return { text, line: start, endLine: end, side };
}

export function parseInput(value: unknown): ReviewInput {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); }
    catch { invalid('input', 'invalid JSON; use a JSON object with double-quoted keys and no trailing commas.'); }
  }
  const input = object(value, 'input', ['base', 'comments', 'files', 'groups']);
  if ('files' in input && 'groups' in input) invalid('input', 'use files or groups, not both.');
  const base = 'base' in input ? nonempty(input.base, 'base') : undefined;
  if (base?.includes('\0')) invalid('base', 'must not contain NUL; use a commit reference such as HEAD~1.');
  const paths = new Set<string>();
  function notes(value: unknown, field: string, anchored = false): Note[] {
    if (!Array.isArray(value)) invalid(field, 'expected an array; use [] for no comments.');
    return Array.from(value, (note, i) => anchored ? comment(note, `${field}[${i}]`) : {
      text: nonempty(object(note, `${field}[${i}]`, ['text']).text, `${field}[${i}].text`)
    });
  }
  function files(value: unknown, field: string): FileInput[] {
    if (!Array.isArray(value) || !value.length) invalid(field, 'expected a nonempty ordered array; list at least one { "path": "file" }.');
    return Array.from(value, (value, index) => file(value, `${field}[${index}]`));
  }
  function file(value: unknown, field: string): FileInput {
    const entry = object(value, field, ['path', 'oldPath', 'priority', 'comments']);
    const selected = path(entry.path, `${field}.path`);
    if (paths.has(selected)) invalid(`${field}.path`, 'duplicate path; list each file only once.');
    paths.add(selected);
    const oldPath = 'oldPath' in entry ? path(entry.oldPath, `${field}.oldPath`) : undefined;
    if (oldPath === selected) invalid(`${field}.oldPath`, 'must differ from path; omit oldPath when the file has not moved.');
    const priority = 'priority' in entry ? entry.priority : 'normal';
    if (priority !== 'high' && priority !== 'normal' && priority !== 'low') {
      invalid(`${field}.priority`, 'use "high", "normal", or "low".');
    }
    const comments = 'comments' in entry ? notes(entry.comments, `${field}.comments`, true) : [];
    return { path: selected, ...(oldPath === undefined ? {} : { oldPath }), priority, comments };
  }
  const context = { ...(base === undefined ? {} : { base }), ...('comments' in input ? { comments: notes(input.comments, 'comments') } : {}) };
  if ('groups' in input) {
    if (!Array.isArray(input.groups) || !input.groups.length) invalid('groups', 'expected a nonempty ordered array of groups.');
    const groups = Array.from(input.groups, (value, i) => {
      const field = `groups[${i}]`, entry = object(value, field, ['title', 'comments', 'files']);
      return { title: nonempty(entry.title, `${field}.title`), comments: 'comments' in entry ? notes(entry.comments, `${field}.comments`) : [], files: files(entry.files, `${field}.files`) };
    });
    return { ...context, groups };
  }
  return { ...context, files: files(input.files, 'files') };
}
