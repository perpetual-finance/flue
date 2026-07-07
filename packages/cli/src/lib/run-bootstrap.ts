/**
 * Transport-free execution bootstrap for `flue run <path>`.
 *
 * IMPORTANT — this module is NOT imported by the CLI process. It is loaded
 * through the same non-listening Vite server that loads the user's agent
 * module (see run-local.ts), so that every `@flue/runtime` specifier in the
 * execution graph — this bootstrap's, the agent module's, and the db
 * module's — resolves to exactly ONE on-disk copy of the runtime (the
 * project's install). The runtime keeps module-scoped registries (providers,
 * agent registration, instrumentation), so a second copy silently splits
 * that state. The CLI ships this file as its own build entry
 * (`dist/run-bootstrap.mjs`) with `@flue/runtime/*` kept external for the
 * same reason.
 *
 * The bootstrap drives the REAL durable submission path — the exact
 * machinery the generated Node server entry uses (@flue/vite's node
 * bootstrap):
 * persistence adapter connect/migrate/validate, `createNodeAgentCoordinator`,
 * a durable direct admission, and settlement observed from the canonical
 * conversation stream. Nothing HTTP is created: no Hono app, no listener,
 * no channels. Conversation reads go through the runtime's own
 * `handleAgentConversationRead` handler invoked in-process with synthetic
 * `Request` values.
 */

import type { DeliveredMessage, FunctionAgentDefinition } from '@flue/runtime';
import {
	Bash,
	bashFactoryToSessionEnv,
	type ConversationStreamChunk,
	configureFlueRuntime,
	createFlueContext,
	createInstrumentationOwner,
	createNodeAgentCoordinator,
	createNodeDispatchQueue,
	createRuntimeActivityGate,
	handleAgentConversationRead,
	InMemoryFs,
	type PersistenceAdapter,
	registerFlueAgents,
	resolveModel,
	runWithInstrumentationOwner,
} from '@flue/runtime/internal';
import { sqlite } from '@flue/runtime/node';

export interface FlueRunSessionOptions {
	/** Absolute path of the agent module; imported via {@link loadModule}. */
	agentModulePath: string;
	/** Agent identity (file basename); keys durable conversation storage. */
	identity: string;
	/** Absolute path of the project's db entry, when one resolved. */
	dbModulePath?: string;
	/** Display name for the db entry in diagnostics (e.g. `src/db.ts`). */
	dbSource?: string;
	/**
	 * SQLite file used when no db entry resolves. Unlike the dev server's
	 * dev.db this file is NEVER wiped — `--id` continuation across `flue run`
	 * invocations depends on it accumulating history.
	 */
	defaultSqlitePath: string;
	/** Runtime environment; defaults to `process.env`. */
	env?: Record<string, string | undefined>;
	/**
	 * Module loader used for the agent and db entries. Supplied by the CLI as
	 * `viteServer.ssrLoadModule` so user modules get the full transform
	 * pipeline (TS, import attributes) inside the single-runtime graph.
	 */
	loadModule: (path: string) => Promise<Record<string, unknown>>;
}

export interface FlueRunSubmitOptions {
	/** Receives every conversation stream chunk as it is durably recorded. */
	onEvent?: (chunk: ConversationStreamChunk) => void;
	/** Instance-creation data; the seed, consulted only when this send creates. */
	data?: unknown;
	/**
	 * Send condition: a string continues only the incarnation with that uid
	 * (else the run rejects); `null` creates only when no instance exists.
	 * Omit to send unconditionally.
	 */
	uid?: string | null;
	/**
	 * Abort intent (SIGINT). Aborting requests a durable instance abort and
	 * keeps draining the stream until the aborted settlement is observed.
	 */
	signal?: AbortSignal;
}

export interface FlueRunOutcome {
	submissionId: string;
	outcome: 'completed' | 'failed' | 'aborted';
	error?: unknown;
	/** Final assistant message text produced by this submission ('' if none). */
	message: string;
	/** The contacted instance's uid (minted at creation, echoed on continues). */
	uid?: string;
}

