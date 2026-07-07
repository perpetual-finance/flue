import * as v from 'valibot';
import { discoverSessionContext } from './context.ts';
import { ConversationRecordWriter } from './conversation-writer.ts';
import { Harness } from './harness.ts';
import type { RenderStateContext } from './hooks/frame.ts';
import {
	type AgentRenderStructure,
	assertRenderStructureInvariance,
	renderAgentFunctionWithStructure,
} from './hooks/render.ts';
import { createHookStateBuffer, type HookStateBuffer } from './hooks/state.ts';
import { type AgentOutputChannel, createAgentOutputChannel } from './message-output.ts';
import { type AttachmentStore, InMemoryAttachmentStore } from './runtime/attachment-store.ts';
import { InMemoryConversationStreamStore } from './runtime/conversation-stream-store.ts';
import { dispatchGlobalEvent } from './runtime/events.ts';
import { agentStreamPath } from './runtime/stream-offsets.ts';
import { createCwdSessionEnv } from './sandbox.ts';
import type { SessionRerender } from './session.ts';
import type {
	AgentConfig,
	AgentModuleValue,
	AgentRuntimeConfig,
	DeliveredMessage,
	FlueEvent,
	FlueEventCallback,
	FlueEventContext,
	FlueEventInput,
	FlueObservationDetail,
	SandboxFactory,
	SessionEnv,
	SessionToolFactory,
} from './types.ts';

export interface FlueContextConfig {
	id: string;
	agentName?: string;
	dispatchId?: string;
	env: Record<string, any>;
	/**
	 * Host-provided agent-config seeds (`resolveModel` and runtime-wide defaults).
	 * `systemPrompt`, `skills`, and `model` are
	 * runtime-owned — discovered from the session cwd and resolved from the
	 * agent definition during harness initialization — so they are not inputs.
	 */
	agentConfig: Omit<AgentConfig, 'systemPrompt' | 'skills' | 'model'>;
	createDefaultEnv: () => Promise<SessionEnv>;
	/**
	 * The current HTTP request, if any. Surfaced to handlers as `ctx.req`.
	 * Build plugins pass the standard Fetch `Request` through; non-HTTP entry
	 * points (e.g. future cron triggers) leave it undefined.
	 */
	req?: Request;
	initialEventIndex?: number;
	conversationWriter?: ConversationRecordWriter;
	attachmentStore?: AttachmentStore;
}

/** Extends FlueEventContext with server-only methods. */
export interface FlueContextInternal extends FlueEventContext {
	/**
	 * `delivery` is the submission's delivered message; renders read it via
	 * `useDelivery()`. Omit for invocations no delivered message triggered.
	 */
	initializeRootHarness(
		agent: AgentModuleValue,
		delivery?: DeliveredMessage,
		data?: unknown,
	): Promise<Harness>;
	createEvent(event: FlueEventInput): FlueEvent;
	publishEvent(event: FlueEvent): void;
	emitEvent(event: FlueEventInput, observation?: FlueObservationDetail): FlueEvent;
	subscribeEvent(callback: FlueEventCallback): () => void;
	flushEventCallbacks(): Promise<void>;
	setEventCallback(callback: FlueEventCallback | undefined): void;
	setSubmissionId(submissionId: string | undefined): void;
	setConversationWriter?(writer: ConversationRecordWriter | undefined): void;
	setAttachmentStore?(store: AttachmentStore | undefined): void;
}

