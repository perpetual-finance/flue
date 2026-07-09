import { describe, expect, it, vi } from 'vitest';
import {
	defineAgent,
	observe,
	SessionAlreadyExistsError,
	SessionNotFoundError,
} from '../src/index.ts';
import { createFlueContext, type FlueContextConfig, resolveModel } from '../src/internal.ts';
import type { FlueEvent, FlueObservation, SessionEnv } from '../src/types.ts';

describe('FlueHarness', () => {
	it('uses the default harness name when init() receives no name', async () => {
		const harness = await createContext(createEnv()).initializeRootHarness(
			defineAgent(() => undefined, { model: 'anthropic/claude-haiku-4-5' }),
		);

		expect(harness.name).toBe('default');
	});

	it('exposes sandbox filesystem operations when a harness is initialized', async () => {
		const harness = await createContext(createEnv()).initializeRootHarness(
			defineAgent(() => undefined, { model: 'anthropic/claude-haiku-4-5' }),
		);
		const session = await harness.session('workspace');

		await harness.sandbox.mkdir('drafts', { recursive: true });
		await harness.sandbox.writeFile('drafts/report.txt', 'reviewed');
		await session.fs.writeFile('drafts/summary.txt', new Uint8Array([100, 111, 110, 101]));

		await expect(harness.sandbox.readFile('drafts/report.txt')).resolves.toBe('reviewed');
		await expect(harness.sandbox.readFileBuffer('drafts/summary.txt')).resolves.toEqual(
			new Uint8Array([100, 111, 110, 101]),
		);
		await expect(harness.sandbox.stat('drafts/report.txt')).resolves.toMatchObject({
			isFile: true,
			isDirectory: false,
			size: 8,
		});
		await expect(harness.sandbox.readdir('drafts')).resolves.toEqual(['report.txt', 'summary.txt']);
		await expect(harness.sandbox.exists('drafts/report.txt')).resolves.toBe(true);

		await harness.sandbox.rm('drafts', { recursive: true });

		await expect(harness.sandbox.exists('drafts/report.txt')).resolves.toBe(false);
	});

	it('runs a command straight through the live sandbox when sandbox.exec() is called', async () => {
		const exec = vi.fn(async () => ({ stdout: 'checked\n', stderr: '', exitCode: 0 }));
		const harness = await createContext(createEnv({ exec })).initializeRootHarness(
			defineAgent(() => undefined, { model: 'anthropic/claude-haiku-4-5' }),
		);

		await expect(harness.sandbox.exec('printf checked')).resolves.toEqual({
			stdout: 'checked\n',
			stderr: '',
			exitCode: 0,
		});
		// Unlike the old flattened harness.shell(), sandbox.exec() is the raw
		// SessionEnv the sandbox factory produced — no operation wrapper, no
		// injected AbortSignal, no options object invented on the caller's behalf.
		expect(exec).toHaveBeenCalledWith('printf checked');
	});

	it('never records events or observations for a direct sandbox.exec() call, even with env values', async () => {
		const exec = vi.fn(async () => ({ stdout: 'configured', stderr: '', exitCode: 0 }));
		const events: FlueEvent[] = [];
		const observations: FlueObservation[] = [];
		const ctx = createContext(createEnv({ exec }));
		ctx.setEventCallback((event) => {
			events.push(event);
		});
		const stopObserving = observe((event, context) => {
			if (context === ctx) observations.push(event);
		});
		const harness = await ctx.initializeRootHarness(defineAgent(() => undefined, { model: 'anthropic/claude-haiku-4-5' }));

		try {
			await harness.sandbox.exec('printenv TOKEN', { env: { TOKEN: 'secret-value' }, cwd: '/repo' });

			// The real values reach the sandbox unchanged...
			expect(exec).toHaveBeenCalledWith('printenv TOKEN', {
				env: { TOKEN: 'secret-value' },
				cwd: '/repo',
			});
			// ...but, per FlueHarness.sandbox's contract ("operations on it are
			// never recorded in a conversation"), a direct sandbox.exec() call
			// produces no tool events at all — unlike session.shell(), there is
			// nothing to redact and nothing that could leak the secret.
			expect(events).toHaveLength(0);
			expect(observations).toHaveLength(0);
			expect(JSON.stringify(observations)).not.toContain('secret-value');
			expect(JSON.stringify(events)).not.toContain('secret-value');
		} finally {
			stopObserving();
		}
	});

	describe('session()', () => {

		it('hides internal runtime members when a session is handed to user code', async () => {
				const harness = await createContext(createEnv()).initializeRootHarness(
				defineAgent(() => undefined, { model: 'anthropic/claude-haiku-4-5' }),
			);

			const session = await harness.session();

			expect(Object.keys(session).sort()).toEqual([
				'compact',
				'conversationId',
				'fs',
				'name',
				'prompt',
				'shell',
				'skill',
				'task',
			]);
			const runtimeObject = session as unknown as Record<string, unknown>;
			expect(runtimeObject.abort).toBeUndefined();
			expect(runtimeObject.close).toBeUndefined();
			expect(runtimeObject.metadata).toBeUndefined();
			expect(runtimeObject.processSubmissionInput).toBeUndefined();
		});




	});

	describe('sessions', () => {
		it('rejects a missing session when get() targets an unknown name', async () => {
				const harness = await createContext(createEnv()).initializeRootHarness(
				defineAgent(() => undefined, { model: 'anthropic/claude-haiku-4-5' }),
			);

			await expect(harness.sessions.get('missing-review')).rejects.toThrow(SessionNotFoundError);
		});

		it('rejects an existing session when create() targets an existing name', async () => {
				const harness = await createContext(createEnv()).initializeRootHarness(
				defineAgent(() => undefined, { model: 'anthropic/claude-haiku-4-5' }),
			);
			await harness.session('review');

			await expect(harness.sessions.create('review')).rejects.toThrow(SessionAlreadyExistsError);
		});

		it('rejects reserved task names when ordinary session APIs receive an internal session name', async () => {
				const harness = await createContext(createEnv()).initializeRootHarness(
				defineAgent(() => undefined, { model: 'anthropic/claude-haiku-4-5' }),
			);

			await expect(harness.session('task:default:child')).rejects.toThrow(
				'Session names beginning with "task:" are reserved for delegated tasks',
			);
			});
	});
});