export interface FlueRunSession {
	/** Submit one message to a conversation and wait for settlement. */
	submit(
		conversationId: string,
		message: DeliveredMessage,
		options?: FlueRunSubmitOptions,
	): Promise<FlueRunOutcome>;
	/** Coordinator shutdown, instrumentation dispose, adapter close. */
	close(): Promise<void>;
}

/**
 * Storage path of an agent instance's canonical conversation stream.
 * Mirrors the runtime's `agentStreamPath` (runtime/stream-offsets.ts),
 * which is not exported from `@flue/runtime/internal`. The format is a
 * durable-storage contract (it keys persisted conversations), so this local
 * copy is stable; still, prefer the runtime seam once it is exported.
 */
function agentStreamPath(identity: string, instanceId: string): string {
	return `agents/${identity}/${instanceId}`;
}

const SHUTDOWN_TIMEOUT_MS = 30_000;

export async function createFlueRunSession(
	options: FlueRunSessionOptions,
): Promise<FlueRunSession> {
	const runtimeEnv = options.env ?? process.env;
	const instrumentationOwner = createInstrumentationOwner();
	let persistenceAdapter: PersistenceAdapter | undefined;
	let agentCoordinator: ReturnType<typeof createNodeAgentCoordinator> | undefined;

	try {
		// User modules evaluate inside the instrumentation owner so that any
		// `instrument(...)` calls made at module scope are disposed by close(),
		// mirroring the generated Node entry's startup.
		return await runWithInstrumentationOwner(instrumentationOwner, async () => {
			const agentModule = await options.loadModule(options.agentModulePath);
			const definition = agentModule.default as FunctionAgentDefinition;
			// Validates the default export (defineAgent value) and the identity,
			// and makes `.route()` / definition-addressed `dispatch()` resolvable.
			registerFlueAgents([{ identity: options.identity, definition }]);

			const dbSource = options.dbSource ?? 'db.ts';
			let userPersistenceAdapter: PersistenceAdapter | undefined;
			if (options.dbModulePath !== undefined) {
				const dbModule = await options.loadModule(options.dbModulePath);
				userPersistenceAdapter = dbModule.default as PersistenceAdapter;
				if (!userPersistenceAdapter || typeof userPersistenceAdapter.connect !== 'function') {
					throw new Error(
						`[flue] ${dbSource} must default-export a PersistenceAdapter with a connect() method.`,
					);
				}
			}

			// ── Persistence ─────────────────────────────────────────────────
			// Ported from the generated Node entry (now @flue/vite's node
			// bootstrap): connect() is awaited once at startup so an unreachable or
			// misconfigured database fails at boot, not mid-conversation.
			let stores: Awaited<ReturnType<PersistenceAdapter['connect']>>;
			if (userPersistenceAdapter) {
				try {
					if (userPersistenceAdapter.migrate) await userPersistenceAdapter.migrate();
					stores = await userPersistenceAdapter.connect();
					if (!stores || typeof stores !== 'object') {
						throw new Error(
							'connect() must return { executionStore, conversationStreamStore, attachmentStore }.',
						);
					}
					if (
						!stores.executionStore ||
						typeof stores.executionStore.submissions?.getSubmission !== 'function'
					) {
						throw new Error('connect() must return an executionStore with submissions.');
					}
					if (
						!stores.conversationStreamStore ||
						typeof stores.conversationStreamStore.append !== 'function' ||
						typeof stores.conversationStreamStore.acquireProducer !== 'function'
					) {
						throw new Error('connect() must return a conversationStreamStore.');
					}
					if (
						!stores.attachmentStore ||
						typeof stores.attachmentStore.put !== 'function' ||
						typeof stores.attachmentStore.get !== 'function'
					) {
						throw new Error('connect() must return an attachmentStore.');
					}
				} catch (error) {
					throw new Error(
						`[flue] Failed to initialize persistence from ${dbSource}: ` +
							(error instanceof Error ? error.message : String(error)),
						{ cause: error },
					);
				}
				persistenceAdapter = userPersistenceAdapter;
			} else {
				const defaultAdapter = sqlite(options.defaultSqlitePath);
				if (defaultAdapter.migrate) await defaultAdapter.migrate();
				stores = await defaultAdapter.connect();
				persistenceAdapter = defaultAdapter;
			}
			const { executionStore, conversationStreamStore, attachmentStore } = stores;
			if (!conversationStreamStore || !attachmentStore) {
				throw new Error('[flue] Persistence adapter did not provide conversation stores.');
			}

			// ── Coordinator ─────────────────────────────────────────────────
			// Default sandbox: empty in-memory fs, mirroring the generated entry.
			async function createDefaultEnv() {
				const fs = new InMemoryFs();
				return bashFactoryToSessionEnv(
					() => new Bash({ fs, network: { dangerouslyAllowFullInternetAccess: true } }),
				);
			}

			const agents = [{ name: options.identity, definition }];
			const activityGate = createRuntimeActivityGate();
			const coordinator = createNodeAgentCoordinator({
				submissions: executionStore.submissions,
				agents,
				createContext: ({ id, agentName, request, initialEventIndex, dispatchId }) =>
					createFlueContext({
						id,
						agentName,
						dispatchId,
						initialEventIndex,
						env: runtimeEnv,
						req: request,
						agentConfig: { resolveModel },
						createDefaultEnv,
					}),
				conversationStreamStore,
				attachmentStore,
				activityGate,
			});
			agentCoordinator = coordinator;
			const dispatchQueue = createNodeDispatchQueue(coordinator);

			// Seed the runtime config so `dispatch()` and other registration-aware
			// APIs behave exactly as in a generated Node entry.
			configureFlueRuntime({
				target: 'node',
				devMode: false,
				agents,
				dispatchQueue,
				activityGate,
				createAgentAdmission: (agentName, instanceId) =>
					coordinator.createAdmission(agentName, instanceId),
				abortAgentInstance: (agentName, instanceId) =>
					coordinator.abortInstance(agentName, instanceId),
				conversationStreamStore,
				attachmentStore,
			});

			// Reconcile work interrupted by a previous `flue run` process — the
			// default run.db persists across invocations by design.
			try {
				await coordinator.reconcileSubmissions();
			} catch (error) {
				console.error('[flue] Startup submission reconciliation failed:', error);
			}

			let closing: Promise<void> | undefined;
			return {
				submit: (conversationId, message, submitOptions = {}) =>
					submitAndSettle({
						coordinator,
						conversationStreamStore,
						identity: options.identity,
						conversationId,
						message,
						...submitOptions,
					}),
				close() {
					closing ??= (async () => {
						const errors: unknown[] = [];
						try {
							await coordinator.shutdown(SHUTDOWN_TIMEOUT_MS);
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
						if (errors.length === 1) throw errors[0];
						if (errors.length > 1) {
							throw new AggregateError(errors, '[flue] flue run shutdown failed.');
						}
					})();
					return closing;
				},
			};
		});
	} catch (error) {
		// Startup failed part-way: unwind whatever was created, then rethrow.
		const cleanupErrors: unknown[] = [];
		try {
			if (agentCoordinator) await agentCoordinator.shutdown(SHUTDOWN_TIMEOUT_MS);
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
		if (cleanupErrors.length) {
			throw new AggregateError([error, ...cleanupErrors], '[flue] flue run startup failed.');
		}
		throw error;
	}
}

// ─── Submission + settlement observation ────────────────────────────────────

interface SubmitAndSettleOptions extends FlueRunSubmitOptions {
	coordinator: ReturnType<typeof createNodeAgentCoordinator>;
	conversationStreamStore: NonNullable<
		Awaited<ReturnType<PersistenceAdapter['connect']>>['conversationStreamStore']
	>;
	identity: string;
	conversationId: string;
	message: DeliveredMessage;
}

/**
 * Admit one durable direct submission (the same admission
 * `POST /agents/.../:id` uses) and observe its settlement from the canonical
 * conversation stream via the runtime's own read handler — long-poll reads
 * against the store, no transport. This is `invokeDirectAttached` semantics
 * without HTTP.
 */
async function submitAndSettle(options: SubmitAndSettleOptions): Promise<FlueRunOutcome> {
	const { coordinator, conversationStreamStore, identity, conversationId, message } = options;
	throwIfAborted(options.signal);

	const admit = coordinator.createAdmission(identity, conversationId);
	const receipt = await admit(message, undefined, options.data, options.uid);
	const streamPath = agentStreamPath(identity, conversationId);

	let abortRequested = false;
	const requestAbort = () => {
		if (abortRequested) return;
		abortRequested = true;
		// Durable abort intent; settlement (outcome 'aborted') arrives
		// asynchronously on the conversation stream, which we keep draining.
		void coordinator.abortInstance(identity, conversationId).catch((error) => {
			console.error('[flue] Abort request failed:', error);
		});
	};
	if (options.signal?.aborted) requestAbort();
	options.signal?.addEventListener('abort', requestAbort, { once: true });

	try {
		let offset = receipt.offset;
		let settlement:
			| Extract<ConversationStreamChunk, { type: 'submission-settled' }>
			| undefined;
		while (!settlement) {
			const response = await handleAgentConversationRead({
				store: conversationStreamStore,
				path: streamPath,
				request: new Request(
					`https://flue.invalid/${streamPath}?view=updates&offset=${encodeURIComponent(offset)}&live=long-poll`,
				),
			});
			if (!response.ok) {
				throw new Error(`[flue] Conversation stream read failed (HTTP ${response.status}).`);
			}
			const chunks = (await response.json()) as ConversationStreamChunk[];
			for (const chunk of chunks) {
				options.onEvent?.(chunk);
				if (chunk.type === 'submission-settled' && chunk.submissionId === receipt.submissionId) {
					settlement = chunk;
				}
			}
			offset = response.headers.get('Stream-Next-Offset') ?? offset;
		}

		return {
			submissionId: receipt.submissionId,
			outcome: settlement.outcome,
			...(settlement.error === undefined ? {} : { error: settlement.error }),
			message: await readFinalAssistantMessage(
				conversationStreamStore,
				streamPath,
				receipt.submissionId,
			),
			...(receipt.uid !== undefined ? { uid: receipt.uid } : {}),
		};
	} finally {
		options.signal?.removeEventListener('abort', requestAbort);
	}
}

/**
 * Read the settled conversation's history projection and extract the final
 * assistant message text produced by this submission (falling back to the
 * conversation's last assistant message when the submission produced none).
 */
async function readFinalAssistantMessage(
	store: SubmitAndSettleOptions['conversationStreamStore'],
	streamPath: string,
	submissionId: string,
): Promise<string> {
	const response = await handleAgentConversationRead({
		store,
		path: streamPath,
		request: new Request(`https://flue.invalid/${streamPath}?view=history`),
	});
	if (!response.ok) return '';
	const snapshot = (await response.json()) as {
		messages: Array<{
			role: string;
			submissionId?: string;
			parts: Array<{ type: string; text?: string }>;
		}>;
	};
	const assistantMessages = snapshot.messages.filter((message) => message.role === 'assistant');
	const own = assistantMessages.filter((message) => message.submissionId === submissionId);
	const final = (own.length > 0 ? own : assistantMessages).at(-1);
	if (!final) return '';
	return final.parts
		.filter((part) => part.type === 'text' && typeof part.text === 'string')
		.map((part) => part.text as string)
		.join('\n\n');
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}
