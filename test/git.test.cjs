const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseInput, createReview } = require('../dist/core.cjs');

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=Revmap Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' }).trim();
}
function repo(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'revmap-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  git(directory, 'init', '-q');
  return directory;
}
function write(root, name, text) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), text);
}
function commit(root) {
  git(root, 'add', '--all');
  git(root, 'commit', '-qm', 'snapshot');
  return git(root, 'rev-parse', 'HEAD');
}
function review(root, files, base) {
  return createReview(parseInput({ ...(base === undefined ? {} : { base }), files: files.map(file => typeof file === 'string' ? { path: file } : file) }), root);
}

test('input preserves explicit ordering and text, normalizes defaults, and parses JSON', () => {
  const input = { files: [{ path: 'b', comments: [{ text: ' note ', line: 2 }] }, { path: 'a', priority: 'high', comments: [{ text: 'file note' }] }] };
  const original = JSON.stringify(input);
  const result = parseInput(original);
  assert.deepEqual(result.files.map(file => file.path), ['b', 'a']);
  assert.equal(result.files[0].priority, 'normal');
  assert.deepEqual(result.files[0].comments, [{ text: ' note ', line: 2, endLine: 2, side: 'new' }]);
  assert.deepEqual(result.files[1].comments, [{ text: 'file note', side: 'new' }]);
  assert.equal(JSON.stringify(input), original);
});

test('input errors identify the field and reject malformed, unknown, duplicate, and unsafe values', () => {
  const cases = [
    ['{bad', /input: invalid JSON/], [null, /input:/], [[], /input:/],
    [{ files: [] }, /files:/], [{ files: ['a'] }, /files\[0\]:/],
    [{ files: Array(1) }, /files\[0\]:/],
    [{ files: [{ path: 'a', comments: Array(1) }] }, /files\[0\].comments\[0\]:/],
    [{ files: [{ path: 'a' }], extra: true }, /input.extra:/],
    [{ files: [{ path: 'a', extra: true }] }, /files\[0\].extra:/],
    [{ files: [{ path: 'a' }, { path: 'a' }] }, /files\[1\].path: duplicate/],
    [{ base: 3, files: [{ path: 'a' }] }, /base:/],
    [{ base: '', files: [{ path: 'a' }] }, /base:/],
    [{ base: 'a\0b', files: [{ path: 'a' }] }, /base:/],
    [{ files: [{ path: 'a', oldPath: '../b' }] }, /files\[0\].oldPath:/],
    [{ files: [{ path: 'a', oldPath: 'a' }] }, /files\[0\].oldPath: must differ/],
    [{ files: [{ path: 'a', priority: 'urgent' }] }, /files\[0\].priority:/],
    [{ files: [{ path: 'a', comments: null }] }, /files\[0\].comments:/],
  ];
  for (const unsafe of ['', ' ', '.', '..', '../x', 'a/../b', 'a/./b', 'a//b', 'a/', '/etc/passwd', 'C:\\file', '.git/config', 'dir/.GIT/config', 'a\0b', '\ud800']) {
    cases.push([{ files: [{ path: unsafe }] }, /files\[0\].path:/]);
  }
  for (const [note, field] of [
    [{ text: '' }, 'text'], [{ text: 4 }, 'text'], [{ text: 'ok', side: 'left' }, 'side'],
    [{ text: 'ok', line: 0 }, 'line'], [{ text: 'ok', line: 1.5 }, 'line'],
    [{ text: 'ok', line: '1' }, 'line'], [{ text: 'ok', endLine: 1 }, 'endLine'],
    [{ text: 'ok', line: 2, endLine: 1 }, 'endLine'], [{ text: 'ok', end: 1 }, 'end'],
  ]) cases.push([{ files: [{ path: 'a', comments: [note] }] }, new RegExp(`files\\[0\\].comments\\[0\\].${field}:`)]);
  for (const [value, expected] of cases) assert.throws(() => parseInput(value), expected);
});

test('zero commits: empty base, staged+unstaged final content, and only selected untracked files', t => {
  const root = repo(t);
  write(root, 'staged', 'staged\n');
  git(root, 'add', '--', 'staged');
  write(root, 'staged', 'final\n');
  write(root, 'selected', 'untracked\n');
  write(root, 'not-selected', 'never reviewed\n');
  const index = fs.readFileSync(path.join(root, '.git/index'));
  const result = review(root, ['selected', 'staged']);
  assert.equal(result.base, null);
  assert.equal(result.repository, path.basename(root));
  assert.deepEqual(result.files.map(file => [file.path, file.status, file.before, file.after.text]), [
    ['selected', 'added', null, 'untracked\n'], ['staged', 'added', null, 'final\n'],
  ]);
  assert.match(result.files[0].patch, /\+untracked/);
  assert.deepEqual(fs.readFileSync(path.join(root, '.git/index')), index);
  assert.throws(() => review(root, ['staged'], 'HEAD'), /base:.*does not resolve/);
});

