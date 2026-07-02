import { describe, expect, it, vi } from 'vitest';
import type { CloudflareAgentRuntime } from '../src/cloudflare/agent-coordinator.ts';
import { extend } from '../src/cloudflare/extension.ts';
import { createFlueAgentClass } from '../src/cloudflare/flue-agent-class.ts';

/**
 * Stand-in for the Cloudflare Agents SDK `Agent` base class. Records
 * construction order so the tests can prove `runtime.prepare()` runs before
 * the base constructor — the semantics the old codegen shell encoded as
 * statements ahead of `super()`.
 */
function makeAgentBase(calls: string[]) {
	return class AgentBase {
		ctx: unknown;
		env: unknown;

		constructor(ctx: unknown, env: unknown) {
			calls.push('base-constructor');
			this.ctx = ctx;
			this.env = env;
		}
	};
}

function makeRuntime(calls: string[]) {
	const prepared = { marker: 'prepared' };
	const runtime = {
		prepare: vi.fn((options: { storage: unknown; className: string; agentName: string }) => {
			calls.push('prepare');
			void options;
			return prepared;
		}),
		attach: vi.fn(() => {
			calls.push('attach');
		}),
		onStart: vi.fn(async (_instance: unknown, inherited: () => unknown) => {
			await inherited();
		}),
		wakeSubmissions: vi.fn(async () => {}),
		onRequest: vi.fn(async () => new Response('from-runtime')),
		onFiberRecovered: vi.fn(async (_instance: unknown, _ctx: unknown, inherited: () => unknown) =>
			inherited(),
		),
	};
	return {
		prepared,
		runtime: runtime as unknown as CloudflareAgentRuntime,
		mocks: runtime,
	};
}

const doState = () => ({ storage: { marker: 'storage' } });

