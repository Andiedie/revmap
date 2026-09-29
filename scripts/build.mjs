import { build } from 'esbuild';
import { readFile, writeFile, readdir, mkdir, chmod } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
const client = await build({ entryPoints: ['src/web.ts'], bundle: true, minify: true, platform: 'browser', target: 'es2020', write: false, legalComments: 'inline', metafile: true });
const css = await readFile('src/web.css', 'utf8');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const define = { CLIENT_JS: JSON.stringify(client.outputFiles[0].text), CLIENT_CSS: JSON.stringify(css), PACKAGE_VERSION: JSON.stringify(pkg.version) };
await build({ entryPoints: ['src/cli.ts'], outfile: 'dist/cli.cjs', bundle: true, platform: 'node', target: 'node14', format: 'cjs', define, banner: { js: '#!/usr/bin/env node' } });
await build({ entryPoints: ['src/core.ts'], outfile: 'dist/core.cjs', bundle: true, platform: 'node', target: 'node14', format: 'cjs', define });
await chmod('dist/cli.cjs', 0o755);
const packages = new Set(Object.keys(client.metafile.inputs).filter(file => file.startsWith('node_modules/')).map(file => file.split('/')[1]));
const notices = [];
for (const name of [...packages].sort()) {
  const dir = `node_modules/${name}`;
  const metadata = JSON.parse(await readFile(`${dir}/package.json`, 'utf8'));
  const license = (await readdir(dir)).find(file => /^(license|copying)([.-]|$)/i.test(file));
  if (!license) throw new Error(`Missing bundled license for ${name}`);
  notices.push(`${name} ${metadata.version}\n${'='.repeat(60)}\n${await readFile(`${dir}/${license}`, 'utf8')}`);
}
await writeFile('dist/THIRD_PARTY_NOTICES.txt', notices.join('\n\n'));
