const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { fileURLToPath } = require('node:url');
const cli = path.resolve('dist/cli.cjs');

test('CLI reports actionable errors, generates private standalone HTML, and preserves output after opener failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revmap-cli-test-'));
  const outputs = [];
  const run = (args, env = process.env) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, env, encoding: 'utf8' });
  try {
    assert.match(run(['--help']).stdout, /--input/);
    assert.equal(run([]).status, 1);
    assert.match(run([]).stderr, /Missing --input/);
    assert.equal(run(['--surprise']).status, 1);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'file.txt'), 'example\n');
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ files: [] }');
    assert.match(run(['--input', 'bad.json']).stderr, /invalid JSON/);
    fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify({ files: [{ path: 'file.txt' }] }));
    const result = run(['--input', 'review.json', '--no-open']);
    assert.equal(result.status, 0, result.stderr);
    const output = fileURLToPath(result.stdout.trim()); outputs.push(path.dirname(output));
    assert.ok(fs.readFileSync(output, 'utf8').includes('Content-Security-Policy'));
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(output).mode & 0o777, 0o600);
      const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      fs.writeFileSync(path.join(bin, opener), '#!/bin/sh\nexit 42\n', { mode: 0o755 });
      const fallback = run(['--input', 'review.json'], { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` });
      assert.equal(fallback.status, 0);
      assert.match(fallback.stderr, /Open the file URL above manually/);
      const preserved = fileURLToPath(fallback.stdout.trim()); outputs.push(path.dirname(preserved));
      assert.ok(fs.existsSync(preserved));
    }
  } finally {
    for (const output of outputs) fs.rmSync(output, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