describe('createFlueAgentClass()', () => {
	it('names the class after the generated className and subclasses the Agent base', () => {
		const calls: string[] = [];
		const AgentBase = makeAgentBase(calls);
		const { runtime } = makeRuntime(calls);

		const FlueTriageAgent = createFlueAgentClass({
			AgentBase,
			runtime,
			className: 'FlueTriageAgent',
			agentName: 'triage',
		});

		expect(FlueTriageAgent.name).toBe('FlueTriageAgent');
		expect(Object.create(FlueTriageAgent.prototype)).toBeInstanceOf(AgentBase);
	});

	it('prepares the coordinator before the base constructor runs, then attaches', () => {
		const calls: string[] = [];
		const AgentBase = makeAgentBase(calls);
		const { runtime, mocks, prepared } = makeRuntime(calls);

		const FlueTriageAgent = createFlueAgentClass({
			AgentBase,
			runtime,
			className: 'FlueTriageAgent',
			agentName: 'triage',
		});
		const ctx = doState();
		const env = { marker: 'env' };
		const instance = new FlueTriageAgent(ctx, env);

		expect(calls).toEqual(['prepare', 'base-constructor', 'attach']);
		expect(mocks.prepare).toHaveBeenCalledWith({
			storage: ctx.storage,
			className: 'FlueTriageAgent',
			agentName: 'triage',
		});
		expect(mocks.attach).toHaveBeenCalledWith(instance, prepared);
		// The base constructor received the untouched (ctx, env) pair.
		expect((instance as { ctx: unknown }).ctx).toBe(ctx);
		expect((instance as { env: unknown }).env).toBe(env);
	});

	it('delegates onStart to the runtime and forwards inherited onStart with props', async () => {
		const calls: string[] = [];
		const baseOnStart = vi.fn();
		class AgentBase extends makeAgentBase(calls) {
			onStart(props?: Record<string, unknown>) {
				baseOnStart(props);
			}
		}
		const { runtime, mocks } = makeRuntime(calls);

		const FlueTriageAgent = createFlueAgentClass({
			AgentBase,
			runtime,
			className: 'FlueTriageAgent',
			agentName: 'triage',
		});
		const instance = new FlueTriageAgent(doState(), {}) as {
			onStart(props?: Record<string, unknown>): Promise<void>;
		};
		const props = { warm: true };
		await instance.onStart(props);

		expect(mocks.onStart).toHaveBeenCalledTimes(1);
		expect(mocks.onStart.mock.calls[0]?.[0]).toBe(instance);
		expect(baseOnStart).toHaveBeenCalledWith(props);
	});

	it('resolves the inherited onStart callback to undefined when the base has none', async () => {
		const calls: string[] = [];
		const { runtime, mocks } = makeRuntime(calls);

		const FlueTriageAgent = createFlueAgentClass({
			AgentBase: makeAgentBase(calls),
			runtime,
			className: 'FlueTriageAgent',
			agentName: 'triage',
		});
		const instance = new FlueTriageAgent(doState(), {}) as { onStart(): Promise<void> };
		await instance.onStart();

		const inherited = mocks.onStart.mock.calls[0]?.[1] as () => unknown;
		expect(inherited()).toBeUndefined();
	});

	it('delegates onRequest to the runtime', async () => {
		const calls: string[] = [];
		const { runtime, mocks } = makeRuntime(calls);

		const FlueTriageAgent = createFlueAgentClass({
			AgentBase: makeAgentBase(calls),
			runtime,
			className: 'FlueTriageAgent',
			agentName: 'triage',
		});
		const instance = new FlueTriageAgent(doState(), {}) as {
			onRequest(request: Request): Promise<Response | null>;
		};
		const request = new Request('https://flue.invalid/agents/triage/1');
		const response = await instance.onRequest(request);

		expect(mocks.onRequest).toHaveBeenCalledWith(instance, request);
		expect(await response?.text()).toBe('from-runtime');
	});

	it('exposes the __flueWakeAgentSubmissions schedule target', async () => {
		const calls: string[] = [];
		const { runtime, mocks } = makeRuntime(calls);

		const FlueTriageAgent = createFlueAgentClass({
			AgentBase: makeAgentBase(calls),
			runtime,
			className: 'FlueTriageAgent',
			agentName: 'triage',
		});
		const instance = new FlueTriageAgent(doState(), {}) as {
			__flueWakeAgentSubmissions(): Promise<void>;
		};
		await instance.__flueWakeAgentSubmissions();

		expect(mocks.wakeSubmissions).toHaveBeenCalledWith(instance);
	});

	it('delegates onFiberRecovered and forwards the inherited implementation', async () => {
		const calls: string[] = [];
		const baseRecovered = vi.fn((_ctx: unknown) => 'base-recovered');
		class AgentBase extends makeAgentBase(calls) {
			onFiberRecovered(ctx: unknown) {
				return baseRecovered(ctx);
			}
		}
		const { runtime, mocks } = makeRuntime(calls);

		const FlueTriageAgent = createFlueAgentClass({
			AgentBase,
			runtime,
			className: 'FlueTriageAgent',
			agentName: 'triage',
		});
		const instance = new FlueTriageAgent(doState(), {}) as {
			onFiberRecovered(ctx: { name?: string }): Promise<unknown>;
		};
		const fiberContext = { name: 'flue:submission-attempt' };
		const result = await instance.onFiberRecovered(fiberContext);

		expect(mocks.onFiberRecovered).toHaveBeenCalledTimes(1);
		expect(mocks.onFiberRecovered.mock.calls[0]?.[0]).toBe(instance);
		expect(mocks.onFiberRecovered.mock.calls[0]?.[1]).toBe(fiberContext);
		expect(baseRecovered).toHaveBeenCalledWith(fiberContext);
		expect(result).toBe('base-recovered');
	});

	it('applies the extension base callback beneath the generated class', () => {
		const calls: string[] = [];
		const AgentBase = makeAgentBase(calls);
		const { runtime } = makeRuntime(calls);
		let ReceivedBase: unknown;
		class Marker extends AgentBase {
			constructor(ctx: unknown, env: unknown) {
				calls.push('extension-base-constructor');
				super(ctx, env);
			}
		}
		const extension = extend({
			base: (Base) => {
				ReceivedBase = Base;
				return Marker as unknown as typeof Base;
			},
		});

		const FlueTriageAgent = createFlueAgentClass({
			AgentBase,
			runtime,
			className: 'FlueTriageAgent',
			agentName: 'triage',
			extension,
		});
		const instance = new FlueTriageAgent(doState(), {});

		expect(ReceivedBase).toBe(AgentBase);
		expect(instance).toBeInstanceOf(Marker);
		// prepare still precedes every constructor in the chain.
		expect(calls).toEqual(['prepare', 'extension-base-constructor', 'base-constructor', 'attach']);
	});

	it('applies the extension wrap callback around the final named class', () => {
		const calls: string[] = [];
		const { runtime } = makeRuntime(calls);
		let ReceivedFinal: { name: string } | undefined;
		const extension = extend({
			wrap: (Final) => {
				ReceivedFinal = Final;
				return new Proxy(Final, {});
			},
		});

		const FlueTriageAgent = createFlueAgentClass({
			AgentBase: makeAgentBase(calls),
			runtime,
			className: 'FlueTriageAgent',
			agentName: 'triage',
			extension,
		});

		expect(ReceivedFinal?.name).toBe('FlueTriageAgent');
		expect(FlueTriageAgent).not.toBe(ReceivedFinal);
		// Wrapped construction still runs the full prepare/super/attach dance.
		new FlueTriageAgent(doState(), {});
		expect(calls).toEqual(['prepare', 'base-constructor', 'attach']);
	});

	it('rejects a cloudflare export that was not created with extend()', () => {
		const calls: string[] = [];
		const { runtime } = makeRuntime(calls);

		expect(() =>
			createFlueAgentClass({
				AgentBase: makeAgentBase(calls),
				runtime,
				className: 'FlueTriageAgent',
				agentName: 'triage',
				extension: { base: (Base: unknown) => Base },
			}),
		).toThrow(
			'[flue] Agent "triage" cloudflare export must be created with extend({ base, wrap }) from "@flue/runtime/cloudflare".',
		);
	});

	it('treats an undefined extension as identity', () => {
		const calls: string[] = [];
		const AgentBase = makeAgentBase(calls);
		const { runtime } = makeRuntime(calls);

		const FlueTriageAgent = createFlueAgentClass({
			AgentBase,
			runtime,
			className: 'FlueTriageAgent',
			agentName: 'triage',
		});

		expect(Object.getPrototypeOf(FlueTriageAgent)).toBe(AgentBase);
	});
});
