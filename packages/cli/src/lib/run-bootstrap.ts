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
 * The bootstrap drives the REAL durable submission path — the shared
 * `assembleNodeAgentRuntime` assembly (registration, persistence
 * connect/migrate/validate, `createNodeAgentCoordinator`, runtime seed), a
 * durable direct admission, and settlement observed from the canonical
 * conversation stream via the runtime's observation seam. Nothing HTTP is
 * created: no Hono app, no listener, no channels.
 */

import type { DeliveredMessage, FunctionAgentDefinition } from '@flue/runtime';
import {
	type AssembledNodeAgentRuntime,
	agentStreamPath,
	assembleNodeAgentRuntime,
	type ConversationStreamChunk,
	connectPersistenceAdapter,
	createInstrumentationOwner,
	observeSubmissionSettlement,
	type PersistenceAdapter,
	readSubmissionReply,
	runWithInstrumentationOwner,
} from '@flue/runtime/internal';
import { sqlite } from '@flue/runtime/node';

export interface FlueRunSessionOptions {
	/** Absolute path of the agent module; imported via {@link loadModule}. */
	agentModulePath: string;
	/**
	 * Fallback agent identity (the file basename). The module's own
	 * `export const name` wins when declared; the resolved identity keys
	 * durable conversation storage and is exposed on {@link FlueRunSession}.
	 */
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
	 * pipeline (TS, markdown/skill imports) inside the single-runtime graph.
	 */
	loadModule: (path: string) => Promise<Record<string, unknown>>;
}

