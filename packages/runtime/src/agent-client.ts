/**
 * `init()` — the programmatic client for one agent instance.
 *
 * The handle is an *address*, not a resource: `init()` creates nothing, and
 * the instance itself is created on first contact exactly as it would be for
 * a dispatch or an HTTP prompt. `prompt()` admits a real direct submission —
 * the prompted message becomes the delivery, and every hook
 * (`useDelivery`, `useAgentStart`, `useAgentFinish`, state, output, joins)
 * fires exactly as it does on the other transports — then waits for the
 * submission to settle and returns the reply. `dispatch()` is the handle's
 * fire-and-forget counterpart.
 *
 * Like `dispatch()`, the handle taps the process's one configured Flue
 * runtime: it works inside a Flue server (a cron callback in app.ts), in a
 * standalone script after `start()` from `@flue/runtime/node`, and under
 * `flue run`. Awaiting a prompt holds no durable state — if the process dies
 * mid-await, the submission itself survives exactly as the configured store
 * persists it, but the awaiting promise is gone. That trade is the point:
 * scripts and CI runs get a plain awaitable call and accept the loss.
 */

import type { ConversationStreamChunk } from './conversation-public.ts';
import { InvalidRequestError } from './errors.ts';
import {
	observeSubmissionSettlement,
	readSubmissionReply,
} from './runtime/conversation-observer.ts';
import { enqueueDispatch } from './runtime/dispatch.ts';
import type { FlueRuntime, NodeRuntime } from './runtime/flue-app.ts';
import { getFlueRuntime } from './runtime/flue-app.ts';
import { generateInstanceId } from './runtime/ids.ts';
import { agentStreamPath } from './runtime/stream-offsets.ts';
import type { AgentModuleValue, DeliveredMessage, DispatchReceipt } from './types.ts';

export interface InitOptions {
	/**
	 * The instance address. Omit to mint a fresh unique one — a throwaway
	 * instance for this run. Pass a stable id (e.g. `nightly-2026-07-08`) to
	 * address an instance that later sends can find again.
	 */
	id?: string;
	/**
	 * Instance-creation data, validated against the agent's `input:` schema.
	 * The seed, consulted only when the handle's first send creates the
	 * instance; ignored after.
	 */
	data?: unknown;
	/**
	 * Send condition for the handle's first contact (uid ≈ ETag): a string
	 * continues only that incarnation, `null` creates only when no instance
	 * exists, omit to send unconditionally. After a prompt receipt, the handle
	 * pins the incarnation it contacted and later prompts continue it.
	 */
	uid?: string | null;
}

export interface AgentPromptOptions {
	/** Receives every projected conversation chunk as it is durably recorded. */
	onEvent?: (chunk: ConversationStreamChunk) => void;
	/**
	 * Abort intent. Firing requests a durable abort of the instance's
	 * in-flight work; the prompt keeps observing and rejects with the
	 * `aborted` settlement once it lands.
	 */
	signal?: AbortSignal;
}

/** The settled reply an awaited prompt resolves with. */
export interface AgentReply {
	/** Final assistant text produced by the submission ('' when none). */
	text: string;
	/** Named client data parts (`useMessageData`) on the reply, keyed by name. */
	data: Record<string, unknown[]>;
	/** Agent-authored response metadata (`useMessageMetadata`), when present. */
	metadata?: Record<string, unknown>;
	/** The contacted incarnation's uid (minted when this send created). */
	uid?: string;
	submissionId: string;
}

/** A prompt whose submission settled `failed` or `aborted`. */
export class AgentRunError extends Error {
	readonly outcome: 'failed' | 'aborted';
	readonly submissionId: string;

	constructor(options: { outcome: 'failed' | 'aborted'; submissionId: string; cause?: unknown }) {
		super(
			`[flue] Agent run ${options.outcome === 'aborted' ? 'was aborted' : 'failed'} ` +
				`(submission ${options.submissionId}).`,
			options.cause === undefined ? undefined : { cause: options.cause },
		);
		this.name = 'AgentRunError';
		this.outcome = options.outcome;
		this.submissionId = options.submissionId;
	}
}

/** A programmatic handle addressing one agent instance. */
export interface AgentInstanceHandle {
	/** The instance address this handle targets. */
	readonly id: string;
	/**
	 * Send one message as a direct submission and await its settled reply.
	 * A string is shorthand for `{ kind: 'user', body }`. Concurrent prompts
	 * to one instance serialize (or join a live response at a turn boundary);
	 * a prompt that joined resolves with the coalesced reply that answered it.
	 * Rejects with {@link AgentRunError} on a failed or aborted settlement.
	 */
	prompt(message: string | DeliveredMessage, options?: AgentPromptOptions): Promise<AgentReply>;
	/** Fire-and-forget delivery to this instance — `dispatch()` bound to the handle. */
	dispatch(message: DeliveredMessage): Promise<DispatchReceipt>;
}

/**
 * Address an agent instance for programmatic control.
 *
 * ```ts
 * const agent = init(reporter, { id: `nightly-${date}`, data: { date } });
 * const reply = await agent.prompt('You have been triggered. Produce the nightly report.');
 * console.log(reply.text);
 * ```
 *
 * The `agent` argument must be a value default-exported by a registered
 * `'use agent'` module (the same contract as `dispatch()`). The runtime is
 * resolved when the handle is used, not when it is created, so `init()` at
 * module scope is safe.
 */
