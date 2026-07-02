import { ulid } from 'ulidx';

export function generateSessionAffinityKey(): string {
	return `aff_${ulid()}`;
}

export function generateConversationId(): string {
	return `conv_${ulid()}`;
}

export function generateOperationId(): string {
	return `op_${ulid()}`;
}

export function generateTurnId(): string {
	return `turn_${ulid()}`;
}
