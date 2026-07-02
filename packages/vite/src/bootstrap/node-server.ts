/**
 * The Node application bootstrap, loaded through the Vite graph as
 * `virtual:flue/server`.
 *
 * This is the CLI's generated-entry template
 * (packages/cli/src/lib/build-plugin-node.ts `generateRuntimeEntryPoint`)
 * ported to a real, testable module. Instead of codegen splices it consumes
 * Flue's virtual modules: the user's app (`virtual:flue/app`), the optional
 * persistence adapter (`virtual:flue/db`), and the scanned `'use agent'` set
 * (`virtual:flue/agents`).
 *
 * The registered agent set comes from the scan — `.route()` mounts in app.ts
 * are pure routers over it. There are no workflows and no channel-handler
 * registry on this surface: mounting is the dispatch.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { format } from 'node:util';
import { scannedAgentModules } from 'virtual:flue/agents';
import userApp from 'virtual:flue/app';
import userPersistenceAdapter from 'virtual:flue/db';
import type { AgentDefinition } from '@flue/runtime';
import type {
	AgentRecord,
	CreateAgentContextOptions,
	FlueAgentRegistration,
	PersistenceAdapter,
	RuntimeActivityLease,
} from '@flue/runtime/internal';
import {
	Bash,
	bashFactoryToSessionEnv,
	configureFlueRuntime,
	createFlueContext,
	createInstrumentationOwner,
	createNodeAgentCoordinator,
	createNodeDispatchQueue,
	createRuntimeActivityGate,
	InMemoryFs,
	installDevLifecycleLogger,
	registerFlueAgents,
	resolveModel,
	runWithInstrumentationOwner,
} from '@flue/runtime/internal';
import { sqlite } from '@flue/runtime/node';
import { serve } from '@hono/node-server';

export interface LoadFlueNodeApplicationOptions {
	/** Local (dev) mode: dev error rendering, dev SQLite file, lifecycle logs. */
	local?: boolean;
	/** Environment for the runtime; defaults to `process.env`. */
	env?: Record<string, string | undefined>;
	/** Capture runtime console output instead of writing to the console. */
	onOutput?: (output: { stream: 'stdout' | 'stderr'; line: string }) => void;
	/** Install the dev lifecycle logger (`[agent] name@id …`); local mode only. */
	internalDevLogs?: boolean;
}

/** The loaded application's lifecycle surface (admission, drain, shutdown). */
export interface LoadedFlueNodeApplication {
	fetch(request: Request, env?: unknown): Response | Promise<Response>;
	/** Take an activity lease; held leases block {@link waitForIdle}. */
	enterActivity(): RuntimeActivityLease;
	/** Stop admitting new durable work (drain phase). */
	pauseAdmissions(): void;
	/** Resolves once all activity leases are released. */
	waitForIdle(): Promise<void>;
	/** Graceful shutdown: coordinator, instrumentation, persistence. */
	stop(timeoutMs?: number): Promise<void>;
	/** Synchronous best-effort teardown for abnormal exits. */
	closeSync(): void;
}

export interface StartFlueNodeServerOptions extends LoadFlueNodeApplicationOptions {
	port?: number;
	hostname?: string;
	quiet?: boolean;
	signal?: AbortSignal;
	onReady?: () => void;
}

export interface FlueNodeServer {
	stop(): Promise<void>;
	closeSync(): void;
}

type ConsoleMethod = 'log' | 'info' | 'debug' | 'warn' | 'error';

/**
 * Create an empty in-memory sandbox (default).
 * Uses InMemoryFs (no real filesystem access) with sensible defaults:
 * cwd = /home/user, /tmp exists, /bin and /usr/bin exist.
 */
async function createDefaultEnv() {
	const fs = new InMemoryFs();
	return bashFactoryToSessionEnv(
		() =>
			new Bash({
				fs,
				network: { dangerouslyAllowFullInternetAccess: true },
			}),
	);
}

