/**
 * The `flue()` Vite plugin — makes a Vite project a Flue application.
 *
 * ```ts
 * // vite.config.ts
 * import { defineConfig } from 'vite';
 * import { flue } from '@flue/vite';
 * export default defineConfig({ plugins: [flue()] });
 * ```
 *
 * The plugin options ARE the Flue config: `flue(config?: FlueConfig)` merges
 * inline values over a discovered `flue.config.*` (inline wins). The target
 * defaults to `'cloudflare'` when `@cloudflare/vite-plugin` is present in the
 * resolved plugin array, `'node'` otherwise; an explicit `target` overrides
 * detection. Phase 3 ships the Node target only.
 *
 * Virtual modules (resolved only inside graphs this plugin serves):
 *
 * - `virtual:flue/app`    → the resolved app entry (REQUIRED to exist)
 * - `virtual:flue/db`     → the resolved db entry, or a default-adapter stub
 * - `virtual:flue/agents` → the scanned `'use agent'` module set
 * - `virtual:flue/server` → the Node bootstrap (real code in this package)
 */
import * as fs from 'node:fs';
import { builtinModules } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FlueConfig, ResolvedFlueProject } from '@flue/runtime/config';
import {
	FLUE_CONFIG_BASENAMES,
	loadFlueConfig,
	mergeFlueConfig,
	parseFlueConfig,
	resolveFlueProject,
} from '@flue/runtime/config';
import {
	normalizePath,
	type Plugin,
	type PluginOption,
	type UserConfig,
	type ViteDevServer,
} from 'vite';
import {
	AGENT_DIRECTIVE,
	type AgentScanResult,
	isAgentModulePath,
	scanAgents,
} from './agent-scan.ts';
import {
	type DependencyResolverState,
	flueDependencyResolverPlugin,
	getUserExternals,
} from './dependency-resolver.ts';
import { importAttributePlugin } from './import-attribute-plugin.ts';
import { createNodeDevController } from './node-dev.ts';
import { transformUseAgentModule } from './use-agent-transform.ts';

/** The resolved Flue project, exposed on the core plugin's `api` field. */
export interface FlueResolvedProjectInfo {
	/** The merged Flue config (discovered file + inline `flue()` options). */
	readonly config: FlueConfig;
	/** Absolute path of the discovered `flue.config.*`, if any. */
	readonly configPath: string | undefined;
	/** The resolved filesystem layout (root, source root, entries). */
	readonly project: ResolvedFlueProject;
	/** The selected target (explicit config, or plugin-array auto-detection). */
	readonly target: 'node' | 'cloudflare';
	/**
	 * The scanned `'use agent'` module set. Live in dev: reflects the latest
	 * watcher-driven re-scan.
	 */
	readonly agents: readonly AgentScanResult[];
}

/**
 * The core plugin's `api` field — a stable read surface for other tools
 * (`flue run` may consume this later). `resolved` is `undefined` until Vite
 * config resolution completes.
 */
export interface FlueVitePluginApi {
	readonly resolved: FlueResolvedProjectInfo | undefined;
}

const VIRTUAL_APP = 'virtual:flue/app';
const VIRTUAL_DB = 'virtual:flue/db';
const VIRTUAL_AGENTS = 'virtual:flue/agents';
const VIRTUAL_SERVER = 'virtual:flue/server';
const RESOLVED_DB_STUB = '\0virtual:flue/db';
const RESOLVED_AGENTS = '\0virtual:flue/agents';

/** Externals the Node target always keeps out of the bundle (optional native deps). */
const NODE_TARGET_EXTERNALS = ['node-liblzma', '@mongodb-js/zstd'];

/**
 * Dev-server CORS defaults, matching the legacy dev listener: reflect the
 * request Origin (credential-safe — never `*`-with-credentials) and expose
 * the durable-stream coordination headers so separate-origin SPAs can resume
 * stream offsets. Deployed servers keep CORS as an application concern.
 */
const DEV_CORS = {
	origin: true,
	credentials: true,
	exposedHeaders: ['Stream-Next-Offset', 'Stream-Up-To-Date', 'Location'],
	maxAge: 86400,
};

interface FluePluginState {
	root: string;
	configPath: string | undefined;
	mergedConfig: FlueConfig;
	project: ResolvedFlueProject;
	agents: AgentScanResult[];
	/** Scan results keyed by normalized (posix) absolute file path. */
	agentsByPath: Map<string, AgentScanResult>;
	explicitTarget: 'node' | 'cloudflare' | undefined;
	target: 'node' | 'cloudflare';
	/** Serializes watcher-driven re-scans. */
	watchQueue: Promise<void>;
	resolved: FlueResolvedProjectInfo | undefined;
}