export function createFlueContext(config: FlueContextConfig): FlueContextInternal {
	const subscribers = new Set<FlueEventCallback>();
	let handlerUnsubscribe: (() => void) | undefined;
	const pendingEventCallbacks = new Set<Promise<void>>();
	let eventCallbackError: unknown;
	let eventIndex = config.initialEventIndex ?? 0;
	let submissionId: string | undefined;
	let conversationWriter = config.conversationWriter;
	let attachmentStore = config.attachmentStore;
	let localConversationRuntime:
		| Promise<{
				writer: ConversationRecordWriter;
				attachments: AttachmentStore;
		  }>
		| undefined;

	const createEvent = (event: FlueEventInput): FlueEvent => ({
		...event,
		instanceId: config.id,
		...(config.dispatchId === undefined ? {} : { dispatchId: config.dispatchId }),
		...(submissionId === undefined ? {} : { submissionId }),
		...(config.agentName === undefined ? {} : { agentName: config.agentName }),
		v: 3,
		eventIndex: eventIndex++,
		timestamp: new Date().toISOString(),
	});

	const publishEvent = (decorated: FlueEvent, observation?: FlueObservationDetail): void => {
		for (const subscriber of subscribers) {
			try {
				const callback = subscriber(decorated);
				if (callback instanceof Promise) {
					const pending = callback
						.catch((error) => {
							eventCallbackError ??= error;
						})
						.finally(() => pendingEventCallbacks.delete(pending));
					pendingEventCallbacks.add(pending);
				}
			} catch (error) {
				eventCallbackError ??= error;
			}
		}
		// Fan out to module-scoped subscribers registered via
		// `observe()` from `@flue/runtime`. These run after the
		// per-context subscribers and receive the originating `ctx` as
		// a second argument so cross-cutting code can read runtime identity
		// and environment metadata.
		dispatchGlobalEvent(decorated, ctx, observation);
	};

	const emitEvent = (event: FlueEventInput, observation?: FlueObservationDetail): FlueEvent => {
		const decorated = createEvent(event);
		publishEvent(decorated, observation);
		return decorated;
	};

	const ctx: FlueContextInternal = {
		get id() {
			return config.id;
		},

		get agentName() {
			return config.agentName;
		},

		get env() {
			return config.env;
		},

		get req() {
			return config.req;
		},

		async initializeRootHarness(
			agent: AgentModuleValue,
			delivery?: DeliveredMessage,
			data?: unknown,
		): Promise<Harness> {
			if (!conversationWriter || !attachmentStore) {
				localConversationRuntime ??= createLocalConversationRuntime(config);
				const local = await localConversationRuntime;
				conversationWriter ??= local.writer;
				attachmentStore ??= local.attachments;
			}
			return initializeRootHarness(
				agent,
				{ ...config, conversationWriter, attachmentStore },
				emitEvent,
				delivery,
				data,
			);
		},

		log: {
			info(message, attributes) {
				emitEvent({
					type: 'log',
					level: 'info',
					message,
					attributes: normalizeLogAttributes(attributes),
				});
			},
			warn(message, attributes) {
				emitEvent({
					type: 'log',
					level: 'warn',
					message,
					attributes: normalizeLogAttributes(attributes),
				});
			},
			error(message, attributes) {
				emitEvent({
					type: 'log',
					level: 'error',
					message,
					attributes: normalizeLogAttributes(attributes),
				});
			},
		},

		createEvent,

		publishEvent,

		emitEvent,

		subscribeEvent(callback: FlueEventCallback): () => void {
			subscribers.add(callback);
			return () => subscribers.delete(callback);
		},

		async flushEventCallbacks(): Promise<void> {
			await Promise.all(pendingEventCallbacks);
			if (eventCallbackError !== undefined) {
				const error = eventCallbackError;
				eventCallbackError = undefined;
				throw error;
			}
		},

		setEventCallback(callback: FlueEventCallback | undefined): void {
			handlerUnsubscribe?.();
			handlerUnsubscribe = callback ? ctx.subscribeEvent(callback) : undefined;
		},

		setSubmissionId(value: string | undefined): void {
			submissionId = value;
		},

		setConversationWriter(value: ConversationRecordWriter | undefined): void {
			conversationWriter = value;
		},

		setAttachmentStore(value: AttachmentStore | undefined): void {
			attachmentStore = value;
		},
	};

	return ctx;
}

async function createLocalConversationRuntime(config: FlueContextConfig): Promise<{
	writer: ConversationRecordWriter;
	attachments: AttachmentStore;
}> {
	const store = new InMemoryConversationStreamStore();
	const path = agentStreamPath(config.agentName ?? 'agent', config.id);
	return {
		writer: await ConversationRecordWriter.create({
			store,
			path,
			identity: { agentName: config.agentName ?? 'agent', instanceId: config.id },
			producerId: `execution:${config.id}`,
		}),
		attachments: new InMemoryAttachmentStore(),
	};
}

