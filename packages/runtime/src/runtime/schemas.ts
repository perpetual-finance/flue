import * as v from 'valibot';
import { InvalidRequestError } from '../errors.ts';
import type { DeliveredMessage } from '../types.ts';

export const MAX_IMAGE_DATA_LENGTH = 14 * 1024 * 1024;

/** Shared attachment shape for both a direct HTTP prompt's `images` and a `DeliveredMessage`'s `attachments`. */
export const DeliveredAttachmentSchema = v.object({
	type: v.literal('image'),
	data: v.pipe(
		v.string(),
		v.maxLength(
			MAX_IMAGE_DATA_LENGTH,
			`Image data exceeds the ${MAX_IMAGE_DATA_LENGTH} character limit.`,
		),
	),
	mimeType: v.string(),
	filename: v.optional(v.string()),
});

/** Wire body for `POST /agents/:name/:id`. Unchanged by the unified delivery model — the route maps this into a `DeliveredMessage` internally. */
export const DirectAgentPayloadSchema = v.object({
	message: v.string(),
	images: v.optional(v.array(DeliveredAttachmentSchema)),
});

const DeliveredUserMessageSchema = v.object({
	kind: v.literal('user'),
	body: v.string(),
	attachments: v.optional(v.array(DeliveredAttachmentSchema)),
});

const DeliveredSignalMessageSchema = v.object({
	kind: v.literal('signal'),
	type: v.pipe(v.string(), v.nonEmpty('Signal message "type" must not be empty.')),
	body: v.string(),
	attributes: v.optional(v.record(v.string(), v.string())),
	tagName: v.optional(v.string()),
});

/**
 * The single validated shape for a message delivered into an agent's
 * session, whether it arrives through `dispatch()` or a direct HTTP prompt
 * (mapped from {@link DirectAgentPayloadSchema} at the HTTP edge).
 */
export const DeliveredMessageSchema = v.variant('kind', [
	DeliveredUserMessageSchema,
	DeliveredSignalMessageSchema,
]);

/**
 * Validate a raw value as a {@link DeliveredMessage}. Shared by `dispatch()`
 * admission and the direct HTTP route (which validates its own wire body
 * with {@link DirectAgentPayloadSchema} first, then runs the `DeliveredMessage`
 * it constructs through this same parse) so both transports produce the same
 * structured {@link InvalidRequestError} on bad input.
 */
export function parseDeliveredMessage(value: unknown): DeliveredMessage {
	const parsed = v.safeParse(DeliveredMessageSchema, value);
	if (parsed.success) return parsed.output;
	const oversizedImageIssue = parsed.issues.find((issue) => issue.type === 'max_length');
	throw new InvalidRequestError({
		reason:
			oversizedImageIssue?.message ??
			'Delivered messages must be { kind: "user", body: string, attachments?: attachment[] } ' +
				'or { kind: "signal", type: string, body: string, attributes?: Record<string, string>, tagName?: string }.',
	});
}

export const WorkflowRouteParamSchema = v.object({ name: v.string() });
/** `?wait` query contract for the workflow invocation route. */
export const InvocationQuerySchema = v.object({
	wait: v.optional(v.literal('result')),
});
export const AgentRouteParamSchema = v.object({ name: v.string(), id: v.string() });
