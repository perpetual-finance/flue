import type { FlueObservation } from '@flue/runtime';
import { context, type Meter, propagation, type Span, SpanKind, type SpanOptions, SpanStatusCode, type Tracer, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it } from 'vitest';
import {
	createOpenTelemetryInstrumentation,
	FLUE_TELEMETRY_EXTENSION_REVISION,
	GEN_AI_PROJECTION_REVISION,
	GEN_AI_SCHEMA_URL,
	GEN_AI_SEMCONV_REVISION,
} from '../src/index.ts';

class RecordingSpan {
	attributes: Record<string, unknown> = {};
	status?: { code: number };
	ended = false;
	exceptions: unknown[] = [];
	constructor(readonly name: string, readonly options?: SpanOptions) {
		Object.assign(this.attributes, options?.attributes);
	}
	setAttribute(name: string, value: unknown) {
		this.attributes[name] = value;
		return this;
	}
	setAttributes(values: Record<string, unknown>) {
		Object.assign(this.attributes, values);
		return this;
	}
	setStatus(status: { code: number }) {
		this.status = status;
		return this;
	}
	recordException(error: unknown) {
		this.exceptions.push(error);
	}
	end() {
		this.ended = true;
	}
	spanContext() {
		return { traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 1 };
	}
	addEvent() {
		return this;
	}
	addLink() {
		return this;
	}
	addLinks() {
		return this;
	}
	updateName() {
		return this;
	}
	isRecording() {
		return true;
	}
}

class RecordingTracer {
	spans: RecordingSpan[] = [];
	startSpan(name: string, options?: SpanOptions) {
		const span = new RecordingSpan(name, options);
		this.spans.push(span);
		return span as unknown as Span;
	}
}

function observation(value: Record<string, unknown>): FlueObservation {
	return {
		...value,
		v: 3,
		eventIndex: value.eventIndex ?? 0,
		timestamp: value.timestamp ?? '2026-06-22T00:00:00.000Z',
	} as unknown as FlueObservation;
}

const ctx = { id: 'instance-1', agentName: 'assistant', env: {}, req: undefined } as never;

let provider: BasicTracerProvider | undefined;
let contextManager: AsyncLocalStorageContextManager | undefined;

afterEach(async () => {
	context.disable();
	propagation.disable();
	contextManager?.disable();
	contextManager = undefined;
	await provider?.shutdown();
	provider = undefined;
});

function realTracer() {
	const exporter = new InMemorySpanExporter();
	provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
	contextManager = new AsyncLocalStorageContextManager().enable();
	context.setGlobalContextManager(contextManager);
	propagation.setGlobalPropagator(new W3CTraceContextPropagator());
	return { exporter, tracer: provider.getTracer('test') };
}

