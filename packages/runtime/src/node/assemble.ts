/**
 * The shared Node runtime assembly — the transport-free core of what a
 * generated Flue server entry does at boot. `start()` (public, `./start.ts`)
 * and the CLI's `flue run` bootstrap are its consumers.
 *
 * Kept free of `node:sqlite` (no default-adapter import) so it can sit in
 * `@flue/runtime/internal`'s module graph, which Workers builds also load.
 */

import { Bash, InMemoryFs } from 'just-bash';
import type { PersistenceAdapter } from '../agent-execution-store.ts';
import { createFlueContext } from '../client.ts';
import type { AgentRecord } from '../runtime/flue-app.ts';
import { configureFlueRuntime, resetFlueRuntimeForTests } from '../runtime/flue-app.ts';
import { resolveModel } from '../runtime/providers.ts';
import type { FlueAgentRegistration } from '../runtime/registration.ts';
import { registerFlueAgents } from '../runtime/registration.ts';
import { createRuntimeActivityGate } from '../runtime/runtime-activity-gate.ts';
import { bashFactoryToSessionEnv } from '../sandbox.ts';
import type { SessionEnv } from '../types.ts';
import { createNodeAgentCoordinator, createNodeDispatchQueue } from './agent-coordinator.ts';

const SHUTDOWN_TIMEOUT_MS = 30_000;

type ConnectedStores = Awaited<ReturnType<PersistenceAdapter['connect']>>;

/**
 * Connect and validate a persistence adapter: migrations run first, and a
 * malformed or unreachable store fails here — at boot — rather than inside
 * the first conversation. `sourceLabel` names the adapter's origin in
 * diagnostics (e.g. `db.ts`, `start({ db })`).
 */
export async function connectPersistenceAdapter(
	adapter: PersistenceAdapter,
	sourceLabel: string,
): Promise<ConnectedStores> {
	if (!adapter || typeof adapter.connect !== 'function') {
		throw new Error(
			`[flue] ${sourceLabel} must provide a PersistenceAdapter with a connect() method.`,
		);
	}
	try {
		if (adapter.migrate) await adapter.migrate();
		const stores = await adapter.connect();
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
		return stores;
	} catch (error) {
		throw new Error(
			`[flue] Failed to initialize persistence from ${sourceLabel}: ` +
				(error instanceof Error ? error.message : String(error)),
			{ cause: error },
		);
	}
}

export interface AssembleNodeAgentRuntimeOptions {
	/** The application's agent set; registered wholesale (identity keyed). */
	agents: readonly FlueAgentRegistration[];
	/** Connected persistence; close() disconnects it (see `connectPersistenceAdapter`). */
	adapter: PersistenceAdapter;
	stores: ConnectedStores;
	/** Runtime environment; defaults to `process.env`. */
	env?: Record<string, string | undefined>;
	devMode?: boolean;
	/** Sandbox factory; defaults to an empty in-memory fs with Bash. */
	createDefaultEnv?: () => Promise<SessionEnv>;
}

export interface AssembledNodeAgentRuntime {
	coordinator: ReturnType<typeof createNodeAgentCoordinator>;
	conversationStreamStore: NonNullable<ConnectedStores['conversationStreamStore']>;
	/** Coordinator shutdown, runtime reset, adapter close. */
	close(): Promise<void>;
}

/**
 * The shared Node runtime assembly: registration → coordinator → dispatch
 * queue → runtime seed → startup reconciliation. Exactly the wiring the
 * generated Node server entry performs, without HTTP: no Hono app, no
 * listener, no channels. `flue run` and `start()` are its consumers.
 */
export async function assembleNodeAgentRuntime(
	options: AssembleNodeAgentRuntimeOptions,
): Promise<AssembledNodeAgentRuntime> {
	const runtimeEnv = options.env ?? process.env;
	registerFlueAgents(options.agents);

	const { executionStore, conversationStreamStore, attachmentStore } = options.stores;
	if (!conversationStreamStore || !attachmentStore) {
		throw new Error('[flue] Persistence adapter did not provide conversation stores.');
	}

	const createDefaultEnv =
		options.createDefaultEnv ??
		(async () => {
			const fs = new InMemoryFs();
			return bashFactoryToSessionEnv(
				() => new Bash({ fs, network: { dangerouslyAllowFullInternetAccess: true } }),
			);
		});

	const agents: AgentRecord[] = options.agents.map((registration) => ({
		name: registration.identity,
		definition: registration.definition,
		...(registration.description !== undefined ? { description: registration.description } : {}),
		...(registration.route !== undefined ? { route: registration.route } : {}),
		...(registration.attachments !== undefined ? { attachments: registration.attachments } : {}),
	}));

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
	const dispatchQueue = createNodeDispatchQueue(coordinator);

	configureFlueRuntime({
		target: 'node',
		devMode: options.devMode ?? false,
		agents,
		dispatchQueue,
		activityGate,
		createAgentAdmission: (agentName, instanceId) =>
			coordinator.createAdmission(agentName, instanceId),
		abortAgentInstance: (agentName, instanceId) => coordinator.abortInstance(agentName, instanceId),
		conversationStreamStore,
		attachmentStore,
	});

	// Reconcile work a previous process left interrupted (durable adapters
	// persist across invocations by design; a fresh store is a no-op).
	try {
		await coordinator.reconcileSubmissions();
	} catch (error) {
		console.error('[flue] Startup submission reconciliation failed:', error);
	}

	let closing: Promise<void> | undefined;
	return {
		coordinator,
		conversationStreamStore,
		close() {
			closing ??= (async () => {
				const errors: unknown[] = [];
				try {
					await coordinator.shutdown(SHUTDOWN_TIMEOUT_MS);
				} catch (error) {
					errors.push(error);
				}
				resetFlueRuntimeForTests();
				try {
					if (options.adapter.close) await options.adapter.close();
				} catch (error) {
					errors.push(error);
				}
				if (errors.length === 1) throw errors[0];
				if (errors.length > 1) throw new AggregateError(errors, '[flue] Flue shutdown failed.');
			})();
			return closing;
		},
	};
}