test('one and multiple commits: default HEAD and explicit base include committed plus uncommitted edits', t => {
  const root = repo(t);
  write(root, 'file', 'one\n');
  const first = commit(root);
  assert.equal(review(root, ['file']).files[0].status, 'unchanged');
  write(root, 'file', 'two\n');
  const single = review(root, ['file']);
  assert.equal(single.base, first);
  assert.equal(single.files[0].before.text, 'one\n');
  assert.equal(single.files[0].after.text, 'two\n');
  const second = commit(root);
  write(root, 'file', 'three staged\n');
  git(root, 'add', '--', 'file');
  write(root, 'file', 'four final\n');
  const result = review(root, ['file'], 'HEAD~1');
  assert.equal(result.base, first);
  assert.equal(result.files[0].before.text, 'one\n');
  assert.equal(result.files[0].after.text, 'four final\n');
  assert.match(result.files[0].patch, /-one\n\+four final/);
  assert.equal(review(root, ['file']).base, second);
  assert.equal(review(root, ['file']).files[0].before.text, 'two\n');
  for (const base of ['missing-ref', '--help', 'HEAD:file']) assert.throws(() => review(root, ['file'], base), /base:.*choose an existing commit/);
});

test('deletions and renames are explicit, never inferred or added to scope', t => {
  const root = repo(t);
  write(root, 'old', 'same\n');
  commit(root);
  fs.renameSync(path.join(root, 'old'), path.join(root, 'new'));
  const explicit = review(root, [{ path: 'new', oldPath: 'old' }]).files[0];
  assert.equal(explicit.status, 'renamed');
  assert.equal(explicit.before.text, explicit.after.text);
  assert.deepEqual(review(root, ['new']).files.map(file => file.status), ['added']);
  const deleted = review(root, [{ path: 'old', comments: [{ text: 'removed', side: 'old', line: 1 }] }]).files[0];
  assert.equal(deleted.status, 'deleted');
  assert.equal(deleted.after, null);
  assert.match(deleted.patch, /-same/);
  assert.throws(() => review(root, ['absent']), /files\[0\].path: absent from both/);
  assert.throws(() => review(root, [{ path: 'new', oldPath: 'typo' }]), /files\[0\].oldPath: absent from the base/);
  assert.throws(() => review(root, [{ path: 'typo', oldPath: 'old' }]), /files\[0\].path: rename target is absent/);
});

test('empty addition/deletion, mode-only change, and unchanged empty files retain semantics', t => {
  const root = repo(t);
  write(root, 'empty', '');
  write(root, 'mode', 'same\n');
  write(root, 'delete-empty', '');
  fs.chmodSync(path.join(root, 'mode'), 0o644);
  commit(root);
  write(root, 'add-empty', '');
  fs.unlinkSync(path.join(root, 'delete-empty'));
  if (process.platform !== 'win32') fs.chmodSync(path.join(root, 'mode'), 0o755);
  const result = review(root, ['empty', 'add-empty', 'delete-empty', 'mode']).files;
  assert.equal(result[0].status, 'unchanged');
  assert.deepEqual(result[0].after, { text: '', mode: '100644', bytes: 0 });
  assert.equal(result[1].status, 'added');
  assert.match(result[1].patch, /new file mode/);
  assert.equal(result[2].status, 'deleted');
  assert.match(result[2].patch, /deleted file mode/);
  if (process.platform !== 'win32') {
    assert.equal(result[3].status, 'modified');
    assert.equal(result[3].before.mode, '100644');
    assert.equal(result[3].after.mode, '100755');
    assert.match(result[3].patch, /old mode 100644\nnew mode 100755/);
  }
});

