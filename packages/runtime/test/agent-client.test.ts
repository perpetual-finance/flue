import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	registerFauxProvider,
} from '@earendil-works/pi-ai/compat';
import * as v from 'valibot';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRunError, init } from '../src/agent-client.ts';
import { defineAgent } from '../src/agent-definition.ts';
import { InvalidRequestError } from '../src/errors.ts';
import { useAgentFinish } from '../src/hooks/use-agent-finish.ts';
import { useAgentStart } from '../src/hooks/use-agent-start.ts';
import { useDelivery } from '../src/hooks/use-delivery.ts';
import { useInitialData } from '../src/hooks/use-initial-data.ts';
import { useMessageMetadata } from '../src/hooks/use-message-metadata.ts';
import { type Flue, start } from '../src/node/start.ts';
import { resetFlueRuntimeForTests } from '../src/runtime/flue-app.ts';
import { registerProvider, resetProviderRuntime } from '../src/runtime/providers.ts';

const providers: FauxProviderRegistration[] = [];
const started: Flue[] = [];

afterEach(async () => {
	for (const flue of started.splice(0)) {
		try {
			await flue.stop();
		} catch {}
	}
	resetFlueRuntimeForTests();
	resetProviderRuntime();
	for (const provider of providers.splice(0)) provider.unregister();
});

/**
 * A faux provider resolvable through the REAL `resolveModel` — the same
 * wiring the CLI e2e fixtures use: pi-ai's faux api provider + a Flue
 * `registerProvider` entry so `<name>/faux-model` resolves without test
 * injection (start() wires `resolveModel` itself; nothing is injectable,
 * which is the point).
 */
function createFauxProvider(): { provider: FauxProviderRegistration; model: string } {
	const name = `faux-agent-client-${crypto.randomUUID()}`;
	const provider = registerFauxProvider({ provider: name, models: [{ id: 'faux-model' }] });
	registerProvider(name, { api: provider.api as never, baseUrl: 'https://faux.invalid' });
	providers.push(provider);
	return { provider, model: `${name}/faux-model` };
}

async function startFlue(...agents: Parameters<typeof start>[0]['agents']) {
	const flue = await start({ agents });
	started.push(flue);
	return flue;
}

