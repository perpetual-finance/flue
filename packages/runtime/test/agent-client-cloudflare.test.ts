import { DatabaseSync } from 'node:sqlite';
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	registerFauxProvider,
} from '@earendil-works/pi-ai/compat';
import { Bash, InMemoryFs } from 'just-bash';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRunError, init } from '../src/agent-client.ts';
import { createFlueContext } from '../src/client.ts';
import { createCloudflareAgentRuntime } from '../src/cloudflare/agent-coordinator.ts';
import { createCloudflareWorkerConfig } from '../src/cloudflare/worker-config.ts';
import { AgentInstanceExistsError } from '../src/errors.ts';
import { useDelivery } from '../src/hooks/use-delivery.ts';
import { useModel } from '../src/hooks/use-model.ts';
import { configureFlueRuntime, resetFlueRuntimeForTests } from '../src/runtime/flue-app.ts';
import {
	registerProvider,
	resetProviderRuntime,
	resolveModel,
} from '../src/runtime/providers.ts';
import {
	registerFlueAgents,
	resetFlueAgentRegistrationForTests,
} from '../src/runtime/registration.ts';
import { bashFactoryToSessionEnv } from '../src/sandbox.ts';
import type { Agent } from '../src/types.ts';

/**
 * End-to-end: the awaited `init()` handle on the Cloudflare target.
 *
 * The rig mirrors the generated Worker entry minus workerd: the REAL Durable
 * Object coordinator runs against fake SQL-backed DO storage, and the Flue
 * runtime is seeded with the REAL worker-side seams
 * (`createCloudflareWorkerConfig`) whose injected `fetchAgent` routes straight
 * to the coordinator's request handler. The client path under test is exactly
 * production: dispatch admission over the internal DO route, settlement
 * observation over the DO's conversation long-poll route, reply read over the
 * history route — all through `routeAgentRequest` with no per-request env
 * (the module-scope env fallback every non-handler context relies on).
 */

const providers: FauxProviderRegistration[] = [];

afterEach(() => {
	resetFlueAgentRegistrationForTests();
	resetFlueRuntimeForTests();
	resetProviderRuntime();
	for (const provider of providers.splice(0)) provider.unregister();
});

function createFauxProvider(): { provider: FauxProviderRegistration; model: string } {
	const name = `faux-cf-client-${crypto.randomUUID()}`;
	const provider = registerFauxProvider({ provider: name, models: [{ id: 'faux-model' }] });
	registerProvider(name, { api: provider.api as never, baseUrl: 'https://faux.invalid' });
	providers.push(provider);
	return { provider, model: `${name}/faux-model` };
}

function queryExpectsRows(query: string): boolean {
	const trimmed = query.trimStart().toUpperCase();
	if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) return true;
	if (/\bRETURNING\b/i.test(query)) return true;
	return false;
}

/** In-memory stand-in for DO SQL storage (same shape the coordinator tests use). */
function makeFakeStorage() {
	const db = new DatabaseSync(':memory:');
	return {
		sql: {
			exec(query: string, ...bindings: unknown[]) {
				const stmt = db.prepare(query);
				let rows: unknown[];
				if (queryExpectsRows(query)) {
					rows = stmt.all(...(bindings as never[]));
				} else {
					stmt.run(...(bindings as never[]));
					rows = [];
				}
				return {
					toArray() {
						return rows as Record<string, unknown>[];
					},
				};
			},
		},
		transactionSync<T>(closure: () => T): T {
			db.exec('BEGIN');
			try {
				const result = closure();
				db.exec('COMMIT');
				return result;
			} catch (error) {
				db.exec('ROLLBACK');
				throw error;
			}
		},
	};
}

async function createDefaultEnv() {
	const fs = new InMemoryFs();
	return bashFactoryToSessionEnv(
		() => new Bash({ fs, network: { dangerouslyAllowFullInternetAccess: true } }),
	);
}

/**
 * Seed the process runtime exactly as the generated Cloudflare entry does,
 * with per-instance Durable Object stand-ins created on first contact.
 */
function seedCloudflareRuntime(agentName: string, agent: Agent) {
	const coordinator = createCloudflareAgentRuntime({
		agents: [{ name: agentName, agent }],
		createContext: ({ instance, agentName: name, request, initialEventIndex, dispatchId }) =>
			createFlueContext({
				id: instance.name,
				agentName: name,
				env: instance.env,
				req: request,
				...(initialEventIndex !== undefined ? { initialEventIndex } : {}),
				...(dispatchId !== undefined ? { dispatchId } : {}),
				agentConfig: { resolveModel },
				createDefaultEnv,
			}),
		runWithInstanceContext: (_instance, _agentName, callback) => callback(),
	});

	type Instance = Parameters<typeof coordinator.onRequest>[0];
	const instances = new Map<string, Instance>();
	const getInstance = (instanceId: string): Instance => {
		const existing = instances.get(instanceId);
		if (existing) return existing;
		const storage = makeFakeStorage();
		const instance: Instance = {
			name: instanceId,
			env: {},
			ctx: { id: { toString: () => `do-${instanceId}` }, storage },
			async __unsafe_ensureInitialized() {},
			async schedule() {},
			// Detached, as in the real DO: processing runs behind the admission
			// response; the client observes settlement on the conversation stream.
			async runFiber(_name, callback) {
				void callback({ stash() {} }).catch(() => {});
			},
		};
		coordinator.attach(
			instance,
			coordinator.prepare({ storage, className: 'FlueTestAgent', agentName }),
		);
		instances.set(instanceId, instance);
		return instance;
	};

	configureFlueRuntime({
		target: 'cloudflare',
		agents: [{ name: agentName, agent }],
		...createCloudflareWorkerConfig({
			env: { AGENT_DO: 'do-binding-token' },
			agentIdentities: { [agentName]: { bindingName: 'AGENT_DO', className: 'FlueTestAgent' } },
			fetchAgent: async (_binding, instanceId, request) =>
				(await coordinator.onRequest(getInstance(instanceId), request)) ??
				new Response('Unhandled internal request.', { status: 404 }),
		}),
	});
}