test('CRLF, UTF-8 BOM, no-final-newline, and inclusive comment coordinates use exact snapshots', t => {
  const root = repo(t);
  write(root, 'file', '\ufeffold\r\nsecond');
  commit(root);
  write(root, 'file', '\ufeffnew\r\nsecond');
  const previousConfig = process.env.GIT_CONFIG_GLOBAL;
  const config = path.join(root, '.git/foreign-global-config');
  fs.writeFileSync(config, '[core]\n  autocrlf = input\n');
  process.env.GIT_CONFIG_GLOBAL = config;
  t.after(() => previousConfig === undefined ? delete process.env.GIT_CONFIG_GLOBAL : process.env.GIT_CONFIG_GLOBAL = previousConfig);
  const file = review(root, [{ path: 'file', comments: [
    { text: 'range', line: 1, endLine: 2 }, { text: 'old', side: 'old', line: 2 },
  ] }]).files[0];
  assert.equal(file.before.text, '\ufeffold\r\nsecond');
  assert.equal(file.after.text, '\ufeffnew\r\nsecond');
  assert.equal(file.after.bytes, Buffer.byteLength(file.after.text));
  assert.match(file.patch, /\\ No newline at end of file/);
  assert.match(file.patch, /\+\ufeffnew\r\n/);
  for (const [note, field] of [[{ line: 3 }, 'line'], [{ line: 1, endLine: 3 }, 'endLine']]) {
    assert.throws(() => review(root, [{ path: 'file', comments: [{ text: 'invalid', ...note }] }]), new RegExp(`files\\[0\\].comments\\[0\\].${field}: new side has 2 lines`));
  }
  write(root, 'empty', '');
  assert.throws(() => review(root, [{ path: 'empty', comments: [{ text: 'invalid', line: 1 }] }]), /new side has 0 lines/);
  fs.unlinkSync(path.join(root, 'file'));
  assert.throws(() => review(root, [{ path: 'file', comments: [{ text: 'invalid', line: 1 }] }]), /new side has 0 lines/);
});

test('NUL and invalid UTF-8 are binary metadata only; binary line comments fail', t => {
  const root = repo(t);
  write(root, 'nul', Buffer.from([0, 1, 2]));
  write(root, 'invalid-utf8', Buffer.from([0xff, 0xfe]));
  write(root, 'transition', 'original text\n');
  commit(root);
  write(root, 'nul', Buffer.from([0, 2, 3, 4]));
  write(root, 'transition', Buffer.from([0]));
  for (const file of review(root, ['nul', 'invalid-utf8', 'transition']).files) {
    assert.equal(file.kind, 'binary');
    assert.equal(file.before.text, null);
    assert.equal(file.after.text, null);
    assert.equal(file.patch, '');
  }
  assert.equal(review(root, ['nul']).files[0].after.bytes, 4);
  assert.throws(() => review(root, [{ path: 'nul', comments: [{ text: 'no', line: 1 }] }]), /comments\[0\].line: binary files/);
  assert.equal(review(root, [{ path: 'nul', comments: [{ text: 'file note' }] }]).files[0].comments.length, 1);
});

test('literal hostile filenames never become pathspecs, options, shell commands, or inferred files', { skip: process.platform === 'win32' }, t => {
  const root = repo(t);
  const names = ['-dash', ':(glob)**', '*.txt', 'name[1]', 'space here', 'tab\tfile', 'line\nbreak', 'a\\b', '$(touch PWNED)'];
  for (const name of names) write(root, name, `old ${name}\n`);
  commit(root);
  for (const name of names) write(root, name, `new ${name}\n`);
  const result = review(root, [...names].reverse());
  assert.deepEqual(result.files.map(file => file.path), [...names].reverse());
  for (const file of result.files) {
    assert.equal(file.before.text, `old ${file.path}\n`);
    assert.equal(file.after.text, `new ${file.path}\n`);
  }
  assert.equal(fs.existsSync(path.join(root, 'PWNED')), false);
  assert.throws(() => review(root, ['*.not-a-real-file']), /absent from both/);
  fs.mkdirSync(path.join(root, 'subdirectory'));
  assert.equal(review(path.join(root, 'subdirectory'), ['-dash']).files[0].path, '-dash');
});