/** Build the identity-keyed registration records from the scanned modules. */
function createAgentRegistrations(): FlueAgentRegistration[] {
	return scannedAgentModules.map(({ identity, module }) => {
		const registration: FlueAgentRegistration = {
			identity,
			definition: module.default as AgentDefinition,
		};
		if (module.route !== undefined) {
			registration.route = module.route as FlueAgentRegistration['route'];
		}
		if (module.attachments !== undefined) {
			registration.attachments = module.attachments as FlueAgentRegistration['attachments'];
		}
		if (module.description !== undefined) {
			registration.description = module.description as FlueAgentRegistration['description'];
		}
		return registration;
	});
}

export async function loadFlueNodeApplication(
	options: LoadFlueNodeApplicationOptions = {},
): Promise<LoadedFlueNodeApplication> {
	const runtimeEnv = options.env ?? process.env;
	const isLocalMode = options.local === true;
	const outputContext = new AsyncLocalStorage<true>();
	const originalConsole = new Map<ConsoleMethod, (...args: unknown[]) => void>();
	let outputRestored = false;
	const restoreOutput = () => {
		if (outputRestored) return;
		outputRestored = true;
		for (const [method, original] of originalConsole) console[method] = original;
	};
	const onOutput = options.onOutput;
	if (onOutput) {
		for (const method of ['log', 'info', 'debug', 'warn', 'error'] as const) {
			const original = console[method];
			originalConsole.set(method, original);
			console[method] = (...args: unknown[]) => {
				if (!outputContext.getStore()) return original.apply(console, args);
				outputContext.exit(() =>
					onOutput({
						stream: method === 'warn' || method === 'error' ? 'stderr' : 'stdout',
						line: format(...args),
					}),
				);
			};
		}
	}
	const runInRuntime = <T>(fn: () => T): T => outputContext.run(true, fn);
	const instrumentationOwner = createInstrumentationOwner();
	let devLifecycle: ReturnType<typeof installDevLifecycleLogger> | undefined;
	let persistenceAdapter: PersistenceAdapter | undefined;
	let agentCoordinator: ReturnType<typeof createNodeAgentCoordinator> | undefined;
	try {
		return await runInRuntime(() =>
			runWithInstrumentationOwner(instrumentationOwner, async () => {
				devLifecycle =
					isLocalMode && options.internalDevLogs === true ? installDevLifecycleLogger() : undefined;

				// ─── Registration ─────────────────────────────────────────────
				// The scan IS the registration: every 'use agent' module joins the
				// app, replacing any previous registration wholesale (reload-safe).
				const registrations = createAgentRegistrations();
				registerFlueAgents(registrations);
				const agents: AgentRecord[] = registrations.map((registration) => ({
					name: registration.identity,
					definition: registration.definition,
					...(registration.description !== undefined
						? { description: registration.description }
						: {}),
					...(registration.route !== undefined ? { route: registration.route } : {}),
					...(registration.attachments !== undefined
						? { attachments: registration.attachments }
						: {}),
				}));

				// ─── Persistence ──────────────────────────────────────────────
				let stores: Awaited<ReturnType<PersistenceAdapter['connect']>>;
				if (userPersistenceAdapter !== undefined) {
					// Custom persistence from db.ts. connect() is awaited once at
					// startup so an unreachable or misconfigured database fails at
					// boot, not inside the first request.
					const adapter = userPersistenceAdapter as PersistenceAdapter;
					if (!adapter || typeof adapter.connect !== 'function') {
						throw new Error(
							'[flue] db.ts must default-export a PersistenceAdapter with a connect() method.',
						);
					}
					try {
						if (adapter.migrate) await adapter.migrate();
						const connected = (await adapter.connect()) as Awaited<
							ReturnType<PersistenceAdapter['connect']>
						>;
						if (!connected || typeof connected !== 'object') {
							throw new Error(
								'connect() must return { executionStore, conversationStreamStore, attachmentStore }.',
							);
						}
						if (
							!connected.executionStore ||
							typeof connected.executionStore.submissions?.getSubmission !== 'function'
						) {
							throw new Error('connect() must return an executionStore with submissions.');
						}
						if (
							!connected.conversationStreamStore ||
							typeof connected.conversationStreamStore.append !== 'function' ||
							typeof connected.conversationStreamStore.acquireProducer !== 'function'
						) {
							throw new Error('connect() must return a conversationStreamStore.');
						}
						if (
							!connected.attachmentStore ||
							typeof connected.attachmentStore.put !== 'function' ||
							typeof connected.attachmentStore.get !== 'function'
						) {
							throw new Error('connect() must return an attachmentStore.');
						}
						stores = connected;
					} catch (error) {
						throw new Error(
							`[flue] Failed to initialize persistence from db.ts: ${error instanceof Error ? error.message : error}`,
							{ cause: error },
						);
					}
					persistenceAdapter = adapter;
				} else {
					// Default persistence for Node — in-memory SQLite, process
					// lifetime. Under local dev, FLUE_DEV_SQLITE_PATH points this at
					// a disk file so conversation history survives reloads (the dev
					// server resets that file on each cold start). Ignored outside
					// local mode, so deployed Node stays in-memory.
					const defaultAdapter = sqlite(
						isLocalMode && runtimeEnv.FLUE_DEV_SQLITE_PATH
							? runtimeEnv.FLUE_DEV_SQLITE_PATH
							: undefined,
					);
					if (defaultAdapter.migrate) await defaultAdapter.migrate();
					stores = await defaultAdapter.connect();
					persistenceAdapter = defaultAdapter;
				}
				const { executionStore, conversationStreamStore, attachmentStore } = stores;

				// ─── Coordinator ──────────────────────────────────────────────
				const activityGate = createRuntimeActivityGate();
				const coordinator = createNodeAgentCoordinator({
					submissions: executionStore.submissions,
					agents,
					createContext: createAgentContextForRequest,
					conversationStreamStore,
					attachmentStore,
					onInteractionStart: devLifecycle?.onAgentInteractionStart,
					activityGate,
				});
				agentCoordinator = coordinator;
				const dispatchQueue = createNodeDispatchQueue(coordinator);

				function createAgentContextForRequest({
					id,
					agentName,
					request,
					initialEventIndex,
					dispatchId,
				}: CreateAgentContextOptions) {
					return createFlueContext({
						id,
						agentName,
						dispatchId,
						initialEventIndex,
						env: runtimeEnv,
						req: request,
						agentConfig: { resolveModel },
						createDefaultEnv,
					});
				}

				// ─── Runtime seed ─────────────────────────────────────────────
				// Seed the runtime before the application is installed into its
				// listener. `.route()` handlers in the user's app read this
				// configuration when requests arrive, so mounting during app.ts
				// evaluation (before this call) is safe.
				configureFlueRuntime({
					target: 'node',
					devMode: isLocalMode,
					agents,
					createAgentAdmission: (agentName, instanceId) =>
						coordinator.createAdmission(agentName, instanceId),
					abortAgentInstance: (agentName, instanceId) =>
						coordinator.abortInstance(agentName, instanceId),
					dispatchQueue,
					activityGate,
					conversationStreamStore,
					attachmentStore,
				});

				try {
					await runInRuntime(() => coordinator.reconcileSubmissions());
				} catch (error) {
					runInRuntime(() =>
						console.error('[flue] Startup submission reconciliation failed:', error),
					);
				}

				// ─── App composition ──────────────────────────────────────────
				// The user's app.ts default export owns the entire request
				// pipeline; we just verify it exposes a fetch method.
				const flueApp = userApp;
				if (!flueApp || typeof flueApp.fetch !== 'function') {
					throw new Error(
						'[flue] app.ts default export must be a Hono app or an object with a fetch(request) method.',
					);
				}

				let disposing: Promise<void> | undefined;
				return {
					fetch: (request: Request, env?: unknown) =>
						runInRuntime(() => flueApp.fetch(request, env)),
					enterActivity() {
						return activityGate.enter();
					},
					pauseAdmissions() {
						activityGate.pause();
					},
					waitForIdle() {
						return activityGate.waitForIdle();
					},
					async stop(timeoutMs = 30_000) {
						if (disposing) return disposing;
						disposing = runInRuntime(async () => {
							const errors: unknown[] = [];
							try {
								await coordinator.shutdown(timeoutMs);
							} catch (error) {
								errors.push(error);
							}
							try {
								await instrumentationOwner.dispose();
							} catch (error) {
								errors.push(error);
							}
							try {
								if (persistenceAdapter?.close) await persistenceAdapter.close();
							} catch (error) {
								errors.push(error);
							}
							devLifecycle?.dispose();
							restoreOutput();
							if (errors.length === 1) throw errors[0];
							if (errors.length > 1)
								throw new AggregateError(errors, '[flue] Node application shutdown failed.');
						});
						return disposing;
					},
					closeSync() {
						devLifecycle?.dispose();
						restoreOutput();
					},
				} satisfies LoadedFlueNodeApplication;
			}),
		);
	} catch (error) {
		const cleanupErrors: unknown[] = [];
		try {
			if (agentCoordinator) await agentCoordinator.shutdown(30_000);
		} catch (cleanupError) {
			cleanupErrors.push(cleanupError);
		}
		try {
			if (persistenceAdapter?.close) await persistenceAdapter.close();
		} catch (cleanupError) {
			cleanupErrors.push(cleanupError);
		}
		try {
			await instrumentationOwner.dispose();
		} catch (cleanupError) {
			cleanupErrors.push(cleanupError);
		}
		devLifecycle?.dispose();
		restoreOutput();
		if (cleanupErrors.length)
			throw new AggregateError(
				[error, ...cleanupErrors],
				'[flue] Node application startup failed.',
			);
		throw error;
	}
}