export function init(agent: AgentModuleValue, options: InitOptions = {}): AgentInstanceHandle {
	if (!isAgentDefinitionValue(agent)) {
		throw new InvalidRequestError({
			reason:
				'init() requires an agent definition as its first argument. ' +
				"Pass the default export of a 'use agent' module: init(agent, { id }).",
		});
	}
	if (options.id !== undefined && (typeof options.id !== 'string' || options.id.trim() === '')) {
		throw new Error('[flue] init() requires a non-empty string instance id when one is given.');
	}
	const id = options.id ?? generateInstanceId();

	// The handle's first send carries the creation seed / send condition;
	// afterwards the handle continues the incarnation it contacted.
	let contacted = false;
	let pinnedUid: string | undefined;
	const firstContact = () => ({
		...(options.data !== undefined ? { data: options.data } : {}),
		...('uid' in options && options.uid !== undefined ? { uid: options.uid } : {}),
	});

	return {
		id,

		async prompt(message, promptOptions = {}) {
			const rt = requireRuntime('init');
			const node = requireNodeRuntime(rt);
			const name = resolveAgentName(rt, agent, 'init');
			const delivered: DeliveredMessage =
				typeof message === 'string' ? { kind: 'user', body: message } : message;

			throwIfAborted(promptOptions.signal);
			const admit = node.createAgentAdmission(name, id);
			const receipt = await admit(
				delivered,
				contacted ? { ...(pinnedUid !== undefined ? { uid: pinnedUid } : {}) } : firstContact(),
			);
			contacted = true;
			if (receipt.uid !== undefined) pinnedUid = receipt.uid;

			const path = agentStreamPath(name, id);
			let abortRequested = false;
			const requestAbort = () => {
				if (abortRequested) return;
				abortRequested = true;
				// Durable abort intent; the aborted settlement arrives on the
				// stream, which the observation below keeps watching.
				void node.abortAgentInstance(name, id).catch((error) => {
					console.error('[flue] init() prompt abort request failed:', error);
				});
			};
			if (promptOptions.signal?.aborted) requestAbort();
			promptOptions.signal?.addEventListener('abort', requestAbort, { once: true });

			try {
				const settlement = await observeSubmissionSettlement({
					store: node.conversationStreamStore,
					path,
					submissionId: receipt.submissionId,
					offset: receipt.offset,
					...(promptOptions.onEvent !== undefined ? { onEvent: promptOptions.onEvent } : {}),
				});
				if (settlement.outcome !== 'completed') {
					throw new AgentRunError({
						outcome: settlement.outcome,
						submissionId: receipt.submissionId,
						...(settlement.error === undefined ? {} : { cause: settlement.error }),
					});
				}
				const reply = await readSubmissionReply({
					store: node.conversationStreamStore,
					path,
					submissionId: receipt.submissionId,
				});
				return {
					...reply,
					...(receipt.uid !== undefined ? { uid: receipt.uid } : {}),
					submissionId: receipt.submissionId,
				};
			} finally {
				promptOptions.signal?.removeEventListener('abort', requestAbort);
			}
		},

		async dispatch(message) {
			const rt = requireRuntime('init');
			const name = resolveAgentName(rt, agent, 'init');
			const contact = contacted
				? { ...(pinnedUid !== undefined ? { uid: pinnedUid } : {}) }
				: firstContact();
			const receipt = await enqueueDispatch({
				request: { agent: name, id, message, ...contact },
				dispatchQueue: rt.dispatchQueue,
				rt,
			});
			contacted = true;
			return receipt;
		},
	};
}

function requireRuntime(api: string): FlueRuntime {
	const rt = getFlueRuntime();
	if (!rt) {
		throw new Error(
			`[flue] ${api}() was used before the Flue runtime was configured. ` +
				'Inside a Flue-built server this happens automatically; in a standalone ' +
				"script, call start() from '@flue/runtime/node' first.",
		);
	}
	return rt;
}

function requireNodeRuntime(rt: FlueRuntime): NodeRuntime {
	if (rt.target !== 'node') {
		throw new Error(
			'[flue] init().prompt() is not yet supported on the Cloudflare target. ' +
				'The agent Durable Object serves the same admission, and an implementation ' +
				'over it is planned; use dispatch() or the @flue/sdk client meanwhile.',
		);
	}
	return rt;
}

function resolveAgentName(rt: FlueRuntime, agent: AgentModuleValue, api: string): string {
	const name = rt.agents.find((record) => record.definition === agent)?.name;
	if (!name) {
		throw new Error(
			`[flue] ${api}() target agent definition is not a discovered default-exported agent in this built application.`,
		);
	}
	return name;
}

function isAgentDefinitionValue(value: unknown): value is AgentModuleValue {
	// Twin: `assertAgentDefinitionValue` in registration.ts — keep in sync.
	if (typeof value !== 'object' || value === null) return false;
	return '__flueFunctionAgent' in value && value.__flueFunctionAgent === true;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}