test('symlinks expose only target text; ancestor traversal and directories are rejected', { skip: process.platform === 'win32' }, t => {
  const root = repo(t);
  const outside = repo(t);
  write(outside, 'secret', 'NEVER READ THIS');
  fs.symlinkSync(path.join(outside, 'secret'), path.join(root, 'link'));
  commit(root);
  fs.unlinkSync(path.join(root, 'link'));
  fs.symlinkSync('missing-target', path.join(root, 'link'));
  const file = review(root, ['link']).files[0];
  assert.equal(file.kind, 'symlink');
  assert.equal(file.before.mode, '120000');
  assert.equal(file.before.text, path.join(outside, 'secret'));
  assert.equal(file.after.text, 'missing-target');
  assert.doesNotMatch(file.patch, /NEVER READ THIS/);
  fs.symlinkSync(outside, path.join(root, 'escape'));
  fs.mkdirSync(path.join(root, 'inside'));
  fs.symlinkSync('inside', path.join(root, 'internal-link'));
  for (const selected of ['escape/secret', 'internal-link/absent']) {
    assert.throws(() => review(root, [selected]), /files\[0\].path: traverses a symlink/);
  }
  assert.throws(() => review(root, [{ path: 'link', oldPath: 'escape/secret' }]), /files\[0\].oldPath: traverses a symlink/);
  assert.throws(() => review(root, ['inside']), /directory.*list individual files/);
});

test('submodules compare only base/index/worktree commit refs, never recurse into dirty contents', t => {
  const root = repo(t);
  const source = repo(t);
  write(source, 'nested', 'first\n');
  const first = commit(source);
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'module');
  commit(root);
  const sub = path.join(root, 'module');
  write(sub, 'nested', 'second\n');
  commit(sub);
  git(root, 'add', '--', 'module');
  write(sub, 'nested', 'third\n');
  const third = commit(sub);
  write(sub, 'nested', 'dirty contents never exposed\n');
  const result = review(root, ['module']);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].kind, 'submodule');
  assert.equal(result.files[0].before.mode, '160000');
  assert.equal(result.files[0].before.text, `${first}\n`);
  assert.equal(result.files[0].after.text, `${third}\n`);
  assert.doesNotMatch(JSON.stringify(result), /dirty contents/);
  assert.throws(() => review(root, [{ path: 'module', comments: [{ text: 'invalid', line: 1 }] }]), /comments\[0\].line: submodules/);
  assert.equal(review(root, [{ path: 'module', comments: [{ text: 'file note' }] }]).files[0].comments.length, 1);
  git(root, 'submodule', 'deinit', '-q', '-f', '--', 'module');
  const uninitialized = review(root, ['module']).files[0];
  assert.equal(uninitialized.after.mode, '160000');
  assert.notEqual(uninitialized.after.text, `${third}\n`);
});

test('review does not mutate index/config/worktree or invoke external diff, textconv, fsmonitor, or hooks', { skip: process.platform === 'win32' }, t => {
  const root = repo(t);
  write(root, 'file', 'before\n');
  write(root, '.gitattributes', 'file diff=trap\n');
  commit(root);
  write(root, 'file', 'after\n');
  const marker = path.join(root, 'CALLED');
  const trap = path.join(root, '.git', 'trap');
  fs.writeFileSync(trap, `#!/bin/sh\ntouch '${marker.replaceAll("'", "'\\''")}'\nexit 99\n`, { mode: 0o755 });
  for (const key of ['diff.external', 'diff.trap.command', 'diff.trap.textconv', 'core.fsmonitor']) git(root, 'config', key, trap);
  const hooks = path.join(root, '.git/hooks');
  fs.copyFileSync(trap, path.join(hooks, 'post-index-change'));
  fs.chmodSync(path.join(hooks, 'post-index-change'), 0o755);
  const watched = ['.git/index', '.git/config', 'file'].map(name => [name, fs.readFileSync(path.join(root, name))]);
  const previousConfig = process.env.GIT_CONFIG_GLOBAL;
  const attributes = path.join(root, '.git/foreign-attributes');
  const config = path.join(root, '.git/foreign-global-config');
  fs.writeFileSync(attributes, '* text eol=lf filter=trap diff=trap\n');
  fs.writeFileSync(config, `[core]\n  attributesFile = ${JSON.stringify(attributes)}\n[filter "trap"]\n  clean = ${JSON.stringify(trap)}\n  required = true\n[diff "trap"]\n  textconv = ${JSON.stringify(trap)}\n`);
  process.env.GIT_CONFIG_GLOBAL = config;
  t.after(() => previousConfig === undefined ? delete process.env.GIT_CONFIG_GLOBAL : process.env.GIT_CONFIG_GLOBAL = previousConfig);
  assert.match(review(root, ['file']).files[0].patch, /\+after/);
  assert.equal(fs.existsSync(marker), false);
  for (const [name, bytes] of watched) assert.deepEqual(fs.readFileSync(path.join(root, name)), bytes);
});