function createContext(
	env: SessionEnv,
	overrides: Partial<FlueContextConfig> = {},
) {
	return createFlueContext({
		id: 'agent-instance',
		env: {},
		agentConfig: {
			resolveModel: () => resolveModel('anthropic/claude-haiku-4-5'),
		},
		createDefaultEnv: async () => env,
		...overrides,
	});
}

function createEnv(overrides: Partial<SessionEnv> = {}): SessionEnv {
	const files = new Map<string, string | Uint8Array>();
	const directories = new Set(['/repo']);
	const resolvePath = (path: string) =>
		normalizePath(path.startsWith('/') ? path : `/repo/${path}`);

	return {
		cwd: '/repo',
		resolvePath,
		exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
		readFile: async (path) => {
			const content = files.get(resolvePath(path));
			if (content === undefined) throw new Error(`missing file: ${path}`);
			return typeof content === 'string' ? content : new TextDecoder().decode(content);
		},
		readFileBuffer: async (path) => {
			const content = files.get(resolvePath(path));
			if (content === undefined) throw new Error(`missing file: ${path}`);
			return typeof content === 'string' ? new TextEncoder().encode(content) : content;
		},
		writeFile: async (path, content) => {
			files.set(resolvePath(path), content);
		},
		stat: async (path) => {
			const resolved = resolvePath(path);
			const content = files.get(resolved);
			if (content === undefined && !directories.has(resolved))
				throw new Error(`missing path: ${path}`);
			return {
				isFile: content !== undefined,
				isDirectory: directories.has(resolved),
				isSymbolicLink: false,
				size:
					content === undefined
						? 0
						: typeof content === 'string'
							? new TextEncoder().encode(content).byteLength
							: content.byteLength,
				mtime: new Date(0),
			};
		},
		readdir: async (path) => {
			const resolved = resolvePath(path);
			const prefix = resolved === '/' ? '/' : `${resolved}/`;
			const entries = new Set<string>();
			for (const entry of [...directories, ...files.keys()]) {
				if (!entry.startsWith(prefix)) continue;
				const name = entry.slice(prefix.length).split('/')[0];
				if (name) entries.add(name);
			}
			return [...entries].sort();
		},
		exists: async (path) => {
			const resolved = resolvePath(path);
			return files.has(resolved) || directories.has(resolved);
		},
		mkdir: async (path) => {
			directories.add(resolvePath(path));
		},
		rm: async (path, options) => {
			const resolved = resolvePath(path);
			for (const file of files.keys()) {
				if (file === resolved || (options?.recursive && file.startsWith(`${resolved}/`))) {
					files.delete(file);
				}
			}
			for (const directory of directories) {
				if (
					directory === resolved ||
					(options?.recursive && directory.startsWith(`${resolved}/`))
				) {
					directories.delete(directory);
				}
			}
		},
		...overrides,
	};
}

function normalizePath(path: string): string {
	const segments: string[] = [];
	for (const segment of path.split('/')) {
		if (!segment || segment === '.') continue;
		if (segment === '..') segments.pop();
		else segments.push(segment);
	}
	return `/${segments.join('/')}`;
}
