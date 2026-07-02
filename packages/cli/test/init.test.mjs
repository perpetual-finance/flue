import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { sanitizedChildEnv } from './child-env.mjs';

const cli = new URL('../dist/flue.js', import.meta.url);

async function runInit(args) {
	const env = sanitizedChildEnv({ NO_COLOR: '1' });
	delete env.FORCE_COLOR;
	const child = spawn(process.execPath, [cli.pathname, 'init', ...args], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env,
	});
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (chunk) => {
		stdout += chunk;
	});
	child.stderr.on('data', (chunk) => {
		stderr += chunk;
	});
	const [code] = await once(child, 'exit');
	return { code, stdout, stderr };
}

describe('flue init', () => {
	const dirs = [];
	function tempProjectDir() {
		const dir = mkdtempSync(path.join(tmpdir(), 'flue-init-'));
		dirs.push(dir);
		return dir;
	}
	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
	});

	it('scaffolds flue.config.ts, vite.config.ts, and src/app.ts for the node target', async () => {
		const dir = tempProjectDir();
		const result = await runInit(['--target', 'node', '--root', dir]);
		assert.equal(result.code, 0, result.stderr);

		const config = readFileSync(path.join(dir, 'flue.config.ts'), 'utf8');
		assert.ok(config.includes(`import { defineConfig } from '@flue/runtime/config';`));
		assert.ok(config.includes(`target: 'node'`));

		const viteConfig = readFileSync(path.join(dir, 'vite.config.ts'), 'utf8');
		assert.ok(viteConfig.includes(`import { flue } from '@flue/vite';`));
		assert.ok(viteConfig.includes('plugins: [flue()]'));
		assert.ok(!viteConfig.includes('cloudflare'));

		const app = readFileSync(path.join(dir, 'src', 'app.ts'), 'utf8');
		assert.ok(app.includes(`import { Hono } from 'hono';`));
		assert.ok(app.includes('export default app;'));

		assert.ok(!existsSync(path.join(dir, 'wrangler.jsonc')), 'node target writes no wrangler.jsonc');
	});

	it('adds cloudflare() and wrangler.jsonc for the cloudflare target', async () => {
		const dir = tempProjectDir();
		const result = await runInit(['--target', 'cloudflare', '--root', dir]);
		assert.equal(result.code, 0, result.stderr);

		const viteConfig = readFileSync(path.join(dir, 'vite.config.ts'), 'utf8');
		assert.ok(viteConfig.includes(`import { cloudflare } from '@cloudflare/vite-plugin';`));
		assert.ok(viteConfig.includes('plugins: [flue(), cloudflare()]'));

		const wrangler = readFileSync(path.join(dir, 'wrangler.jsonc'), 'utf8');
		assert.ok(wrangler.includes('"compatibility_flags": ["nodejs_compat"]'));
		assert.ok(wrangler.includes('new_sqlite_classes'));
	});

	it('refuses to run when a flue.config.* exists, unless --force is passed', async () => {
		const dir = tempProjectDir();
		writeFileSync(path.join(dir, 'flue.config.ts'), 'export default {};\n');

		const refused = await runInit(['--target', 'node', '--root', dir]);
		assert.equal(refused.code, 1);
		assert.ok(refused.stderr.includes('--force'), refused.stderr);

		const forced = await runInit(['--target', 'node', '--root', dir, '--force']);
		assert.equal(forced.code, 0, forced.stderr);
		const config = readFileSync(path.join(dir, 'flue.config.ts'), 'utf8');
		assert.ok(config.includes(`target: 'node'`));
	});

	it('never overwrites existing vite.config.ts or src/app.ts, even with --force', async () => {
		const dir = tempProjectDir();
		mkdirSync(path.join(dir, 'src'));
		writeFileSync(path.join(dir, 'vite.config.ts'), '// mine\n');
		writeFileSync(path.join(dir, 'src', 'app.ts'), '// my app\n');

		const result = await runInit(['--target', 'node', '--root', dir, '--force']);
		assert.equal(result.code, 0, result.stderr);
		assert.equal(readFileSync(path.join(dir, 'vite.config.ts'), 'utf8'), '// mine\n');
		assert.equal(readFileSync(path.join(dir, 'src', 'app.ts'), 'utf8'), '// my app\n');
		assert.ok(result.stderr.includes('kept existing'), result.stderr);
	});
});
