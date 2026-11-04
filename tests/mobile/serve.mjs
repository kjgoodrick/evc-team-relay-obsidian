import { build } from 'esbuild';
import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../..'), output = resolve(root, 'dist/mobile-harness');
await mkdir(output, { recursive: true });
await build({ entryPoints: [resolve(here, 'entry.mjs')], outfile: resolve(output, 'bundle.js'), bundle: true, format: 'esm', platform: 'browser', target: 'safari16', plugins: [{ name: 'substitute-host', setup(b) { b.onResolve({ filter: /^obsidian$/ }, () => ({ path: resolve(here, 'obsidian-adapter.mjs') })); b.onResolve({ filter: /platformFetch$/ }, () => ({ path: resolve(here, 'fixture-network.mjs') })); } }] });
for (const n of ['index.html', 'host.css'])
    await copyFile(resolve(here, n), resolve(output, n));
await copyFile(resolve(root, 'styles.css'), resolve(output, 'production.css'));
if (!process.argv.includes('--build-only'))
    createServer(async (req, res) => { const name = ({ '/': 'index.html', '/bundle.js': 'bundle.js', '/host.css': 'host.css', '/production.css': 'production.css' })[req.url?.split('?')[0]]; if (!name) {
        res.writeHead(404);
        res.end();
        return;
    } res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html'); res.end(await readFile(resolve(output, name))); }).listen(4177, '127.0.0.1', () => console.log('Production component harness: http://127.0.0.1:4177 (rebuild with --build-only, then reload Safari)'));