export async function initializeRootHarness(
	agent: AgentModuleValue,
	config: FlueContextConfig,
	emitEvent: (event: FlueEventInput, observation?: FlueObservationDetail) => void,
	delivery?: DeliveredMessage,
	data?: unknown,
): Promise<Harness> {
	const label = 'The agent';
	if (!config.conversationWriter || !config.attachmentStore) {
		throw new Error('[flue] Canonical conversation runtime is not configured.');
	}
	// useState reads the instance's reduced state snapshot at render time and
	// writes through this buffer, which the session drains into the tool
	// batch's append. One buffer per harness lifetime (one submission attempt).
	const reduced = await config.conversationWriter.loadReducedState();
	// Instance-creation data. Once the root conversation exists, the recorded
	// value wins forever (data on later messages is deliberately ignored, and
	// nothing re-validates). On first contact — including re-attempts of the
	// creating submission, which run before the birth record lands — the
	// incoming value is validated against the agent's `input:` schema; the
	// schema-parsed output is what renders see and what the birth record
	// stores.
	let initialData: unknown;
	let creationData: unknown;
	if (reduced.initialData) {
		initialData = reduced.initialData.value;
	} else {
		initialData = data;
		if (agent.config.input !== undefined) {
			const parsedData = v.safeParse(agent.config.input, data);
			if (!parsedData.success) {
				throw new Error(
					`[flue] ${label} requires creation data matching its input schema: ${parsedData.issues
						.map((issue) => issue.message)
						.join('; ')}. Creation data rides the instance's first message ({ data, ... }).`,
				);
			}
			initialData = parsedData.output;
		}
		creationData = initialData;
	}
	const hookState = createHookStateBuffer(reduced.state);
	const outputChannel = createAgentOutputChannel();
	// The delivery is constant for the harness lifetime (one submission
	// attempt), so the first render and every per-turn re-render read the
	// same triggering input through `useDelivery()`.
	const renderState: RenderStateContext = {
		snapshot: reduced.state,
		store: hookState,
		output: outputChannel,
		delivery,
		instanceId: config.id,
		initialData,
	};
	const first = renderAgentFunctionWithStructure(agent.capability, agent.config, renderState);
	const resolvedOptions: AgentRuntimeConfig = first.config;
	let lastStructure: AgentRenderStructure = first.structure;
	// The render composes the config: hooks validated every attachment when it
	// was declared, and defineAgent validated the static fields at module load.
	const definition = resolvedOptions;
	if (typeof definition.model !== 'string') {
		throw new Error(
			`[flue] ${label} requires a model. Pass { model: "provider-id/model-id" } to defineAgent(Agent, config).`,
		);
	}
	const resolvedModel = config.agentConfig.resolveModel(definition.model);
	if (!resolvedModel) {
		throw new Error(`[flue] ${label} model "${definition.model}" could not be resolved.`);
	}
	const { env: baseEnv, toolFactory } = await resolveSessionEnv(
		config.id,
		resolvedOptions.sandbox,
		config,
	);
	const env = resolvedOptions.cwd
		? createCwdSessionEnv(baseEnv, baseEnv.resolvePath(resolvedOptions.cwd))
		: baseEnv;
	const localContext = await discoverSessionContext(
		env,
		definition.instructions,
		definition.skills,
	);
	const agentConfig: AgentConfig = {
		...config.agentConfig,
		systemPrompt: localContext.systemPrompt,
		instructions: definition.instructions,
		definitionSkills: definition.skills,
		skills: localContext.skills,
		subagents: Object.fromEntries(
			(definition.subagents ?? []).map((candidate) => [candidate.name, candidate]),
		),
		model: resolvedModel,
		thinkingLevel: definition.thinkingLevel ?? config.agentConfig.thinkingLevel,
		compaction: definition.compaction ?? config.agentConfig.compaction,
		durability: definition.durability,
	};
	// Per-turn re-render: fresh closures over the latest state values, the
	// structural-invariance guard, and a recomposed system prompt. The session
	// applies the result at each turn boundary, so mid-run state writes reach
	// the very next model call (guards read current truth; interpolated text
	// stays live).
	const rerender: SessionRerender = () => {
		const next = renderAgentFunctionWithStructure(agent.capability, agent.config, renderState);
		assertRenderStructureInvariance(lastStructure, next.structure);
		lastStructure = next.structure;
		return {
			systemPrompt: localContext.recompose(next.config.instructions),
			tools: next.config.tools ?? [],
		};
	};
	return new Harness(
		config.id,
		'default',
		agentConfig,
		env,
		emitEvent,
		definition.tools ?? [],
		toolFactory,
		config.conversationWriter,
		config.attachmentStore,
		{ instanceId: config.id },
		undefined,
		undefined,
		undefined,
		undefined,
		hookState,
		rerender,
		outputChannel,
		creationData,
	);
}

function normalizeLogAttributes(
	attributes: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!attributes) return undefined;
	if (!(attributes.error instanceof Error)) return attributes;
	return {
		...attributes,
		error: serializeLogError(attributes.error),
	};
}

function serializeLogError(error: Error): Record<string, unknown> {
	return {
		name: error.name,
		message: error.message,
		stack: error.stack,
	};
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isSandboxFactory(value: unknown): value is SandboxFactory {
	return (
		typeof value === 'object' &&
		value !== null &&
		'createSessionEnv' in value &&
		typeof (value as any).createSessionEnv === 'function'
	);
}

/** Resolve sandbox option to its session environment and optional tool factory. */
async function resolveSessionEnv(
	id: string,
	sandbox: AgentRuntimeConfig['sandbox'],
	config: FlueContextConfig,
): Promise<{ env: SessionEnv; toolFactory?: SessionToolFactory }> {
	if (sandbox === undefined) {
		return { env: await config.createDefaultEnv() };
	}
	if (isSandboxFactory(sandbox)) {
		const env = await sandbox.createSessionEnv({ id });
		return { env, toolFactory: sandbox.tools };
	}
	throw new Error('[flue] Invalid sandbox option returned from defineAgent().');
}
