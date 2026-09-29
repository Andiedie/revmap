import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { TextDecoder } from 'node:util';
import { parseInput } from './input';
import { lines } from './model';
import type { Review, ReviewFile, ReviewInput, Version } from './model';

type Snapshot = { data: Buffer; mode: string };

function git(cwd: string, args: string[], allowed = [0]) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_ATTR_NOSYSTEM: '1', LC_ALL: 'C' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'GIT_NAMESPACE']) {
    delete (env as NodeJS.ProcessEnv)[key];
  }
  const result = spawnSync('git', ['--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-c', 'core.attributesFile=', ...args], {
    cwd, env,
    // ponytail: buffer Git output up to 256 MiB; stream snapshots if larger reviews are needed.
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw new Error(`Git: ${result.error.message}; check that Git is installed and the file fits in memory.`);
  if (result.status === null || !allowed.includes(result.status)) {
    throw new Error(`Git: ${result.stderr.toString('utf8').trim() || `exited with status ${result.status}`}`);
  }
  return result;
}

function output(cwd: string, args: string[]): string {
  return git(cwd, args).stdout.toString('utf8').replace(/\n$/, '');
}

function resolveBase(root: string, base?: string): string | null {
  const result = git(root, ['rev-parse', '--verify', '--end-of-options', `${base ?? 'HEAD'}^{commit}`], [0, 1, 128]);
  if (result.status === 0) return result.stdout.toString('utf8').trim();
  if (base === undefined) {
    const symbolic = git(root, ['symbolic-ref', '-q', 'HEAD'], [0, 1, 128]);
    if (symbolic.status === 0) {
      const ref = symbolic.stdout.toString('utf8').trim();
      if (git(root, ['show-ref', '--verify', '--quiet', ref], [0, 1, 128]).status === 1) return null;
    }
  }
  throw new Error(`base: ${JSON.stringify(base ?? 'HEAD')} does not resolve to a commit; choose an existing commit/ref or omit base in an unborn repository.`);
}

function baseSnapshot(root: string, base: string | null, path: string): Snapshot | null {
  if (base === null) return null;
  const entry = git(root, ['ls-tree', '-z', '--full-tree', base, '--', path]).stdout;
  if (!entry.length) return null;
  const tab = entry.indexOf(9);
  const [mode, type, oid] = entry.subarray(0, tab).toString('utf8').split(' ');
  if (!entry.subarray(tab + 1, entry.length - 1).equals(Buffer.from(path))) {
    throw new Error('expected one literal file path; select a file rather than a directory.');
  }
  if (type === 'tree') throw new Error('is a directory in the base; list individual files instead.');
  return { mode, data: type === 'commit' ? Buffer.from(`${oid}\n`) : git(root, ['cat-file', 'blob', oid]).stdout };
}

function stat(path: string) {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function safePath(root: string, path: string): string {
  let current = root;
  for (const part of path.split('/').slice(0, -1)) {
    current = join(current, part);
    const info = stat(current);
    if (!info) break;
    if (info.isSymbolicLink()) throw new Error('traverses a symlink; select the symlink itself or a path without symlink ancestors.');
    if (!info.isDirectory()) throw new Error('has a non-directory ancestor; select an existing file path.');
  }
  return join(root, path);
}

function worktreeSnapshot(root: string, path: string, absolute: string): Snapshot | null {
  const info = stat(absolute);
  if (!info) return null;
  if (info.isSymbolicLink()) return { mode: '120000', data: readlinkSync(absolute, { encoding: 'buffer' }) };
  if (info.isFile()) return { mode: info.mode & 0o111 ? '100755' : '100644', data: readFileSync(absolute) };
  if (info.isDirectory()) {
    const entries = git(root, ['ls-files', '--stage', '-z', '--', path]).stdout.toString('utf8').split('\0');
    const entry = entries.find(entry => entry.endsWith(`\t${path}`) && entry.startsWith('160000 ') && entry.split('\t')[0].endsWith(' 0'));
    if (!entry) throw new Error('is a directory, not a tracked submodule; list individual files instead.');
    let oid = entry.split(' ')[1];
    if (stat(join(absolute, '.git'))) {
      oid = output(absolute, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']);
    }
    return { mode: '160000', data: Buffer.from(`${oid}\n`) };
  }
  throw new Error('is not a regular file, symlink, or submodule; select a supported file.');
}

function version(snapshot: Snapshot | null): Version | null {
  if (!snapshot) return null;
  let text: string | null = null;
  if (!snapshot.data.includes(0)) {
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(snapshot.data); }
    catch { /* Invalid UTF-8 is binary, never replacement-character text. */ }
  }
  return { text, mode: snapshot.mode, bytes: snapshot.data.length };
}

function patch(before: Snapshot | null, after: Snapshot | null): string {
  const directory = mkdtempSync(join(tmpdir(), 'revmap-'));
  try {
    for (const [name, snapshot] of [['before', before], ['after', after]] as const) {
      const folder = join(directory, name);
      mkdirSync(folder);
      if (snapshot) {
        const file = join(folder, 'file');
        // Diff immutable contents, including link targets and submodule refs, never their destinations.
        writeFileSync(file, snapshot.data);
        chmodSync(file, snapshot.mode === '100755' ? 0o755 : 0o644);
      }
    }
    return git(directory, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--unified=3', '--', 'before', 'after'], [0, 1]).stdout.toString('utf8');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function createReview(input: ReviewInput, cwd = process.cwd()): Review {
  input = parseInput(input);
  let root: string;
  try { root = realpathSync(output(cwd, ['rev-parse', '--show-toplevel'])); }
  catch (error) { throw new Error(`repository: not an accessible Git worktree; run revmap inside a Git repository. ${(error as Error).message}`); }
  const base = resolveBase(root, input.base);
  const files = input.files.map((selected, index): ReviewFile => {
    const field = `files[${index}]`;
    let beforeSnapshot: Snapshot | null;
    let afterSnapshot: Snapshot | null;
    try {
      safePath(root, selected.oldPath ?? selected.path);
      beforeSnapshot = baseSnapshot(root, base, selected.oldPath ?? selected.path);
    } catch (error) {
      throw new Error(`${field}.${selected.oldPath === undefined ? 'path' : 'oldPath'}: ${(error as Error).message}`);
    }
    try { afterSnapshot = worktreeSnapshot(root, selected.path, safePath(root, selected.path)); }
    catch (error) { throw new Error(`${field}.path: ${(error as Error).message}`); }
    if (selected.oldPath !== undefined) {
      if (!beforeSnapshot) throw new Error(`${field}.oldPath: absent from the base; correct oldPath/base or omit oldPath for an added file.`);
      if (!afterSnapshot) throw new Error(`${field}.path: rename target is absent from the worktree; correct path or review the deleted source without oldPath.`);
    }
    if (!beforeSnapshot && !afterSnapshot) {
      throw new Error(`${field}.path: absent from both base and worktree; correct path/oldPath or choose a base containing the file.`);
    }
    const before = version(beforeSnapshot);
    const after = version(afterSnapshot);
    const binary = before?.text === null || after?.text === null;
    if (binary) {
      if (before) before.text = null;
      if (after) after.text = null;
    }
    const modes = [before?.mode, after?.mode];
    const kind = binary ? 'binary' : modes.includes('160000') ? 'submodule' : modes.includes('120000') ? 'symlink' : 'text';
    const comments = selected.comments ?? [];
    for (const [i, note] of comments.entries()) {
      if (note.line === undefined) continue;
      const anchor = `${field}.comments[${i}]`;
      if (binary || kind === 'submodule') throw new Error(`${anchor}.line: ${binary ? 'binary files' : 'submodules'} have no reviewable text lines; remove line/endLine for a file comment.`);
      const side = note.side ?? 'new';
      const count = lines((side === 'old' ? before : after)?.text).length;
      if (note.line > count || note.endLine! > count) {
        throw new Error(`${anchor}.${note.line > count ? 'line' : 'endLine'}: ${side} side has ${count} lines; choose a line within that side or remove line/endLine for a file comment.`);
      }
    }
    const status = !beforeSnapshot ? 'added' : !afterSnapshot ? 'deleted' :
      selected.oldPath !== undefined && selected.oldPath !== selected.path ? 'renamed' :
      beforeSnapshot.mode !== afterSnapshot.mode || !beforeSnapshot.data.equals(afterSnapshot.data) ? 'modified' : 'unchanged';
    return {
      path: selected.path,
      ...(selected.oldPath === undefined ? {} : { oldPath: selected.oldPath }),
      priority: selected.priority ?? 'normal', comments, status, kind, before, after,
      patch: binary || status === 'unchanged' ? '' : patch(beforeSnapshot, afterSnapshot),
    };
  });
  return { repository: basename(root), base, createdAt: new Date().toISOString(), files };
}