describe('createOpenTelemetryInstrumentation()', () => {
	it('emits standard inference and tool spans without content when capture is disabled', () => {
		const tracer = new RecordingTracer();
		const instrumentation = createOpenTelemetryInstrumentation({ tracer: tracer as unknown as Tracer });
		instrumentation.observe(
			observation({
				type: 'operation_start',
				instanceId: 'instance-1',
				agentName: 'assistant',
				conversationId: 'conv_01KT3P3GZGFBCKHKMQ11A7H2HW',
				operationId: 'op-1',
				operationKind: 'prompt',
			}),
			ctx,
		);
		instrumentation.observe(
			observation({
				type: 'turn_request',
				instanceId: 'instance-1',
				conversationId: 'conv_01KT3P3GZGFBCKHKMQ11A7H2HW',
				operationId: 'op-1',
				turnId: 'turn-1',
				purpose: 'agent',
				request: { providerId: 'gateway-id', providerName: 'gateway', requestedModel: 'model-1', api: 'openai-responses', input: { messages: [{ role: 'user', content: 'secret' }] } },
			}),
			ctx,
		);
		instrumentation.observe(
			observation({
				type: 'turn',
				instanceId: 'instance-1',
				conversationId: 'conv_01KT3P3GZGFBCKHKMQ11A7H2HW',
				operationId: 'op-1',
				turnId: 'turn-1',
				purpose: 'agent',
				durationMs: 10,
				request: { providerId: 'gateway-id', providerName: 'gateway', requestedModel: 'model-1', api: 'openai-responses' },
				response: { responseId: 'resp-1', responseModel: 'model-actual', output: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] }, finishReason: 'toolUse', usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 1, totalTokens: 7, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
				isError: false,
			}),
			ctx,
		);
		const agent = tracer.spans[0];
		const chat = tracer.spans[1];
		expect(agent?.name).toBe('invoke_agent assistant');
		expect(agent?.options?.kind).toBe(SpanKind.INTERNAL);
		expect(chat?.name).toBe('chat model-1');
		expect(chat?.options?.kind).toBe(SpanKind.CLIENT);
		expect(chat?.attributes).toMatchObject({
			'gen_ai.operation.name': 'chat',
			'gen_ai.provider.name': 'gateway',
			'gen_ai.request.model': 'model-1',
			'gen_ai.request.stream': true,
			'gen_ai.response.id': 'resp-1',
			'gen_ai.response.model': 'model-actual',
			'gen_ai.usage.input_tokens': 5,
		});
		expect(chat?.attributes).not.toHaveProperty('gen_ai.input.messages');
		expect(chat?.ended).toBe(true);
	});

	it('emits OpenAI API type only for authoritative OpenAI provider identities', () => {
		const tracer = new RecordingTracer();
		const instrumentation = createOpenTelemetryInstrumentation({ tracer: tracer as unknown as Tracer });
		for (const [turnId, providerName, api] of [
			['turn-openai', 'openai', 'openai-responses'],
			['turn-azure', 'azure.ai.openai', 'azure-openai-responses'],
			['turn-gateway', 'company.gateway', 'openai-completions'],
		] as const) {
			instrumentation.observe(observation({
				type: 'turn_request', turnId, purpose: 'agent',
				request: { providerId: providerName, providerName, requestedModel: 'm', api, input: { messages: [] } },
			}), ctx);
		}

		expect(tracer.spans[0]?.attributes['openai.api.type']).toBe('responses');
		expect(tracer.spans[1]?.attributes).not.toHaveProperty('openai.api.type');
		expect(tracer.spans[2]?.attributes).not.toHaveProperty('openai.api.type');
	});

	it('applies one content transform before standard JSON serialization', () => {
		const tracer = new RecordingTracer();
		const instrumentation = createOpenTelemetryInstrumentation({
			tracer: tracer as unknown as Tracer,
			content: {
				enabled: true,
				transform(content) {
					return JSON.parse(JSON.stringify(content).replaceAll('secret', '[redacted]'));
				},
			},
		});
		instrumentation.observe(
			observation({
				type: 'turn_request',
				turnId: 'turn-1',
				purpose: 'agent',
				request: { providerId: 'openai', providerName: 'openai', requestedModel: 'model-1', api: 'openai-responses', input: { messages: [{ role: 'user', content: 'secret' }] } },
			}),
			ctx,
		);
		const serialized = tracer.spans[0]?.attributes['gen_ai.input.messages'];
		expect(typeof serialized).toBe('string');
		expect(serialized).toContain('[redacted]');
		expect(serialized).not.toContain('secret');
	});

	it('allows transform mutation only on a detached value', () => {
		const tracer = new RecordingTracer();
		const messages = [{ role: 'user', content: 'original' }] as const;
		const instrumentation = createOpenTelemetryInstrumentation({
			tracer: tracer as unknown as Tracer,
			content: {
				enabled: true,
				transform(content) {
					const [message] = content as Array<{ parts: Array<{ content: string }> }>;
					const [part] = message?.parts ?? [];
					if (!part) throw new Error('Expected transformed message content.');
					part.content = 'changed';
					return content;
				},
			},
		});
		instrumentation.observe(observation({
			type: 'turn_request', turnId: 'turn-1', purpose: 'agent',
			request: { providerId: 'p', providerName: 'p', requestedModel: 'm', api: 'a', input: { messages } },
		}), ctx);
		expect(messages[0].content).toBe('original');
		expect(tracer.spans[0]?.attributes['gen_ai.input.messages']).toContain('changed');
	});

	it('exports effective tool output instead of the product transport envelope', () => {
		const tracer = new RecordingTracer();
		const instrumentation = createOpenTelemetryInstrumentation({
			tracer: tracer as unknown as Tracer,
			content: { enabled: true },
		});
		instrumentation.observe(observation({
			type: 'tool_start', toolCallId: 'tool-1', toolName: 'lookup', origin: 'model', args: {},
		}), ctx);
		instrumentation.observe(observation({
			type: 'tool', toolCallId: 'tool-1', toolName: 'lookup', origin: 'model', toolType: 'function', isError: false,
			result: { content: [{ type: 'text', text: '{"found":true}' }], details: { customTool: 'lookup', output: { found: true } } },
			effectiveResult: { found: true }, durationMs: 1,
		}), ctx);

		expect(tracer.spans[0]?.attributes['gen_ai.tool.call.result']).toBe('{"found":true}');

		instrumentation.observe(observation({
			type: 'tool_start', toolCallId: 'tool-2', toolName: 'nullable', origin: 'model', args: {},
		}), ctx);
		instrumentation.observe(observation({
			type: 'tool', toolCallId: 'tool-2', toolName: 'nullable', origin: 'model', toolType: 'function', isError: false,
			result: { content: [{ type: 'text', text: 'null' }], details: { output: null } },
			effectiveResult: null, durationMs: 1,
		}), ctx);
		expect(tracer.spans[1]?.attributes['flue.tool.call.result']).toBe('null');
		expect(tracer.spans[1]?.attributes).not.toHaveProperty('gen_ai.tool.call.result');
	});

	it('records authoritative client duration, inclusive token usage, and exception logs', () => {
		const tracer = new RecordingTracer();
		const created: Array<{ name: string; unit?: string }> = [];
		const records: Array<{ name: string; value: number; attributes?: Record<string, unknown> }> = [];
		const logs: Array<Record<string, unknown>> = [];
		const meter = {
			createHistogram(name: string, options?: { unit?: string }) {
				created.push({ name, unit: options?.unit });
				return { record(value: number, attributes?: Record<string, unknown>) { records.push({ name, value, attributes }); } };
			},
		} as unknown as Meter;
		const instrumentation = createOpenTelemetryInstrumentation({
			tracer: tracer as unknown as Tracer,
			meter,
			logger: { emit(record) { logs.push(record); } },
		});
		instrumentation.observe(observation({
			type: 'turn_request', turnId: 'turn-1', purpose: 'agent',
			request: { providerId: 'p', providerName: 'p', requestedModel: 'm', api: 'a', input: { messages: [] } },
		}), ctx);
		instrumentation.observe(observation({
			type: 'turn', turnId: 'turn-1', purpose: 'agent', durationMs: 1250,
			request: { providerId: 'p', providerName: 'p', requestedModel: 'm', api: 'a' },
			response: {
				usage: { input: 3, output: 2, cacheRead: 4, cacheWrite: 5, totalTokens: 14, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				error: { type: 'rate_limit' },
			}, isError: true,
		}), ctx);

		expect(created).toEqual(expect.arrayContaining([
			{ name: 'gen_ai.client.operation.duration', unit: 's' },
			{ name: 'gen_ai.client.token.usage', unit: '{token}' },
			{ name: 'gen_ai.invoke_agent.duration', unit: 's' },
			{ name: 'gen_ai.execute_tool.duration', unit: 's' },
		]));
		expect(records).toContainEqual(expect.objectContaining({ name: 'gen_ai.client.operation.duration', value: 1.25, attributes: expect.objectContaining({ 'error.type': 'rate_limit' }) }));
		expect(records).toContainEqual(expect.objectContaining({ name: 'gen_ai.client.token.usage', value: 12, attributes: expect.objectContaining({ 'gen_ai.token.type': 'input' }) }));
		expect(records).toContainEqual(expect.objectContaining({ name: 'gen_ai.client.token.usage', value: 2, attributes: expect.objectContaining({ 'gen_ai.token.type': 'output' }) }));
		expect(Object.keys(records[0]?.attributes ?? {})).not.toEqual(expect.arrayContaining(['flue.turn.id', 'gen_ai.conversation.id']));
		expect(logs).toEqual([expect.objectContaining({ eventName: 'gen_ai.client.operation.exception', severityNumber: 13, severityText: 'WARN', attributes: expect.objectContaining({ 'exception.type': 'rate_limit' }) })]);
	});

	it('ends failed inference spans when metric and logger emission throw', () => {
		const tracer = new RecordingTracer();
		const diagnostics: string[] = [];
		const meter = {
			createHistogram() {
				return { record() { throw new Error('metric failed'); } };
			},
		} as unknown as Meter;
		const instrumentation = createOpenTelemetryInstrumentation({
			tracer: tracer as unknown as Tracer,
			meter,
			logger: { emit() { throw new Error('logger failed'); } },
			diagnostic(value) { diagnostics.push(value.type); },
		});
		instrumentation.observe(observation({
			type: 'turn_request', turnId: 'turn-1', purpose: 'agent',
			request: { providerId: 'p', providerName: 'p', requestedModel: 'm', api: 'a', input: { messages: [] } },
		}), ctx);
		instrumentation.observe(observation({
			type: 'turn', turnId: 'turn-1', purpose: 'agent', durationMs: 25,
			request: { providerId: 'p', providerName: 'p', requestedModel: 'm', api: 'a' },
			response: { error: { type: 'rate_limit' } }, isError: true,
		}), ctx);

		expect(tracer.spans[0]?.ended).toBe(true);
		expect(diagnostics).toEqual(['metric_record_error', 'log_emit_error']);
	});

	it('captures caller input and output on invoke-agent without model history', () => {
		const tracer = new RecordingTracer();
		const instrumentation = createOpenTelemetryInstrumentation({
			tracer: tracer as unknown as Tracer,
			content: { enabled: true },
		});
		instrumentation.observe(observation({
			type: 'operation_start', operationId: 'op-1', operationKind: 'prompt', conversationId: 'conv-1',
		}), ctx);
		instrumentation.observe(observation({
			type: 'operation', operationId: 'op-1', operationKind: 'prompt', conversationId: 'conv-1', durationMs: 1, isError: false,
			result: { text: 'answer' },
			agentInput: { text: 'current prompt' },
			agentOutput: { type: 'text', text: 'answer', finishReason: 'stop' },
		}), ctx);

		expect(tracer.spans[0]?.attributes['gen_ai.input.messages']).toContain('current prompt');
		expect(tracer.spans[0]?.attributes['gen_ai.output.messages']).toContain('answer');
		expect(tracer.spans[0]?.attributes['gen_ai.output.messages']).toContain('finish_reason');
	});

	it('omits structured caller output instead of coercing it into a model message', () => {
		const tracer = new RecordingTracer();
		const instrumentation = createOpenTelemetryInstrumentation({
			tracer: tracer as unknown as Tracer,
			content: { enabled: true },
		});
		instrumentation.observe(observation({
			type: 'operation_start', operationId: 'op-1', operationKind: 'prompt', conversationId: 'conv-1',
		}), ctx);
		instrumentation.observe(observation({
			type: 'operation', operationId: 'op-1', operationKind: 'prompt', conversationId: 'conv-1', durationMs: 1, isError: false,
			result: { data: { count: 2 } },
			agentInput: { text: 'count items' },
			agentOutput: { type: 'data', data: { count: 2 } },
		}), ctx);

		expect(tracer.spans[0]?.attributes['gen_ai.input.messages']).toContain('count items');
		expect(tracer.spans[0]?.attributes).not.toHaveProperty('gen_ai.output.messages');
	});

	it('sets low-cardinality error type and omits exception content by default', () => {
		const tracer = new RecordingTracer();
		const instrumentation = createOpenTelemetryInstrumentation({ tracer: tracer as unknown as Tracer });
		instrumentation.observe(
			observation({ type: 'turn_request', turnId: 'turn-1', purpose: 'agent', request: { providerId: 'p', providerName: 'p', requestedModel: 'm', api: 'a', input: { messages: [] } } }),
			ctx,
		);
		instrumentation.observe(
			observation({ type: 'turn', turnId: 'turn-1', purpose: 'agent', durationMs: 1, request: { providerId: 'p', providerName: 'p', requestedModel: 'm', api: 'a' }, response: { error: { type: 'rate_limit', message: 'sensitive' } }, isError: true }),
			ctx,
		);
		expect(tracer.spans[0]?.attributes['error.type']).toBe('rate_limit');
		expect(tracer.spans[0]?.status?.code).toBe(SpanStatusCode.ERROR);
		expect(tracer.spans[0]?.exceptions).toEqual([{ name: 'rate_limit' }]);
	});

	it('ends only spans owned by an operation when that operation ends during concurrent activity', () => {
		const tracer = new RecordingTracer();
		const instrumentation = createOpenTelemetryInstrumentation({ tracer: tracer as unknown as Tracer });
		for (const event of [
			{ type: 'operation_start', instanceId: 'instance-a', operationId: 'shared-operation', operationKind: 'prompt' },
			{ type: 'turn_request', instanceId: 'instance-a', operationId: 'shared-operation', turnId: 'shared-turn', purpose: 'agent', request: { providerId: 'p', providerName: 'p', requestedModel: 'm', api: 'a', input: { messages: [] } } },
			{ type: 'operation_start', instanceId: 'instance-b', operationId: 'shared-operation', operationKind: 'prompt' },
			{ type: 'turn_request', instanceId: 'instance-b', operationId: 'shared-operation', turnId: 'shared-turn', purpose: 'agent', request: { providerId: 'p', providerName: 'p', requestedModel: 'm', api: 'a', input: { messages: [] } } },
			{ type: 'operation_start', instanceId: 'instance-direct', operationId: 'op-direct', operationKind: 'prompt' },
		] satisfies Record<string, unknown>[]) instrumentation.observe(observation(event), ctx);

		instrumentation.observe(observation({ type: 'operation', instanceId: 'instance-a', operationId: 'shared-operation', operationKind: 'prompt', durationMs: 1, isError: false }), ctx);

		const operationSpan = (instanceId: string) => tracer.spans.find((candidate) =>
			candidate.attributes['flue.instance.id'] === instanceId && candidate.attributes['flue.operation.id'] === 'shared-operation' && candidate.attributes['flue.turn.id'] === undefined,
		);
		const turnSpan = (instanceId: string) => tracer.spans.find((candidate) =>
			candidate.attributes['flue.instance.id'] === instanceId && candidate.attributes['flue.turn.id'] === 'shared-turn',
		);
		expect(operationSpan('instance-a')?.ended).toBe(true);
		expect(turnSpan('instance-a')?.ended).toBe(true);
		expect(operationSpan('instance-b')?.ended).toBe(false);
		expect(turnSpan('instance-b')?.ended).toBe(false);
		expect(tracer.spans.find((candidate) => candidate.attributes['flue.operation.id'] === 'op-direct')?.ended).toBe(false);
	});

	it('suppresses framework task tool spans and correlates the task span', () => {
		const tracer = new RecordingTracer();
		const instrumentation = createOpenTelemetryInstrumentation({ tracer: tracer as unknown as Tracer });
		instrumentation.observe(observation({
			type: 'tool_start', toolCallId: 'call-1', toolName: 'task', origin: 'framework', args: { prompt: 'delegate' },
		}), ctx);
		instrumentation.observe(observation({
			type: 'task_start', taskId: 'task-1', toolCallId: 'call-1', prompt: 'delegate', agent: 'researcher',
		}), ctx);
		instrumentation.observe(observation({
			type: 'tool', toolCallId: 'call-1', toolName: 'task', origin: 'framework', toolType: 'function', isError: false, result: 'done', durationMs: 1,
		}), ctx);

		expect(tracer.spans).toHaveLength(1);
		expect(tracer.spans[0]?.name).toBe('invoke_agent researcher');
		expect(tracer.spans[0]?.attributes['gen_ai.tool.call.id']).toBe('call-1');
	});

	it('creates one span when a tool start is duplicated', () => {
		const tracer = new RecordingTracer();
		const instrumentation = createOpenTelemetryInstrumentation({ tracer: tracer as unknown as Tracer });
		const start = observation({
			type: 'tool_start',
			operationId: 'op-1',
			turnId: 'turn-1',
			toolCallId: 'tool-1',
			toolName: 'lookup',
			origin: 'model',
		});

		instrumentation.observe(start, ctx);
		instrumentation.observe(start, ctx);
		instrumentation.observe(
			observation({
				type: 'tool',
				operationId: 'op-1',
				turnId: 'turn-1',
				toolCallId: 'tool-1',
				toolName: 'lookup',
				origin: 'model',
				toolType: 'function',
				isError: false,
				durationMs: 1,
				result: 'ok',
			}),
			ctx,
		);

		expect(tracer.spans.filter((span) => span.name === 'execute_tool lookup')).toHaveLength(1);
		expect(tracer.spans[0]?.ended).toBe(true);
	});

	it('activates the tool span matching complete execution identity', async () => {
		const { exporter, tracer } = realTracer();
		const instrumentation = createOpenTelemetryInstrumentation({ tracer });
		for (const instanceId of ['instance-a', 'instance-b']) {
			instrumentation.observe(observation({ type: 'operation_start', instanceId, harness: 'default', conversationId: 'shared-conversation', session: 'default', operationId: `operation-${instanceId}`, operationKind: 'prompt' }), ctx);
			instrumentation.observe(observation({ type: 'tool_start', instanceId, harness: 'default', conversationId: 'shared-conversation', session: 'default', operationId: `operation-${instanceId}`, turnId: `turn-${instanceId}`, toolCallId: 'shared-tool', toolName: 'lookup', origin: 'model' }), ctx);
		}

		let activeSpanId: string | undefined;
		await instrumentation.interceptor(
			{ type: 'tool', toolCallId: 'shared-tool', toolName: 'lookup' },
			{ instanceId: 'instance-b', harness: 'default', conversationId: 'shared-conversation', session: 'default', operationId: 'operation-instance-b', turnId: 'turn-instance-b' },
			async () => {
				activeSpanId = trace.getSpan(context.active())?.spanContext().spanId;
			},
		);
		instrumentation.dispose();

		const expected = exporter.getFinishedSpans().find((candidate) => candidate.attributes['flue.instance.id'] === 'instance-b' && candidate.name === 'execute_tool lookup');
		expect(activeSpanId).toBe(expected?.spanContext().spanId);
	});

	it('activates admitted trace context when no tracked span matches', async () => {
		const { tracer } = realTracer();
		const instrumentation = createOpenTelemetryInstrumentation({ tracer });
		const carrier = { traceparent: '00-11111111111111111111111111111111-2222222222222222-01' };
		let active: { traceId: string; spanId: string } | undefined;

		await instrumentation.interceptor(
			{ type: 'agent', operationId: 'op-untracked', operationKind: 'prompt' },
			{ traceCarrier: carrier },
			async () => {
				const spanContext = trace.getSpan(context.active())?.spanContext();
				active = spanContext ? { traceId: spanContext.traceId, spanId: spanContext.spanId } : undefined;
			},
		);

		expect(active).toEqual({
			traceId: '11111111111111111111111111111111',
			spanId: '2222222222222222',
		});
	});

	it('parents a direct agent root span to active durable trace context', async () => {
		const { exporter, tracer } = realTracer();
		const instrumentation = createOpenTelemetryInstrumentation({ tracer });
		const carrier = { traceparent: '00-11111111111111111111111111111111-2222222222222222-01' };
		const extracted = propagation.extract(context.active(), carrier);

		await context.with(extracted, async () => {
			instrumentation.observe(
				observation({ type: 'operation_start', instanceId: 'instance-1', operationId: 'op-1', operationKind: 'prompt' }),
				ctx,
			);
			instrumentation.observe(
				observation({ type: 'operation', instanceId: 'instance-1', operationId: 'op-1', operationKind: 'prompt', durationMs: 1, isError: false }),
				ctx,
			);
		});

		const span = exporter.getFinishedSpans().find((candidate) => candidate.name === 'invoke_agent');
		expect(span?.spanContext().traceId).toBe('11111111111111111111111111111111');
		expect(span?.parentSpanContext?.spanId).toBe('2222222222222222');
	});

	it('delivers detached transformed message content externally without changing inline content', () => {
		const tracer = new RecordingTracer();
		const delivered: unknown[] = [];
		const instrumentation = createOpenTelemetryInstrumentation({
			tracer: tracer as unknown as Tracer,
			content: {
				enabled: true,
				transform(content) {
					return JSON.parse(JSON.stringify(content).replaceAll('secret', '[redacted]'));
				},
				externalContent(content) {
					delivered.push(content);
					const [message] = content as Array<{ parts: Array<{ content: string }> }>;
					const [part] = message?.parts ?? [];
					if (!part) throw new Error('Expected external message content.');
					part.content = 'external mutation';
					return [{ role: 'user', parts: [] }];
				},
			},
		});
		instrumentation.observe(observation({
			type: 'turn_request',
			turnId: 'turn-1',
			purpose: 'agent',
			request: { providerId: 'p', providerName: 'p', requestedModel: 'm', api: 'a', input: { messages: [{ role: 'user', content: 'secret' }] } },
		}), ctx);

		expect(delivered).toHaveLength(1);
		expect(tracer.spans[0]?.attributes['gen_ai.input.messages']).toBe('[{"role":"user","parts":[{"type":"text","content":"[redacted]"}]}]');
	});

	it('delivers external content with stable scope when inline capture is disabled', () => {
		const tracer = new RecordingTracer();
		const scopes: Array<{ contentType: string; eventType: string; turnId?: string; span: Span }> = [];
		const instrumentation = createOpenTelemetryInstrumentation({
			tracer: tracer as unknown as Tracer,
			content: {
				enabled: true,
				inline: false,
				externalContent(_content, scope) {
					scopes.push(scope);
				},
			},
		});
		instrumentation.observe(observation({
			type: 'turn_request',
			turnId: 'turn-1',
			purpose: 'agent',
			request: { providerId: 'p', providerName: 'p', requestedModel: 'm', api: 'a', input: { systemPrompt: 'system', messages: [{ role: 'user', content: 'input' }], tools: [{ name: 'lookup', description: 'tool', parameters: {} }] } },
		}), ctx);

		expect(scopes.map((scope) => scope.contentType)).toEqual(['input_messages', 'system_instructions']);
		expect(scopes[0]).toMatchObject({ eventType: 'turn_request', turnId: 'turn-1', span: tracer.spans[0] });
		expect(tracer.spans[0]?.attributes).not.toHaveProperty('gen_ai.input.messages');
		expect(tracer.spans[0]?.attributes).not.toHaveProperty('gen_ai.tool.definitions');
	});

	it('isolates external content and diagnostic failures from inline capture', () => {
		const tracer = new RecordingTracer();
		const diagnostics: Array<{ type: string; message: string; error?: unknown }> = [];
		const instrumentation = createOpenTelemetryInstrumentation({
			tracer: tracer as unknown as Tracer,
			diagnostic(diagnostic) {
				diagnostics.push(diagnostic);
				throw new Error('diagnostic failed');
			},
			content: {
				enabled: true,
				externalContent() {
					throw new Error('external failed');
				},
			},
		});
		instrumentation.observe(observation({
			type: 'turn_request',
			turnId: 'turn-1',
			purpose: 'agent',
			request: { providerId: 'p', providerName: 'p', requestedModel: 'm', api: 'a', input: { messages: [{ role: 'user', content: 'safe' }] } },
		}), ctx);

		expect(tracer.spans[0]?.attributes['gen_ai.input.messages']).toContain('safe');
		expect(diagnostics).toEqual([{ type: 'external_content_error', message: 'External content delivery failed.' }]);
	});

	it('suppresses both destinations when transform returns undefined or capture is disabled', () => {
		for (const content of [
			{ enabled: true, transform: () => undefined },
			{ enabled: false, externalContent: () => { throw new Error('must not run'); } },
		]) {
			const tracer = new RecordingTracer();
			let deliveries = 0;
			const instrumentation = createOpenTelemetryInstrumentation({
				tracer: tracer as unknown as Tracer,
				content: { ...content, externalContent: () => { deliveries += 1; } },
			});
			instrumentation.observe(observation({
				type: 'turn_request',
				turnId: 'turn-1',
				purpose: 'agent',
				request: { providerId: 'p', providerName: 'p', requestedModel: 'm', api: 'a', input: { messages: [{ role: 'user', content: 'secret' }] } },
			}), ctx);
			expect(deliveries).toBe(0);
			expect(tracer.spans[0]?.attributes).not.toHaveProperty('gen_ai.input.messages');
			expect(tracer.spans[0]?.attributes['flue.telemetry.content.input_messages.omitted']).toBeUndefined();
		}
	});

	it('diagnoses transform failures without exposing content or error details', () => {
		const tracer = new RecordingTracer();
		const diagnostics: Array<{ type: string; message: string; error?: unknown }> = [];
		const instrumentation = createOpenTelemetryInstrumentation({
			tracer: tracer as unknown as Tracer,
			diagnostic: (diagnostic) => diagnostics.push(diagnostic),
			content: { enabled: true, transform() { throw new Error('secret failure'); } },
		});
		instrumentation.observe(observation({
			type: 'turn_request',
			turnId: 'turn-1',
			purpose: 'agent',
			request: { providerId: 'p', providerName: 'p', requestedModel: 'm', api: 'a', input: { messages: [{ role: 'user', content: 'secret' }] } },
		}), ctx);

		expect(tracer.spans[0]?.attributes).not.toHaveProperty('gen_ai.input.messages');
		expect(diagnostics).toEqual([{ type: 'content_transform_error', message: 'Content transform failed.' }]);
	});

	it('applies structural limits after transform while retaining ordered atomic parts', () => {
		const tracer = new RecordingTracer();
		const instrumentation = createOpenTelemetryInstrumentation({
			tracer: tracer as unknown as Tracer,
			content: {
				enabled: true,
				limits: { maxMessageParts: 1, maxToolDefinitions: 1 },
				transform(content, scope) {
					if (scope.contentType === 'system_instructions') return [...(content as unknown[]), { type: 'text', content: 'second' }];
					return content;
				},
			},
		});
		instrumentation.observe(observation({
			type: 'turn_request',
			turnId: 'turn-1',
			purpose: 'agent',
			request: {
				providerId: 'p', providerName: 'p', requestedModel: 'm', api: 'a',
				input: {
					systemPrompt: 'first',
					messages: [{ role: 'user', content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] }],
					tools: [{ name: 'first', parameters: { type: 'object' } }, { name: 'second', parameters: { type: 'object' } }],
				},
			},
		}), ctx);

		expect(JSON.parse(tracer.spans[0]?.attributes['gen_ai.input.messages'] as string)[0].parts).toEqual([{ type: 'text', content: 'first' }]);
		expect(JSON.parse(tracer.spans[0]?.attributes['gen_ai.system_instructions'] as string)).toEqual([{ type: 'text', content: 'first' }]);
		expect(JSON.parse(tracer.spans[0]?.attributes['gen_ai.tool.definitions'] as string).map((tool: { name: string }) => tool.name)).toEqual(['first']);
		expect(tracer.spans[0]?.attributes).toMatchObject({
			'flue.telemetry.content.input_messages.truncated': true,
			'flue.telemetry.content.system_instructions.truncated': true,
			'flue.telemetry.content.tool_definitions.truncated': true,
		});
		expect(Object.keys(tracer.spans[0]?.attributes ?? {})).not.toEqual(
			expect.arrayContaining([expect.stringContaining('omitted_count')]),
		);

		instrumentation.observe(observation({
			type: 'turn', turnId: 'turn-1', purpose: 'agent', durationMs: 1,
			request: { providerId: 'p', providerName: 'p', requestedModel: 'm', api: 'a' },
			response: { output: { role: 'assistant', content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] }, finishReason: 'stop' },
			isError: false,
		}), ctx);
		expect(JSON.parse(tracer.spans[0]?.attributes['gen_ai.output.messages'] as string)[0].parts).toEqual([{ type: 'text', content: 'first' }]);
		expect(tracer.spans[0]?.attributes['flue.telemetry.content.output_messages.truncated']).toBe(true);
	});

	it('supports zero structural limits and exact UTF-8 inline byte boundaries', () => {
		for (const maxAttributeBytes of [2, 1]) {
			const tracer = new RecordingTracer();
			const instrumentation = createOpenTelemetryInstrumentation({
				tracer: tracer as unknown as Tracer,
				content: { enabled: true, limits: { maxAttributeBytes, maxMessageParts: 0 } },
			});
			instrumentation.observe(observation({ type: 'tool_start', toolCallId: 'tool-1', toolName: 'lookup', origin: 'model', description: 'é' }), ctx);
			expect(tracer.spans[0]?.attributes['gen_ai.tool.description']).toBe(maxAttributeBytes === 2 ? 'é' : undefined);
			instrumentation.observe(observation({
				type: 'turn_request', turnId: 'turn-1', purpose: 'agent',
				request: { providerId: 'p', providerName: 'p', requestedModel: 'm', api: 'a', input: { messages: [{ role: 'user', content: 'x' }] } },
			}), ctx);
			expect(tracer.spans[1]?.attributes['flue.telemetry.content.input_messages.truncated']).toBe(true);
		}
	});

	it('omits standard output messages when a finish reason is unavailable', () => {
		const tracer = new RecordingTracer();
		const delivered: unknown[] = [];
		const instrumentation = createOpenTelemetryInstrumentation({
			tracer: tracer as unknown as Tracer,
			content: { enabled: true, externalContent: (content) => { delivered.push(content); } },
		});
		instrumentation.observe(observation({
			type: 'turn_request', turnId: 'turn-1', purpose: 'agent',
			request: { providerId: 'p', providerName: 'p', requestedModel: 'm', api: 'a', input: { messages: [] } },
		}), ctx);
		instrumentation.observe(observation({
			type: 'turn', turnId: 'turn-1', purpose: 'agent', durationMs: 1,
			request: { providerId: 'p', providerName: 'p', requestedModel: 'm', api: 'a' },
			response: { output: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
			isError: false,
		}), ctx);

		expect(tracer.spans[0]?.attributes).not.toHaveProperty('gen_ai.output.messages');
		expect(delivered).toEqual([[]]);
	});

	it('serializes transformed structured tool values but leaves descriptions raw', () => {
		const tracer = new RecordingTracer();
		const instrumentation = createOpenTelemetryInstrumentation({
			tracer: tracer as unknown as Tracer,
			content: {
				enabled: true,
				transform(content, scope) {
					if (scope.contentType === 'tool_description') return 'changed';
					if (scope.contentType === 'tool_arguments') return { changed: content };
					return content;
				},
			},
		});
		instrumentation.observe(observation({ type: 'tool_start', toolCallId: 'tool-1', toolName: 'lookup', origin: 'model', description: 'original', args: { id: 1 } }), ctx);
		expect(tracer.spans[0]?.attributes['gen_ai.tool.description']).toBe('changed');
		expect(tracer.spans[0]?.attributes['gen_ai.tool.call.arguments']).toBe('{"changed":{"id":1}}');
	});

	it('uses privacy-controlled bounded fallbacks for non-object tool content', () => {
		const enabledTracer = new RecordingTracer();
		const enabled = createOpenTelemetryInstrumentation({
			tracer: enabledTracer as unknown as Tracer,
			content: { enabled: true },
		});
		enabled.observe(observation({
			type: 'tool_start', toolCallId: 'tool-0', toolName: 'lookup', origin: 'model', args: ['secret'],
		}), ctx);
		enabled.observe(observation({
			type: 'tool', toolCallId: 'tool-0', toolName: 'lookup', origin: 'model', toolType: 'function', isError: false, result: 'plain text', durationMs: 1,
		}), ctx);
		expect(enabledTracer.spans[0]?.attributes['flue.tool.call.arguments']).toBe('["secret"]');
		expect(enabledTracer.spans[0]?.attributes['flue.tool.call.result']).toBe('plain text');

		for (const content of [undefined, { enabled: true, limits: { maxAttributeBytes: 3 } }] as const) {
			const tracer = new RecordingTracer();
			const instrumentation = createOpenTelemetryInstrumentation({ tracer: tracer as unknown as Tracer, content });
			instrumentation.observe(observation({
				type: 'tool_start', toolCallId: 'tool-1', toolName: 'lookup', origin: 'model', args: ['secret'],
			}), ctx);
			instrumentation.observe(observation({
				type: 'tool', toolCallId: 'tool-1', toolName: 'lookup', origin: 'model', toolType: 'function', isError: false, result: 'secret', durationMs: 1,
			}), ctx);

			expect(tracer.spans[0]?.attributes).not.toHaveProperty('gen_ai.tool.call.arguments');
			expect(tracer.spans[0]?.attributes).not.toHaveProperty('gen_ai.tool.call.result');
			expect(tracer.spans[0]?.attributes).not.toHaveProperty('flue.tool.call.arguments');
			expect(tracer.spans[0]?.attributes).not.toHaveProperty('flue.tool.call.result');
		}
	});

	it('records processed exception details on spans and inference logs', () => {
		const tracer = new RecordingTracer();
		const logs: Array<Record<string, unknown>> = [];
		const instrumentation = createOpenTelemetryInstrumentation({
			tracer: tracer as unknown as Tracer,
			logger: { emit(record) { logs.push(record); } },
			content: {
				enabled: true,
				transform(content, scope) {
					return scope.contentType === 'exception_message' ? String(content).replace('secret', '[redacted]') : content;
				},
			},
		});
		instrumentation.observe(observation({
			type: 'turn_request', turnId: 'turn-1', purpose: 'agent',
			request: { providerId: 'p', providerName: 'p', requestedModel: 'm', api: 'a', input: { messages: [] } },
		}), ctx);
		instrumentation.observe(observation({
			type: 'turn', turnId: 'turn-1', purpose: 'agent', durationMs: 1,
			request: { providerId: 'p', providerName: 'p', requestedModel: 'm', api: 'a' },
			response: { error: { type: 'provider_error', message: 'secret failure' } }, isError: true,
		}), ctx);

		expect(tracer.spans[0]?.exceptions).toEqual([{ name: 'provider_error', message: '[redacted] failure' }]);
		expect(logs[0]?.attributes).toMatchObject({
			'error.type': 'provider_error',
			'exception.type': 'provider_error',
			'exception.message': '[redacted] failure',
		});
	});

	it('rejects invalid content limits', () => {
		for (const value of [-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
			expect(() => createOpenTelemetryInstrumentation({ content: { enabled: true, limits: { maxMessageParts: value } } })).toThrow(TypeError);
		}
	});

	it('exports pinned compatibility revisions', () => {
		expect(GEN_AI_PROJECTION_REVISION).toBe(5);
		expect(FLUE_TELEMETRY_EXTENSION_REVISION).toBe(3);
		expect(GEN_AI_SEMCONV_REVISION).toBe('4c8addb53718b544134be47e256237026fe88875');
		expect(GEN_AI_SCHEMA_URL).toBe('https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev');
	});
});
