import * as v from 'valibot';
import { InvalidRequestError } from '../errors.ts';
import type { DeliveredMessage } from '../types.ts';

export const MAX_IMAGE_DATA_LENGTH = 14 * 1024 * 1024;
export const MAX_PRIVATE_CONTEXT_BYTES = 64 * 1024;
const MAX_PRIVATE_CONTEXT_BASE64_LENGTH = 4 * Math.ceil(MAX_PRIVATE_CONTEXT_BYTES / 3);

const OpaquePrivateContextSchema = v.strictObject({
	encoding: v.literal('base64'),
	data: v.pipe(
		v.string(),
		v.nonEmpty('Private context data must not be empty.'),
		v.maxLength(
			MAX_PRIVATE_CONTEXT_BASE64_LENGTH,
			`Private context exceeds the ${MAX_PRIVATE_CONTEXT_BYTES} byte limit.`,
		),
	),
	sha256: v.pipe(
		v.string(),
		v.regex(/^[0-9a-f]{64}$/, 'Private context sha256 must be 64 lowercase hexadecimal characters.'),
	),
});

/** Attachment shape for a `DeliveredMessage`'s `attachments`. */
const DeliveredAttachmentSchema = v.object({
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

const DeliveredUserMessageSchema = v.object({
	kind: v.literal('user'),
	body: v.string(),
	attachments: v.optional(v.array(DeliveredAttachmentSchema)),
	privateContext: v.optional(OpaquePrivateContextSchema),
});

const DeliveredSignalMessageSchema = v.object({
	kind: v.literal('signal'),
	type: v.pipe(v.string(), v.nonEmpty('Signal message "type" must not be empty.')),
	body: v.string(),
	attributes: v.optional(v.record(v.string(), v.string())),
	privateContext: v.optional(OpaquePrivateContextSchema),
	// The tag name is rendered unescaped as the signal's XML envelope in model
	// context, so it must be a valid XML name — anything looser would let a
	// caller-controlled value inject markup that the body/attribute escaping
	// exists to prevent.
	tagName: v.optional(
		v.pipe(
			v.string(),
			v.regex(
				/^[A-Za-z_][A-Za-z0-9_.-]*$/,
				'Signal message "tagName" must be a valid XML tag name ' +
					'(letters, digits, "_", "-", "."; must not start with a digit, "-", or ".").',
			),
		),
	),
});

/**
 * The single validated shape for a message delivered into an agent's
 * session, whether it arrives through `dispatch()` or a direct HTTP prompt
 * (whose wire body is this shape verbatim).
 */
export const DeliveredMessageSchema = v.variant('kind', [
	DeliveredUserMessageSchema,
	DeliveredSignalMessageSchema,
]);

/**
 * Validate a raw value as a {@link DeliveredMessage}. Shared by `dispatch()`
 * admission and the direct HTTP route so both transports produce the same
 * structured {@link InvalidRequestError} on bad input.
 */
export function parseDeliveredMessage(value: unknown): DeliveredMessage {
	const parsed = v.safeParse(DeliveredMessageSchema, value);
	if (parsed.success) return parsed.output;
	const specificIssue = parsed.issues.find(
		(issue) => issue.type === 'max_length' || issue.type === 'regex' || issue.type === 'non_empty',
	);
	throw new InvalidRequestError({
		reason:
			specificIssue?.message ??
			'Delivered messages must be { kind: "user", body: string, attachments?: attachment[], privateContext?: opaqueContext } ' +
				'or { kind: "signal", type: string, body: string, attributes?: Record<string, string>, tagName?: string, privateContext?: opaqueContext }.',
	});
}

export const WorkflowRouteParamSchema = v.object({ name: v.string() });
/** `?wait` query contract for the workflow invocation route. */
export const InvocationQuerySchema = v.object({
	wait: v.optional(v.literal('result')),
});
export const AgentRouteParamSchema = v.object({ name: v.string(), id: v.string() });
