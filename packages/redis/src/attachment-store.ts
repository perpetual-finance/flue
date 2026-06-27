import {
	AttachmentConflictError,
	type AttachmentOwner,
	type AttachmentRef,
	type AttachmentStore,
	attachmentBytesEqual,
	type BindSubmissionAttachmentInput,
	copyAttachmentBytes,
	type GetAttachmentInput,
	type PutAttachmentInput,
	type StoredAttachment,
	sameAttachmentOwner,
	sameAttachmentRef,
	verifyAttachmentBytes,
} from '@flue/runtime/adapter';
import type { RedisKeys } from './redis-keys.ts';
import type { RedisRunner } from './redis-runner.ts';

interface AttachmentRecord extends StoredAttachment { owner: AttachmentOwner }

export class RedisAttachmentStore implements AttachmentStore {
	constructor(private runner: RedisRunner, private keys: RedisKeys) {}

	async put(input: PutAttachmentInput): Promise<void> {
		await verifyAttachmentBytes(input.attachment, input.bytes);
		const existing = await this.read(input.streamPath, input.attachment.id);
		if (existing) {
			if (!sameAttachmentRef(existing.attachment, input.attachment) || !sameAttachmentOwner(existing.owner, input.owner) || !attachmentBytesEqual(existing.bytes, input.bytes)) conflict(input);
			return;
		}
		const ownerId = input.owner.kind === 'conversation' ? input.owner.conversationId : input.owner.submissionId;
		const result = await this.runner.eval(
			PUT,
			[
				this.keys.attachment(input.streamPath, input.attachment.id),
				this.keys.attachments(input.streamPath),
			],
			[input.attachment.mimeType, input.attachment.size, input.attachment.digest, input.owner.kind, ownerId, copyAttachmentBytes(input.bytes), Date.now(), input.attachment.id],
		);
		if (Number(result) !== 1) {
			const accepted = await this.read(input.streamPath, input.attachment.id);
			if (!accepted || !sameAttachmentRef(accepted.attachment, input.attachment) || !sameAttachmentOwner(accepted.owner, input.owner) || !attachmentBytesEqual(accepted.bytes, input.bytes)) conflict(input);
		}
	}

	async get(input: GetAttachmentInput): Promise<StoredAttachment | null> {
		const record = await this.read(input.streamPath, input.attachmentId);
		if (!record || record.owner.kind !== 'conversation' || record.owner.conversationId !== input.conversationId) return null;
		await verifyAttachmentBytes(record.attachment, record.bytes);
		return { attachment: { ...record.attachment }, bytes: copyAttachmentBytes(record.bytes) };
	}

	async deleteForInstance(streamPath: string): Promise<void> {
		const attachmentIndex = this.keys.attachments(streamPath);
		const attachmentValue = await this.runner.command('SMEMBERS', [attachmentIndex]);
		const keys = [
			...(Array.isArray(attachmentValue) ? attachmentValue.map(string) : []).map((id) => this.keys.attachment(streamPath, id)),
			attachmentIndex,
		];
		await this.runner.command('DEL', keys);
	}

	async bindSubmissionAttachment(input: BindSubmissionAttachmentInput): Promise<void> {
		const record = await this.read(input.streamPath, input.attachment.id);
		if (!record) conflict(input);
		await verifyAttachmentBytes(input.attachment, record.bytes);
		if (!sameAttachmentRef(record.attachment, input.attachment)) conflict(input);
		if (record.owner.kind === 'conversation' && record.owner.conversationId === input.conversationId) return;
		if (record.owner.kind !== 'submission' || record.owner.submissionId !== input.submissionId) conflict(input);
		const result = await this.runner.eval(BIND, [
			this.keys.attachment(input.streamPath, input.attachment.id),
		], [input.submissionId, input.conversationId, input.attachment.mimeType, input.attachment.size, input.attachment.digest, record.bytes]);
		if (Number(result) !== 1) conflict(input);
	}

	private async read(path: string, id: string): Promise<AttachmentRecord | null> {
		const value = await this.runner.command('HMGET', [this.keys.attachment(path, id), 'mimeType', 'byteSize', 'digest', 'ownerKind', 'ownerId', 'bytes']);
		if (!Array.isArray(value) || value[0] == null) return null;
		return { attachment: { id, mimeType: string(value[0]), size: Number(string(value[1])), digest: string(value[2]) }, owner: string(value[3]) === 'conversation' ? { kind: 'conversation', conversationId: string(value[4]) } : { kind: 'submission', submissionId: string(value[4]) }, bytes: binary(value[5]) };
	}
}

const PUT = `if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end redis.call('HSET', KEYS[1], 'mimeType', ARGV[1], 'byteSize', ARGV[2], 'digest', ARGV[3], 'ownerKind', ARGV[4], 'ownerId', ARGV[5], 'bytes', ARGV[6], 'createdAt', ARGV[7]) redis.call('SADD',KEYS[2],ARGV[8]) return 1`;
const BIND = `local v=redis.call('HMGET',KEYS[1],'ownerKind','ownerId','mimeType','byteSize','digest','bytes') if not v[1] or v[1]~='submission' or v[2]~=ARGV[1] or v[3]~=ARGV[3] or v[4]~=ARGV[4] or v[5]~=ARGV[5] or v[6]~=ARGV[6] then return 0 end redis.call('HSET',KEYS[1],'ownerKind','conversation','ownerId',ARGV[2]) return 1`;

function string(value: unknown): string { return value instanceof Uint8Array ? new TextDecoder().decode(value) : String(value); }
function binary(value: unknown): Uint8Array { if (value instanceof Uint8Array) return copyAttachmentBytes(value); if (typeof value === 'string') return new TextEncoder().encode(value); throw new TypeError('Persisted attachment bytes are not binary data.'); }
function conflict(input: { streamPath: string; attachment: AttachmentRef }): never { throw new AttachmentConflictError({ path: input.streamPath, attachmentId: input.attachment.id }); }