describe('init() on the Cloudflare target', () => {
	it('dispatches and resolves the settled reply over the DO routes', async () => {
		const { provider, model } = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('The nightly report is ready.')]);

		const deliveries: string[] = [];
		function Reporter() {
			useModel(model);
			const delivery = useDelivery();
			deliveries.push(`${delivery.kind}:${delivery.body}`);
			return 'Produce the report when triggered.';
		}
		const reporter = Reporter;
		seedCloudflareRuntime('reporter', reporter);

		const agent = init(reporter, { id: 'nightly-1' });
		const reply = await agent.dispatch('You have been triggered. Produce the nightly report.');
		expect(reply.text).toBe('The nightly report is ready.');
		expect(reply.uid).toEqual(expect.any(String));
		expect(reply.submissionId).toEqual(expect.any(String));
		expect(deliveries).toContain('user:You have been triggered. Produce the nightly report.');
	});

	it('pins the contacted incarnation and rehydrates the 409 as a typed error', async () => {
		const { provider, model } = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('one'), fauxAssistantMessage('two')]);
		const echo = () => {
			useModel(model);
			return 'Reply.';
		};
		seedCloudflareRuntime('echo', echo);

		const agent = init(echo, { id: 'pin-1', uid: null });
		const first = await agent.dispatch('One.');
		const second = await agent.dispatch('Two.');
		expect(second.text).toBe('two');
		expect(second.uid).toBe(first.uid);

		// A NEW create-only handle against the same id rejects with the same
		// typed error the node target throws in-process, existing uid intact —
		// rehydrated from the DO admission route's structured rejection.
		const error = await init(echo, { id: 'pin-1', uid: null })
			.dispatch('Three.')
			.then(
				() => {
					throw new Error('Expected the create-only dispatch to reject.');
				},
				(caught: unknown) => caught,
			);
		expect(error).toBeInstanceOf(AgentInstanceExistsError);
		expect((error as AgentInstanceExistsError).uid).toBe(first.uid);
	});

	it('rejects with AgentRunError when the run fails', async () => {
		const { provider, model } = createFauxProvider();
		provider.setResponses([
			() => {
				throw new Error('provider exploded');
			},
		]);
		const doomed = () => {
			useModel(model);
			return 'Reply.';
		};
		// Durability rides the function as a static; the policy is read through
		// the registry, so register the agent the way the generated entry
		// registers the scanned set.
		doomed.durability = { maxAttempts: 1 };
		registerFlueAgents([{ identity: 'doomed', agent: doomed }]);
		seedCloudflareRuntime('doomed', doomed);

		const error = await init(doomed, { id: 'fail-1' })
			.dispatch('Go.')
			.then(
				() => {
					throw new Error('Expected the dispatch to reject.');
				},
				(caught: unknown) => caught,
			);
		expect(error).toBeInstanceOf(AgentRunError);
		expect((error as AgentRunError).outcome).toBe('failed');
	});

	it('streams projected chunks to onEvent while awaiting', async () => {
		const { provider, model } = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('streamed')]);
		const echo = () => {
			useModel(model);
			return 'Reply.';
		};
		seedCloudflareRuntime('echo', echo);

		const seen: string[] = [];
		const reply = await init(echo, { id: 'events-1' }).dispatch('Go.', {
			onEvent: (chunk) => seen.push(chunk.type),
		});
		expect(reply.text).toBe('streamed');
		expect(seen).toContain('submission-settled');
	});

	it('a fired signal lands a durable abort and rejects with the aborted settlement', async () => {
		const { provider, model } = createFauxProvider();
		let modelCallStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			modelCallStarted = resolve;
		});
		provider.setResponses([
			async (_context, options) => {
				modelCallStarted();
				// Hang until the runtime aborts the attempt. The timer bails into
				// a normal reply so a broken abort path fails the test loudly
				// instead of hanging it.
				await new Promise<void>((resolve) => {
					options?.signal?.addEventListener('abort', () => resolve(), { once: true });
					setTimeout(resolve, 4_000);
				});
				return fauxAssistantMessage('unreachable');
			},
		]);
		const sleeper = () => {
			useModel(model);
			return 'Reply.';
		};
		seedCloudflareRuntime('sleeper', sleeper);

		const controller = new AbortController();
		const pending = init(sleeper, { id: 'abort-1' })
			.dispatch('Go.', { signal: controller.signal })
			.then(
				() => {
					throw new Error('Expected the aborted dispatch to reject.');
				},
				(caught: unknown) => caught,
			);
		await started;
		controller.abort();
		const error = await pending;
		expect(error).toBeInstanceOf(AgentRunError);
		expect((error as AgentRunError).outcome).toBe('aborted');
	});
});
