import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
	defineConfig,
	discoverProjectEntry,
	FLUE_CONFIG_BASENAMES,
	loadFlueConfig,
	mergeFlueConfig,
	parseFlueConfig,
	resolveFlueConfigPath,
	resolveFlueProject,
	resolveSourceRoot,
} from '../src/config.ts';

const tempDirs: string[] = [];

function tempProject(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-config-test-'));
	tempDirs.push(dir);
	return dir;
}

function write(root: string, relative: string, content = ''): string {
	const absolute = path.join(root, relative);
	fs.mkdirSync(path.dirname(absolute), { recursive: true });
	fs.writeFileSync(absolute, content);
	return absolute;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe('defineConfig()', () => {
	it('returns the configuration unchanged', () => {
		const config = { target: 'node' as const, app: './src/app.ts' };
		expect(defineConfig(config)).toBe(config);
	});
});

describe('parseFlueConfig()', () => {
	it('accepts the full field set', () => {
		expect(
			parseFlueConfig({
				target: 'cloudflare',
				app: './src/app.ts',
				db: './src/db.ts',
				cloudflare: './src/cloudflare.ts',
				agents: 'src/**/*.ts',
			}),
		).toEqual({
			target: 'cloudflare',
			app: './src/app.ts',
			db: './src/db.ts',
			cloudflare: './src/cloudflare.ts',
			agents: 'src/**/*.ts',
		});
	});

	it('rejects unknown fields (the retired root/output/vite surface)', () => {
		expect(() => parseFlueConfig({ root: '.' }, 'flue.config.ts')).toThrow(
			/Invalid config in flue\.config\.ts/,
		);
		expect(() => parseFlueConfig({ output: 'dist' })).toThrow(/Invalid config/);
	});

	it('rejects an invalid target and empty paths', () => {
		expect(() => parseFlueConfig({ target: 'deno' })).toThrow(/Invalid config/);
		expect(() => parseFlueConfig({ app: '' })).toThrow(/Path must not be empty/);
	});

	it('rejects non-object values', () => {
		expect(() => parseFlueConfig(null, 'inline options')).toThrow(
			'inline options must be a config object',
		);
		expect(() => parseFlueConfig([], 'inline options')).toThrow('must be a config object');
	});
});

describe('mergeFlueConfig()', () => {
	it('lets defined inline fields win and undefined fields fall through', () => {
		expect(
			mergeFlueConfig(
				{ target: 'node', app: './src/app.ts', agents: 'src/**/*.ts' },
				{ target: 'cloudflare', db: './src/db.ts' },
			),
		).toEqual({
			target: 'cloudflare',
			app: './src/app.ts',
			db: './src/db.ts',
			cloudflare: undefined,
			agents: 'src/**/*.ts',
		});
	});
});

describe('resolveFlueConfigPath()', () => {
	it('discovers config basenames in priority order (ts first)', () => {
		const root = tempProject();
		write(root, 'flue.config.js');
		write(root, 'flue.config.ts');

		expect(resolveFlueConfigPath({ cwd: root })).toBe(path.join(root, 'flue.config.ts'));
		expect(FLUE_CONFIG_BASENAMES[0]).toBe('flue.config.ts');
	});

	it('returns undefined when no config exists', () => {
		expect(resolveFlueConfigPath({ cwd: tempProject() })).toBeUndefined();
	});

	it('throws for an explicit config path that does not exist', () => {
		expect(() =>
			resolveFlueConfigPath({ cwd: tempProject(), configFile: 'missing.config.ts' }),
		).toThrow('Config file not found: missing.config.ts');
	});
});

describe('loadFlueConfig()', () => {
	it('loads and validates the default export of a discovered config module', async () => {
		const root = tempProject();
		write(root, 'flue.config.mjs', "export default { target: 'node', agents: 'src/**/*.ts' };\n");

		const loaded = await loadFlueConfig({ cwd: root });

		expect(loaded.configPath).toBe(path.join(root, 'flue.config.mjs'));
		expect(loaded.config).toEqual({ target: 'node', agents: 'src/**/*.ts' });
	});

	it('returns an empty config when the project has no config file', async () => {
		expect(await loadFlueConfig({ cwd: tempProject() })).toEqual({
			configPath: undefined,
			config: {},
		});
	});

	it('rejects a config module without an object default export', async () => {
		const root = tempProject();
		write(root, 'flue.config.mjs', 'export default 42;\n');

		await expect(loadFlueConfig({ cwd: root })).rejects.toThrow(
			'flue.config.mjs must export a config object as the default export',
		);
	});

	it('surfaces field-level validation errors with the config path', async () => {
		const root = tempProject();
		write(root, 'flue.config.mjs', "export default { output: 'dist' };\n");

		await expect(loadFlueConfig({ cwd: root })).rejects.toThrow(/Invalid config in flue\.config\.mjs/);
	});
});

describe('resolveSourceRoot()', () => {
	it('prefers .flue/, then src/, then the root itself', () => {
		const withFlue = tempProject();
		fs.mkdirSync(path.join(withFlue, '.flue'));
		fs.mkdirSync(path.join(withFlue, 'src'));
		expect(resolveSourceRoot(withFlue)).toBe(path.join(withFlue, '.flue'));

		const withSrc = tempProject();
		fs.mkdirSync(path.join(withSrc, 'src'));
		expect(resolveSourceRoot(withSrc)).toBe(path.join(withSrc, 'src'));

		const bare = tempProject();
		expect(resolveSourceRoot(bare)).toBe(bare);
	});

	it('ignores a .flue regular file', () => {
		const root = tempProject();
		write(root, '.flue');
		expect(resolveSourceRoot(root)).toBe(root);
	});
});

describe('discoverProjectEntry()', () => {
	it('honors the ts > mts > js > mjs extension priority', () => {
		const root = tempProject();
		write(root, 'app.mjs');
		write(root, 'app.mts');
		expect(discoverProjectEntry(root, 'app')).toBe(path.join(root, 'app.mts'));

		write(root, 'app.ts');
		expect(discoverProjectEntry(root, 'app')).toBe(path.join(root, 'app.ts'));
	});

	it('returns undefined when no entry exists', () => {
		expect(discoverProjectEntry(tempProject(), 'db')).toBeUndefined();
	});
});

describe('resolveFlueProject()', () => {
	it('discovers default entries beneath the source root', () => {
		const root = tempProject();
		write(root, 'src/app.ts');
		write(root, 'src/db.mts');

		const project = resolveFlueProject({ root, config: { target: 'node' } });

		expect(project).toEqual({
			root,
			sourceRoot: path.join(root, 'src'),
			target: 'node',
			app: path.join(root, 'src/app.ts'),
			db: path.join(root, 'src/db.mts'),
			cloudflare: undefined,
			agents: undefined,
		});
	});

	it('resolves explicit entries from the config file directory', () => {
		const root = tempProject();
		const configPath = write(root, 'flue.config.ts');
		const appPath = write(root, 'server/main.ts');

		const project = resolveFlueProject({
			root,
			configPath,
			config: { app: './server/main.ts' },
		});

		expect(project.app).toBe(appPath);
	});

	it('throws when an explicit entry does not exist', () => {
		const root = tempProject();
		expect(() => resolveFlueProject({ root, config: { app: './missing/app.ts' } })).toThrow(
			'Configured `app` entry not found: ./missing/app.ts',
		);
	});

	it('passes the agents glob through verbatim', () => {
		const root = tempProject();
		const project = resolveFlueProject({ root, config: { agents: 'src/agents/**/*.ts' } });
		expect(project.agents).toBe('src/agents/**/*.ts');
	});
});
