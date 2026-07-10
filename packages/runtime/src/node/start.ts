/**
 * `start()` — the Node bootstrap for running Flue outside a generated server
 * entry: standalone scripts (`node ./scripts/report.ts`) and user test
 * suites. The CLI's `flue run` shares the same assembly (`./assemble.ts`)
 * with module loading layered on top.
 *
 * One process holds at most one Flue runtime (the runtime keeps module-scoped
 * registries — see `configureFlueRuntime`), so `start()` refuses to run where
 * a runtime is already configured: inside a Flue server, `init()`/`dispatch()`
 * work directly and no bootstrap is needed.
 */

import type { PersistenceAdapter } from '../agent-execution-store.ts';
import { getFlueRuntime } from '../runtime/flue-app.ts';
import { AGENT_IDENTITY_PATTERN, type FlueAgentRegistration } from '../runtime/registration.ts';
import { sqlite } from './agent-execution-store.ts';
import { assembleNodeAgentRuntime, connectPersistenceAdapter } from './assemble.ts';

export interface StartAgent {
	/** Registered identity (lower-kebab-case); keys durable conversation storage. */
	name: string;
	description?: string;
	/** The agent — a `defineAgent(...)` value. */
	agent: FlueAgentRegistration['definition'];
	/**
	 * Valibot schema for instance-creation data — the programmatic analog of
	 * the agent module's `initialDataSchema` export.
	 */
	initialDataSchema?: FlueAgentRegistration['initialDataSchema'];
	/** Submission retry policy — the analog of the module's `durability` export. */
	durability?: FlueAgentRegistration['durability'];
}

/**
 * A whole agent module as a `start()` entry: `import * as reporter from
 * './agents/reporter.ts'` and pass the namespace. The module's exports carry
 * the registration exactly as a `'use agent'` build reads them — with one
 * difference: `export const name` is REQUIRED here, because a namespace
 * object cannot know its own filename, so there is no basename to fall back
 * on.
 */
export interface StartAgentModule {
	/** The agent — the module's default export (`defineAgent(...)`). */
	default: FlueAgentRegistration['definition'];
	/** The identity — the module's `export const name` (lower-kebab-case). */
	name: string;
	description?: string;
	/** Route middleware, honored if the caller mounts `agent.route()` itself. */
	route?: FlueAgentRegistration['route'];
	initialDataSchema?: FlueAgentRegistration['initialDataSchema'];
	durability?: FlueAgentRegistration['durability'];
}

export type StartAgentEntry = StartAgent | StartAgentModule;

export interface StartOptions {
	/**
	 * The agents this runtime serves: `{ name, agent, ... }` entries for
	 * inline definitions, or whole agent-module namespaces (`import * as`).
	 */
	agents: readonly StartAgentEntry[];
	/**
	 * Persistence. Defaults to in-memory SQLite (process lifetime — nothing
	 * survives exit). Pass an adapter (e.g. `sqlite('./run.db')`) to persist
	 * conversations across runs.
	 */
	db?: PersistenceAdapter;
	/** Runtime environment. Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
}

/** A started Flue runtime. Stop it when the script is done. */
export interface Flue {
	/** Graceful shutdown: drain in-flight work, then disconnect persistence. */
	stop(): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
}

/**
 * Start the Flue runtime in this process — the bootstrap for standalone
 * scripts and test suites, mirroring what a generated Flue server entry does
 * at boot (registration, persistence, the durable submission coordinator)
 * without any HTTP surface.
 *
 * After `start()` resolves, the runtime-backed APIs work exactly as they do
 * inside a Flue server: the `init()` handle to send messages and await their
 * settled replies, the top-level `dispatch()` to fire-and-forget.
 *
 * ```ts
 * import { init } from '@flue/runtime';
 * import { sqlite, start } from '@flue/runtime/node';
 * import * as reporter from '../src/agents/reporter.ts';
 *
 * await using flue = await start({
 *   // The whole module is the registration: its `name`, `description`,
 *   // `initialDataSchema`, and `durability` exports carry the config
 *   // (`export const name` is required for this form). Inline agents
 *   // use `{ name, agent }` entries instead.
 *   agents: [reporter],
 *   db: sqlite('./nightly.db'), // omit for in-memory
 * });
 *
 * const agent = init(reporter.default, { id: `nightly-${date}` });
 * const reply = await agent.dispatch('You have been triggered. Produce the nightly report.');
 * console.log(reply.text);
 * ```
 *
 * Inside a Flue server (a generated entry, `flue dev`, a deploy) the runtime
 * is already configured — call `init()`/`dispatch()` directly; `start()`
 * throws there rather than split the process's registries.
 */
export async function start(options: StartOptions): Promise<Flue> {
	if (getFlueRuntime() !== undefined) {
		throw new Error(
			'[flue] start() found an already-configured Flue runtime in this process. ' +
				'Inside a Flue server, init()/dispatch() work directly — start() is only for ' +
				'standalone scripts and tests, and one process holds one runtime.',
		);
	}
	if (!Array.isArray(options?.agents) || options.agents.length === 0) {
		throw new Error(
			'[flue] start() requires at least one agent: start({ agents: [{ name, agent }] }).',
		);
	}
	const registrations: FlueAgentRegistration[] = options.agents.map((record) =>
		normalizeStartAgentEntry(record),
	);

	const adapter = options.db ?? sqlite();
	const stores = await connectPersistenceAdapter(
		adapter,
		options.db !== undefined ? 'start({ db })' : 'the default in-memory sqlite adapter',
	);
	const assembled = await assembleNodeAgentRuntime({
		agents: registrations,
		adapter,
		stores,
		...(options.env !== undefined ? { env: options.env } : {}),
	});

	return {
		stop: () => assembled.close(),
		[Symbol.asyncDispose]: () => assembled.close(),
	};
}

function normalizeStartAgentEntry(record: StartAgentEntry): FlueAgentRegistration {
	if (!record || typeof record !== 'object') {
		throw new Error('[flue] start() agents entries must be objects.');
	}
	if ('agent' in record) {
		if (typeof record.name !== 'string' || record.name.trim() === '') {
			throw new Error('[flue] start() agents entries require a non-empty string `name`.');
		}
		return {
			identity: record.name,
			definition: record.agent,
			...(record.description !== undefined ? { description: record.description } : {}),
			...(record.initialDataSchema !== undefined
				? { initialDataSchema: record.initialDataSchema }
				: {}),
			...(record.durability !== undefined ? { durability: record.durability } : {}),
		};
	}
	if ('default' in record) {
		// A module namespace has no filename, so the identity cannot fall back
		// to a basename the way the build scan's does: the name export is
		// mandatory. NEVER auto-name (agent-1, ...) — the identity keys durable
		// storage, and positional names silently reassign conversations when
		// the agents array is reordered.
		if (typeof record.name !== 'string' || !AGENT_IDENTITY_PATTERN.test(record.name)) {
			throw new Error(
				'[flue] start() module entries require the agent module to declare its identity: ' +
					"add `export const name = '<lower-kebab-case>'` to the module, or use the { name, agent } entry form.",
			);
		}
		return {
			identity: record.name,
			definition: record.default,
			...(record.description !== undefined ? { description: record.description } : {}),
			...(record.route !== undefined ? { route: record.route } : {}),
			...(record.initialDataSchema !== undefined
				? { initialDataSchema: record.initialDataSchema }
				: {}),
			...(record.durability !== undefined ? { durability: record.durability } : {}),
		};
	}
	throw new Error(
		'[flue] start() agents entries must be { name, agent } records or agent-module namespaces (import * as agent).',
	);
}
