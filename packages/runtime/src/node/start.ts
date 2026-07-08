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
import type { FlueAgentRegistration } from '../runtime/registration.ts';
import { sqlite } from './agent-execution-store.ts';
import { assembleNodeAgentRuntime, connectPersistenceAdapter } from './assemble.ts';

export interface StartAgent {
	/** Registered identity (lower-kebab-case); keys durable conversation storage. */
	name: string;
	description?: string;
	/** The agent — a `defineAgent(...)` value. */
	agent: FlueAgentRegistration['definition'];
}

export interface StartOptions {
	/** The agents this runtime serves, in `useSubagent` form. */
	agents: readonly StartAgent[];
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
 * inside a Flue server: `init()` to prompt agents and await their settled
 * replies, `dispatch()` to fire-and-forget.
 *
 * ```ts
 * import { init } from '@flue/runtime';
 * import { sqlite, start } from '@flue/runtime/node';
 * import reporter from '../src/agents/reporter.ts';
 *
 * await using flue = await start({
 *   agents: [{ name: 'reporter', agent: reporter }],
 *   db: sqlite('./nightly.db'), // omit for in-memory
 * });
 *
 * const agent = init(reporter, { id: `nightly-${date}` });
 * const reply = await agent.prompt('You have been triggered. Produce the nightly report.');
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
	const registrations: FlueAgentRegistration[] = options.agents.map((record) => {
		if (!record || typeof record.name !== 'string' || record.name.trim() === '') {
			throw new Error('[flue] start() agents entries require a non-empty string `name`.');
		}
		return {
			identity: record.name,
			definition: record.agent,
			...(record.description !== undefined ? { description: record.description } : {}),
		};
	});

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
