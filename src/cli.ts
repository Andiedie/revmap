import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { pathToFileURL } from 'url';
import { parseInput } from './input';
import { createReview } from './git';
import { renderHTML } from './html';

declare const PACKAGE_VERSION: string;

function openBrowser(url: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true, detached: true });
    // Some desktop openers stay alive with the browser; the review must not need a resident CLI.
    const timer = setTimeout(() => { child.unref(); resolve(); }, 1500);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(`revmap — a local, agent-guided review map\n\nUsage: revmap --input <review.json> [--no-open]\n\nRun inside a Git repository. Input paths are relative to its root.\n--input    JSON file containing {"base"?: "commit", "files": [{"path": "src/app.ts"}]}\n           Alternatively use ordered groups with title, comments and files; see the bundled Skill.\n--no-open  Generate HTML without launching the default browser.\n--version  Print the package version.\n\nWithout base: HEAD to working tree, including selected untracked files.\nWith base: that commit to working tree, including uncommitted changes.\nThe temporary HTML is self-contained; review feedback saves in browser-local storage.`);
    return;
  }
  if (args.length === 1 && args[0] === '--version') { console.log(PACKAGE_VERSION); return; }
  let inputPath = '', open = true;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && !inputPath && args[i + 1] && !args[i + 1].startsWith('--')) inputPath = args[++i];
    else if (args[i] === '--no-open' && open) open = false;
    else throw new Error(`Unexpected argument ${JSON.stringify(args[i])}. Use revmap --input <review.json>; see --help.`);
  }
  if (!inputPath) throw new Error('Missing --input. Write a review JSON file, then run revmap --input <file>.');
  let source: string;
  try { source = fs.readFileSync(inputPath, 'utf8'); }
  catch (error) { throw new Error(`Cannot read input ${JSON.stringify(inputPath)}. Check the path and permissions. ${(error as Error).message}`); }
  const review = createReview(parseInput(source.replace(/^\uFEFF/, '')));
  const html = renderHTML(review);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'revmap-'));
  const output = path.join(directory, 'review.html');
  try { fs.writeFileSync(output, html, { encoding: 'utf8', mode: 0o600 }); }
  catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
  const url = pathToFileURL(output).href;
  console.log(url);
  if (open) {
    try { await openBrowser(url); }
    catch (error) { console.error(`revmap: The review was generated, but the browser could not open: ${(error as Error).message}\nOpen the file URL above manually.`); }
  }
}
main().catch(error => { console.error(`revmap: ${(error as Error).message}`); process.exitCode = 1; });