export interface FlueRunSubmitOptions {
	/** Receives every conversation stream chunk as it is durably recorded. */
	onEvent?: (chunk: ConversationStreamChunk) => void;
	/** Instance-creation data; the seed, consulted only when this send creates. */
	initialData?: unknown;
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
	/** The resolved agent identity: the module's `name` export, else the file basename. */
	readonly identity: string;
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
 * Matches `@flue/vite`'s AGENT_IDENTITY_PATTERN (agent-scan.ts) — duplicated
 * here because the run bootstrap must not pull the vite package into the
 * single-runtime execution graph.
 */
const RUN_IDENTITY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * The module's `export const name` wins over the basename-derived fallback —
 * `flue run` skips the build scan, so the override is read off the evaluated
 * namespace instead (same precedence, different mechanism).
 */
function resolveRunIdentity(agentModule: Record<string, unknown>, fallback: string): string {
	const nameExport = agentModule.name;
	if (nameExport === undefined) return fallback;
	if (typeof nameExport !== 'string' || !RUN_IDENTITY_PATTERN.test(nameExport)) {
		throw new Error(
			`[flue] The agent module's \`name\` export is its durable identity and must be a ` +
				`lower-kebab-case string; got ${JSON.stringify(nameExport)}.`,
		);
	}
	return nameExport;
}

export async function createFlueRunSession(
	options: FlueRunSessionOptions,
): Promise<FlueRunSession> {
	const runtimeEnv = options.env ?? process.env;
	const instrumentationOwner = createInstrumentationOwner();
	let persistenceAdapter: PersistenceAdapter | undefined;
	let assembled: AssembledNodeAgentRuntime | undefined;

	try {
		// User modules evaluate inside the instrumentation owner so that any
		// `instrument(...)` calls made at module scope are disposed by close(),
		// mirroring the generated Node entry's startup.
		return await runWithInstrumentationOwner(instrumentationOwner, async () => {
			const agentModule = await options.loadModule(options.agentModulePath);
			const definition = agentModule.default as FunctionAgentDefinition;
			const identity = resolveRunIdentity(agentModule, options.identity);

			const dbSource = options.dbSource ?? 'db.ts';
			let adapter: PersistenceAdapter;
			let adapterSource: string;
			if (options.dbModulePath !== undefined) {
				const dbModule = await options.loadModule(options.dbModulePath);
				adapter = dbModule.default as PersistenceAdapter;
				adapterSource = dbSource;
			} else {
				// The default run.db is NEVER wiped — `--id` continuation across
				// `flue run` invocations depends on it accumulating history.
				adapter = sqlite(options.defaultSqlitePath);
				adapterSource = 'the default sqlite adapter';
			}
			// connect() is awaited once at startup so an unreachable or
			// misconfigured database fails at boot, not mid-conversation.
			const stores = await connectPersistenceAdapter(adapter, adapterSource);
			persistenceAdapter = adapter;

			// The shared runtime assembly the generated Node entry and `start()`
			// use: registration, coordinator, dispatch queue, runtime seed, and
			// startup reconciliation (the run.db persists across invocations).
			const agentRegistration = {
				identity,
				definition,
				...(agentModule.route !== undefined ? { route: agentModule.route } : {}),
				...(agentModule.description !== undefined
					? { description: agentModule.description }
					: {}),
				...(agentModule.initialDataSchema !== undefined
					? { initialDataSchema: agentModule.initialDataSchema }
					: {}),
				...(agentModule.durability !== undefined ? { durability: agentModule.durability } : {}),
			} as Parameters<typeof assembleNodeAgentRuntime>[0]['agents'][number];
			const runtime = await assembleNodeAgentRuntime({
				agents: [agentRegistration],
				adapter,
				stores,
				env: runtimeEnv,
			});
			assembled = runtime;

			let closing: Promise<void> | undefined;
			return {
				identity,
				submit: (conversationId, message, submitOptions = {}) =>
					submitAndSettle({
						coordinator: runtime.coordinator,
						conversationStreamStore: runtime.conversationStreamStore,
						identity,
						conversationId,
						message,
						...submitOptions,
					}),
				close() {
					closing ??= (async () => {
						const errors: unknown[] = [];
						try {
							await runtime.close();
						} catch (error) {
							errors.push(error);
						}
						try {
							await instrumentationOwner.dispose();
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
			if (assembled) await assembled.close();
			else if (persistenceAdapter?.close) await persistenceAdapter.close();
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
	coordinator: AssembledNodeAgentRuntime['coordinator'];
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
 * conversation stream via the runtime's observation seam — no transport.
 * This is `invokeDirectAttached` semantics without HTTP.
 */
async function submitAndSettle(options: SubmitAndSettleOptions): Promise<FlueRunOutcome> {
	const { coordinator, conversationStreamStore, identity, conversationId, message } = options;
	throwIfAborted(options.signal);

	const admit = coordinator.createAdmission(identity, conversationId);
	const receipt = await admit(message, {
		...(options.initialData !== undefined ? { initialData: options.initialData } : {}),
		...(options.uid !== undefined ? { uid: options.uid } : {}),
	});
	const streamPath = agentStreamPath(identity, conversationId);

	let abortRequested = false;
	const requestAbort = () => {
		if (abortRequested) return;
		abortRequested = true;
		// Durable abort intent; settlement (outcome 'aborted') arrives
		// asynchronously on the conversation stream, which we keep observing.
		void coordinator.abortInstance(identity, conversationId).catch((error) => {
			console.error('[flue] Abort request failed:', error);
		});
	};
	if (options.signal?.aborted) requestAbort();
	options.signal?.addEventListener('abort', requestAbort, { once: true });

	try {
		const settlement = await observeSubmissionSettlement({
			store: conversationStreamStore,
			path: streamPath,
			submissionId: receipt.submissionId,
			offset: receipt.offset,
			...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
		});
		const reply = await readSubmissionReply({
			store: conversationStreamStore,
			path: streamPath,
			submissionId: receipt.submissionId,
		});

		return {
			submissionId: receipt.submissionId,
			outcome: settlement.outcome,
			...(settlement.error === undefined ? {} : { error: settlement.error }),
			message: reply.text,
			...(receipt.uid !== undefined ? { uid: receipt.uid } : {}),
		};
	} finally {
		options.signal?.removeEventListener('abort', requestAbort);
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}
