/**
 * Normalizers for the kind-split delivery verbs. The verb implies the message
 * kind — `dispatch(...)` delivers signals, `prompt(...)` delivers user
 * messages — so callers may omit `kind`, and a message of the other kind is
 * rejected with a pointer to the right verb. Both top-level verbs and the
 * `init()` handle verbs share these, so the grammar cannot drift between the
 * fire-and-forget and awaited surfaces.
 */

import { InvalidRequestError } from '../errors.ts';
import type { AgentSignalMessage, AgentUserMessage, DeliveredMessage } from '../types.ts';

/** Normalize a signal input to the canonical kind-carrying delivered form. */
export function normalizeSignalMessage(
	api: string,
	message: AgentSignalMessage | undefined,
): Extract<DeliveredMessage, { kind: 'signal' }> {
	if (typeof message !== 'object' || message === null) {
		throw new InvalidRequestError({
			reason: `${api} requires a signal message: { type, body, attributes?, tagName? }.`,
		});
	}
	const candidate = message as {
		kind?: string;
		type?: unknown;
		body?: unknown;
		attributes?: Record<string, string>;
		tagName?: string;
	};
	if (candidate.kind === 'user' || ('body' in candidate && candidate.type === undefined)) {
		throw new InvalidRequestError({
			reason:
				`${api} delivers signals — the verb implies \`kind: 'signal'\`. ` +
				'A user message belongs to prompt(...): prompt(agent, { id, message }).',
		});
	}
	if (candidate.kind !== undefined && candidate.kind !== 'signal') {
		throw new InvalidRequestError({
			reason: `${api} received an unknown message kind "${candidate.kind}".`,
		});
	}
	if (typeof candidate.type !== 'string' || candidate.type === '') {
		throw new InvalidRequestError({
			reason: `${api} requires a non-empty signal \`type\` (e.g. 'slack.message').`,
		});
	}
	if (typeof candidate.body !== 'string') {
		throw new InvalidRequestError({
			reason: `${api} requires a string signal \`body\`.`,
		});
	}
	return {
		kind: 'signal',
		type: candidate.type,
		body: candidate.body,
		...(candidate.attributes !== undefined ? { attributes: candidate.attributes } : {}),
		...(candidate.tagName !== undefined ? { tagName: candidate.tagName } : {}),
	};
}

/** Normalize a user input to the canonical kind-carrying delivered form. */
export function normalizeUserMessage(
	api: string,
	message: AgentUserMessage | undefined,
): Extract<DeliveredMessage, { kind: 'user' }> {
	if (typeof message === 'string') return { kind: 'user', body: message };
	if (typeof message !== 'object' || message === null) {
		throw new InvalidRequestError({
			reason: `${api} requires a user message: a string, or { body, attachments? }.`,
		});
	}
	const candidate = message as {
		kind?: string;
		type?: unknown;
		body?: unknown;
		attachments?: Extract<DeliveredMessage, { kind: 'user' }>['attachments'];
	};
	if (candidate.kind === 'signal' || candidate.type !== undefined) {
		throw new InvalidRequestError({
			reason:
				`${api} delivers user messages — the verb implies \`kind: 'user'\`. ` +
				'A signal belongs to dispatch(...): dispatch(agent, { id, message }).',
		});
	}
	if (candidate.kind !== undefined && candidate.kind !== 'user') {
		throw new InvalidRequestError({
			reason: `${api} received an unknown message kind "${candidate.kind}".`,
		});
	}
	if (typeof candidate.body !== 'string') {
		throw new InvalidRequestError({
			reason: `${api} requires a string user message \`body\`.`,
		});
	}
	return {
		kind: 'user',
		body: candidate.body,
		...(candidate.attachments !== undefined ? { attachments: candidate.attachments } : {}),
	};
}