export async function startFlueNodeServer(
	options: StartFlueNodeServerOptions = {},
): Promise<FlueNodeServer> {
	const application = await loadFlueNodeApplication(options);
	const port = options.port ?? 3000;
	let resolveReady!: () => void;
	let rejectReady!: (error: unknown) => void;
	const ready = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	const server = serve(
		{
			fetch: application.fetch,
			port,
			...(options.hostname ? { hostname: options.hostname } : {}),
			serverOptions: { requestTimeout: 0 },
		},
		() => {
			if (!options.quiet) console.log(`[flue] Server listening on http://localhost:${port}`);
			options.onReady?.();
			resolveReady();
		},
	) as import('node:http').Server;
	const onServerError = (error: Error) => rejectReady(error);
	const onAbort = () => {
		server.closeAllConnections();
		server.close();
		rejectReady(options.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
	};
	server.once('error', onServerError);
	options.signal?.addEventListener('abort', onAbort, { once: true });
	if (options.signal?.aborted) onAbort();
	try {
		await ready;
	} catch (error) {
		server.closeAllConnections();
		server.close();
		await application.stop();
		throw error;
	} finally {
		server.off('error', onServerError);
		options.signal?.removeEventListener('abort', onAbort);
	}
	let stopping: Promise<void> | undefined;
	return {
		async stop() {
			if (stopping) return stopping;
			stopping = (async () => {
				const errors: unknown[] = [];
				const httpClosed = new Promise<void>((resolve) =>
					server.close((error) => {
						if (error) errors.push(error);
						resolve();
					}),
				);
				try {
					await application.stop();
				} catch (error) {
					errors.push(error);
				}
				server.closeAllConnections();
				await httpClosed;
				if (errors.length === 1) throw errors[0];
				if (errors.length > 1)
					throw new AggregateError(errors, '[flue] Node server shutdown failed.');
			})();
			return stopping;
		},
		closeSync() {
			server.closeAllConnections();
			server.close();
			application.closeSync();
		},
	};
}