describe('start() + init(): the scripted client', () => {
	it('dispatches a message and resolves the settled reply with full hook parity', async () => {
		const { provider, model } = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('The nightly report is ready.')]);

		const deliveries: string[] = [];
		let startRuns = 0;
		let finishRuns = 0;
		function Reporter() {
			const delivery = useDelivery();
			deliveries.push(`${delivery.kind}:${delivery.body}`);
			useAgentStart(async () => {
				startRuns += 1;
			});
			useAgentFinish(async () => {
				finishRuns += 1;
			});
			return 'Produce the report when triggered.';
		}
		const reporter = defineAgent(Reporter, { model });

		await startFlue({ name: 'reporter', agent: reporter });
		const agent = init(reporter);
		expect(agent.id).toMatch(/^instance_/);

		const reply = await agent.dispatch('You have been triggered. Produce the nightly report.');
		expect(reply.text).toBe('The nightly report is ready.');
		expect(reply.uid).toEqual(expect.any(String));
		expect(reply.submissionId).toEqual(expect.any(String));

		// The dispatched string became the user-message delivery, and the
		// lifecycle hooks ran — exactly as for any other transport.
		expect(deliveries).toContain('user:You have been triggered. Produce the nightly report.');
		expect(startRuns).toBe(1);
		expect(finishRuns).toBe(1);
	});

	it('seeds creation data readable via useInitialData', async () => {
		const { provider, model } = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('Seeded.')]);

		let seenData: unknown;
		function Seeded() {
			seenData = useInitialData<{ date: string }>();
			return 'Reply.';
		}
		const seeded = defineAgent(Seeded, {
			model,
			input: v.object({ date: v.string() }),
		});

		await startFlue({ name: 'seeded', agent: seeded });
		const reply = await init(seeded, { data: { date: '2026-07-08' } }).dispatch('Go.');
		expect(reply.text).toBe('Seeded.');
		expect(seenData).toEqual({ date: '2026-07-08' });
	});

	it('pins the contacted incarnation: create-only handles continue across sends', async () => {
		const { provider, model } = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('one'), fauxAssistantMessage('two')]);
		const echo = defineAgent(() => 'Reply.', { model });

		await startFlue({ name: 'echo', agent: echo });
		const agent = init(echo, { id: 'pin-1', uid: null });
		const first = await agent.dispatch('One.');
		// The second send continues the incarnation the handle contacted; the
		// init-time create-only condition applies to first contact only.
		const second = await agent.dispatch('Two.');
		expect(second.text).toBe('two');
		expect(second.uid).toBe(first.uid);

		// A NEW create-only handle against the same id still rejects.
		await expect(init(echo, { id: 'pin-1', uid: null }).dispatch('Three.')).rejects.toThrow();
	});

	it('rejects with AgentRunError when the submission settles failed', async () => {
		const { provider, model } = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('doomed')]);
		function Doomed() {
			useMessageMetadata('finish', () => {
				throw new Error('finish boom');
			});
			return 'Reply.';
		}
		const doomed = defineAgent(Doomed, { model });

		await startFlue({ name: 'doomed', agent: doomed });
		const error = await init(doomed)
			.dispatch('Go.')
			.then(
				() => undefined,
				(thrown: unknown) => thrown,
			);
		expect(error).toBeInstanceOf(AgentRunError);
		expect((error as AgentRunError).outcome).toBe('failed');
		expect((error as AgentRunError).submissionId).toEqual(expect.any(String));
	});

	it('awaits both message kinds through the one verb', async () => {
		const { provider, model } = createFauxProvider();
		provider.setResponses([
			fauxAssistantMessage('signal ack'),
			fauxAssistantMessage('question reply'),
		]);

		const deliveries: string[] = [];
		function Listener() {
			const delivery = useDelivery();
			deliveries.push(`${delivery.kind}:${delivery.body}`);
			return 'Reply.';
		}
		const listener = defineAgent(Listener, { model });

		await startFlue({ name: 'listener', agent: listener });
		const agent = init(listener, { id: 'dispatch-1' });
		// The handle is the awaited surface: a signal (explicit kind) resolves
		// with the reply that answered it — its durable settled record,
		// unified across submission kinds, is what the await observes.
		const ack = await agent.dispatch({
			kind: 'signal',
			type: 'trigger',
			body: 'from the script',
		});
		expect(ack.text).toBe('signal ack');
		expect(ack.submissionId).toEqual(expect.any(String));
		expect(deliveries).toContain('signal:from the script');
		// A user message right behind the awaited signal settles cleanly (this
		// interleaving used to fail with "the session advanced past this
		// input" before joined deliveries classified as continuation input).
		const reply = await agent.dispatch('And a question right behind it.');
		expect(reply.text).toBe('question reply');
		expect(deliveries).toContain('user:And a question right behind it.');
	});

	it('handle.dispatch() rejects with AgentRunError when the run fails', async () => {
		const { provider, model } = createFauxProvider();
		provider.setResponses([
			() => {
				throw new Error('provider exploded');
			},
		]);
		const echo = defineAgent(() => 'Reply.', { model, durability: { maxAttempts: 1 } });

		await startFlue({ name: 'echo', agent: echo });
		const error = await init(echo, { id: 'dispatch-fail-1' })
			.dispatch({ kind: 'signal', type: 'trigger', body: 'boom' })
			.then(
				() => {
					throw new Error('Expected the dispatch to reject.');
				},
				(caught: unknown) => caught,
			);
		expect(error).toBeInstanceOf(AgentRunError);
		expect((error as AgentRunError).outcome).toBe('failed');
		expect((error as AgentRunError).submissionId).toEqual(expect.any(String));
	});

	it('streams projected chunks to onEvent while awaiting', async () => {
		const { provider, model } = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('streamed')]);
		const echo = defineAgent(() => 'Reply.', { model });

		await startFlue({ name: 'echo', agent: echo });
		const seen: string[] = [];
		const reply = await init(echo).dispatch('Go.', { onEvent: (chunk) => seen.push(chunk.type) });
		expect(reply.text).toBe('streamed');
		expect(seen).toContain('submission-settled');
	});

	it('guards: start() refuses a configured process; unstarted init() throws with guidance', async () => {
		const { model } = createFauxProvider();
		const echo = defineAgent(() => 'Reply.', { model });

		await expect(init(echo).dispatch('Go.')).rejects.toThrow(
			/before the Flue runtime was configured/,
		);

		await startFlue({ name: 'echo', agent: echo });
		await expect(start({ agents: [{ name: 'echo', agent: echo }] })).rejects.toThrow(
			/already-configured Flue runtime/,
		);
	});

	it('init() validates its arguments eagerly', async () => {
		expect(() => init({} as never)).toThrow(InvalidRequestError);
		const { model } = createFauxProvider();
		const echo = defineAgent(() => 'Reply.', { model });
		expect(() => init(echo, { id: ' ' })).toThrow(/non-empty string instance id/);
	});
});