export function flue(config: FlueConfig = {}): Plugin[] {
	const inlineConfig = parseFlueConfig(config, 'inline flue() options');
	const bootstrap = resolveBootstrapPaths();

	const state: FluePluginState = {
		root: '',
		configPath: undefined,
		mergedConfig: {},
		project: undefined as unknown as ResolvedFlueProject,
		agents: [],
		agentsByPath: new Map(),
		explicitTarget: undefined,
		target: 'node',
		watchQueue: Promise.resolve(),
		resolved: undefined,
	};
	const resolverState: DependencyResolverState = {
		root: undefined,
		external: false,
		importers: undefined,
	};

	const updateAgents = (agents: AgentScanResult[]): void => {
		state.agents = agents;
		state.agentsByPath = new Map(agents.map((agent) => [normalizePath(agent.filePath), agent]));
	};

	const api: FlueVitePluginApi = {
		get resolved() {
			return state.resolved;
		},
	};

	// Serialized dev-server restarts. Vite's server.restart() returns the
	// in-flight promise when one is already running, which would silently drop
	// a flue.config edit landing mid-restart; queueing at plugin scope (the
	// plugin instances survive restarts) guarantees a follow-up restart runs.
	let restartQueue = Promise.resolve();
	let restartPending = false;
	const requestRestart = (server: ViteDevServer): void => {
		if (restartPending) return;
		restartPending = true;
		restartQueue = restartQueue
			.then(async () => {
				restartPending = false;
				await server.restart();
			})
			.catch((error) => {
				server.config.logger.error(
					`[flue] Dev server restart failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
	};

	const corePlugin: Plugin = {
		name: 'flue',
		api,

		async config(userConfig, env) {
			const root = path.resolve(userConfig.root ?? process.cwd());
			const loaded = await loadFlueConfig({ cwd: root });
			const merged = mergeFlueConfig(loaded.config, inlineConfig);
			const project = resolveFlueProject({
				root,
				config: merged,
				configPath: loaded.configPath,
			});
			if (!project.app) throw missingAppEntryError(project);
			updateAgents(await scanAgents({ sourceRoot: project.sourceRoot, agents: project.agents }));
			state.root = root;
			state.configPath = loaded.configPath;
			state.mergedConfig = merged;
			state.project = project;
			state.explicitTarget = merged.target;

			// Preliminary target detection from the user config's plugin array;
			// `configResolved` re-detects against the final resolved array (the
			// Phase 4 seam) and is authoritative.
			const preliminaryTarget =
				merged.target ?? (containsCloudflarePlugin(userConfig.plugins) ? 'cloudflare' : 'node');
			state.target = preliminaryTarget;

			const isBuild = env.command === 'build';
			resolverState.root = root;
			resolverState.external = !isBuild;
			resolverState.importers = isBuild ? undefined : [bootstrap.server];

			// The Cloudflare adapter lands in Phase 4; contribute no Node build
			// config for it and let configResolved render the diagnostic.
			if (preliminaryTarget !== 'node') return { appType: 'custom' };

			if (isBuild) {
				return {
					appType: 'custom',
					build: {
						ssr: bootstrap.entry,
						outDir: userConfig.build?.outDir ?? 'dist',
						emptyOutDir: userConfig.build?.emptyOutDir ?? true,
						sourcemap: userConfig.build?.sourcemap ?? true,
						target: 'node22',
						rolldownOptions: {
							external: [
								...NODE_TARGET_EXTERNALS,
								...getUserExternals(root),
								...builtinModules,
								...builtinModules.map((name) => `node:${name}`),
							],
							output: { entryFileNames: 'server.mjs', format: 'es' },
						},
					},
				} satisfies UserConfig;
			}
			return {
				appType: 'custom',
				server: { cors: userConfig.server?.cors ?? DEV_CORS },
			} satisfies UserConfig;
		},

		configResolved(resolved) {
			if (resolved.plugins.filter((plugin) => plugin.name === 'flue').length > 1) {
				throw new Error('[flue] flue() was added to the Vite config more than once.');
			}
			if (normalizePath(path.resolve(resolved.root)) !== normalizePath(state.root)) {
				throw new Error(
					`[flue] The resolved Vite root (${resolved.root}) differs from the root flue() resolved its project against (${state.root}). ` +
						'Another plugin changed `root` after flue() ran; set `root` in the Vite config itself instead.',
				);
			}
			// Authoritative target detection: the full resolved plugin array is
			// visible here. This is the seam Phase 4 extends with the Cloudflare
			// adapter handoff.
			const detected = resolved.plugins.some((plugin) => isCloudflarePluginName(plugin.name))
				? 'cloudflare'
				: 'node';
			const target = state.explicitTarget ?? detected;
			state.target = target;
			state.resolved = {
				config: state.mergedConfig,
				configPath: state.configPath,
				project: state.project,
				target,
				get agents() {
					return state.agents;
				},
			};
			if (target === 'cloudflare') {
				throw new Error(
					'[flue] The Cloudflare target lands in a later phase of the Vite-plugin redesign. ' +
						"Remove @cloudflare/vite-plugin (or set `target: 'node'` in flue.config.ts) to build for Node, " +
						'or stay on the legacy `flue dev`/`flue build` commands for Cloudflare in the meantime.',
				);
			}
		},

		resolveId(source) {
			switch (source) {
				case VIRTUAL_APP: {
					const app = state.project?.app;
					return app ? normalizePath(app) : undefined;
				}
				case VIRTUAL_DB: {
					const db = state.project?.db;
					return db ? normalizePath(db) : RESOLVED_DB_STUB;
				}
				case VIRTUAL_AGENTS:
					return RESOLVED_AGENTS;
				case VIRTUAL_SERVER:
					return bootstrap.server;
				default:
					return undefined;
			}
		},

		load(id) {
			if (id === RESOLVED_DB_STUB) {
				return 'export default undefined;\n';
			}
			if (id === RESOLVED_AGENTS) {
				return generateScannedAgentsModule(state.agents);
			}
			return undefined;
		},

		async transform(code, id) {
			const filePath = id.split('?')[0] ?? id;
			if (!isAgentModulePath(filePath)) return null;
			const scanned = state.agentsByPath.get(normalizePath(filePath));
			if (!scanned) return null;
			if (!code.includes(AGENT_DIRECTIVE)) return null;
			return transformUseAgentModule({ code, id, filePath, identity: scanned.identity });
		},

		configureServer(server) {
			const controller = createNodeDevController({ server, root: state.root });

			// Stop the loaded application when THIS server closes so no listeners
			// or store handles leak. Bound per server instance (not a plugin-level
			// hook) because server.restart() builds the new server — re-running
			// this hook with a fresh controller — before closing the old one.
			const originalClose = server.close.bind(server);
			server.close = async () => {
				await controller.close();
				await originalClose();
			};

			const rescan = (): Promise<void> => {
				const run = async () => {
					let agents: AgentScanResult[];
					try {
						agents = await scanAgents({
							sourceRoot: state.project.sourceRoot,
							agents: state.project.agents,
						});
					} catch (error) {
						// Keep the previous set: a duplicate identity or a module
						// mid-edit shouldn't tear the app down. A later fix re-scans.
						server.config.logger.error(
							`[flue] Agent scan failed: ${error instanceof Error ? error.message : String(error)}`,
						);
						return;
					}
					if (!agentSetChanged(state.agents, agents)) return;
					updateAgents(agents);
					invalidateAgentsModule(server);
					controller.scheduleReload();
				};
				state.watchQueue = state.watchQueue.then(run, run);
				return state.watchQueue;
			};

			server.watcher.on('all', (event, file) => {
				const filePath = normalizePath(file);
				if (isFlueConfigPath(filePath, state)) {
					server.config.logger.info('[flue] flue.config changed; restarting the dev server.');
					requestRestart(server);
					return;
				}
				// Marked-set watch: any source-module event re-checks directive
				// prologues; a marked-set change regenerates virtual:flue/agents.
				if (
					(event === 'add' || event === 'change' || event === 'unlink') &&
					isAgentModulePath(filePath) &&
					isWithinDirectory(filePath, normalizePath(state.project.sourceRoot))
				) {
					void rescan();
				}
				// Reload when the change touches the loaded application graph
				// (Vite has already invalidated the file's module nodes).
				if (moduleGraphHasFile(server, filePath)) {
					controller.scheduleReload();
				}
			});

			controller.start();

			// Install after Vite's internal middlewares so transform/HMR
			// endpoints keep working; everything else is the application's.
			return () => {
				server.middlewares.use((req, res) => controller.handleRequest(req, res));
			};
		},

		configurePreviewServer() {
			throw new Error(
				'[flue] Node preview is not supported yet — run the built server directly:\n\n' +
					'  vite build && node dist/server.mjs\n',
			);
		},
	};

	return [corePlugin, importAttributePlugin(), flueDependencyResolverPlugin(resolverState)];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function generateScannedAgentsModule(agents: readonly AgentScanResult[]): string {
	const imports = agents
		.map(
			(agent, index) =>
				`import * as __flue_agent_${index}__ from ${JSON.stringify(normalizePath(agent.filePath))};`,
		)
		.join('\n');
	const entries = agents
		.map(
			(agent, index) =>
				`\t{ identity: ${JSON.stringify(agent.identity)}, module: __flue_agent_${index}__ },`,
		)
		.join('\n');
	return `// Generated by @flue/vite — the scanned 'use agent' module set.\n${imports}\nexport const scannedAgentModules = [\n${entries}\n];\n`;
}

function agentSetChanged(
	previous: readonly AgentScanResult[],
	next: readonly AgentScanResult[],
): boolean {
	if (previous.length !== next.length) return true;
	return previous.some(
		(agent, index) =>
			agent.filePath !== next[index]?.filePath || agent.identity !== next[index]?.identity,
	);
}

function invalidateAgentsModule(server: ViteDevServer): void {
	for (const environment of Object.values(server.environments)) {
		const moduleNode = environment.moduleGraph.getModuleById(RESOLVED_AGENTS);
		if (moduleNode) environment.moduleGraph.invalidateModule(moduleNode);
	}
}

function moduleGraphHasFile(server: ViteDevServer, filePath: string): boolean {
	for (const environment of Object.values(server.environments)) {
		const modules = environment.moduleGraph.getModulesByFile(filePath);
		if (modules && modules.size > 0) return true;
	}
	return false;
}

function isWithinDirectory(filePath: string, directory: string): boolean {
	return filePath === directory || filePath.startsWith(`${directory}/`);
}

/**
 * Whether a watched file is the project's Flue config: the discovered config
 * file, or — when none was discovered at startup — any `flue.config.*`
 * candidate appearing at the project root (its creation must also restart).
 */
function isFlueConfigPath(filePath: string, state: FluePluginState): boolean {
	if (state.configPath) return filePath === normalizePath(state.configPath);
	return FLUE_CONFIG_BASENAMES.some(
		(basename) => filePath === normalizePath(path.join(state.root, basename)),
	);
}

function containsCloudflarePlugin(plugins: UserConfig['plugins']): boolean {
	return flattenPluginOptions(plugins).some((plugin) => isCloudflarePluginName(plugin.name));
}

function flattenPluginOptions(plugins: PluginOption[] | undefined): Plugin[] {
	const found: Plugin[] = [];
	const visit = (option: PluginOption): void => {
		if (!option || typeof option !== 'object') return;
		if (Array.isArray(option)) {
			for (const entry of option) visit(entry);
			return;
		}
		// Skip promises: async plugin factories resolve during Vite config
		// resolution; configResolved re-detects against the final array.
		if (typeof (option as PromiseLike<unknown>).then === 'function') return;
		if (typeof (option as Plugin).name === 'string') found.push(option as Plugin);
	};
	if (plugins) visit(plugins);
	return found;
}

/** `@cloudflare/vite-plugin` registers `vite-plugin-cloudflare` (+ `:suffixed`) plugins. */
function isCloudflarePluginName(name: string | undefined): boolean {
	return (
		name === 'vite-plugin-cloudflare' || (name?.startsWith('vite-plugin-cloudflare:') ?? false)
	);
}

function missingAppEntryError(project: ResolvedFlueProject): Error {
	const suggestedPath = path.join(path.relative(project.root, project.sourceRoot) || '.', 'app.ts');
	return new Error(
		`[flue] No app entry found. app.ts is the application's route map and the only required file.\n\n` +
			`Create ${suggestedPath} with:\n\n` +
			`  import { Hono } from 'hono';\n` +
			`  export default new Hono().get('/', (c) => c.text('Hello from Flue'));\n\n` +
			`(or set \`app\` in flue.config.ts to an existing entry module).`,
	);
}

/**
 * Locate the bootstrap modules next to this file — TypeScript sources when
 * running from the repo (tests), bundled .mjs in the published package.
 * Returned paths are Vite-normalized so they match module-graph ids.
 */
function resolveBootstrapPaths(): { server: string; entry: string } {
	return {
		server: locateBootstrapModule('node-server'),
		entry: locateBootstrapModule('node-entry'),
	};
}

function locateBootstrapModule(basename: string): string {
	const packageDir = path.dirname(fileURLToPath(import.meta.url));
	for (const candidate of [
		path.join(packageDir, 'bootstrap', `${basename}.ts`),
		path.join(packageDir, 'bootstrap', `${basename}.mjs`),
	]) {
		if (fs.existsSync(candidate)) return normalizePath(candidate);
	}
	throw new Error(`[flue] Unable to locate the bundled bootstrap module "${basename}".`);
}
