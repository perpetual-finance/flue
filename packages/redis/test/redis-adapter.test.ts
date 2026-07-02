import { randomUUID } from 'node:crypto';
import { PersistedSchemaVersionError } from '@flue/runtime/adapter';
import {
	defineAttachmentStoreContractTests,
	defineConversationStreamStoreContractTests,
	defineStoreContractTests,
} from '@flue/runtime/test-utils';
import { createClient, RESP_TYPES } from 'redis';
import { describe, expect, it } from 'vitest';
import { type RedisRunner, redis } from '../src/index.ts';

const redisUrl = process.env.TEST_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

type TestRedisClient = ReturnType<typeof createClient>;

function createRunner(client: TestRedisClient): RedisRunner {
	const argument = (value: string | number | Uint8Array) =>
		value instanceof Uint8Array ? Buffer.from(value) : String(value);
	return {
		command: (command, args = []) => client.sendCommand(
			[command, ...args.map(argument)],
			{ typeMapping: { [RESP_TYPES.BLOB_STRING]: Buffer } },
		),
		eval: (script, keys, args = []) => client.eval(script, { keys, arguments: args.map(argument) }),
		pipeline: async (commands) => {
			const multi = client.multi();
			for (const item of commands)
				multi.addCommand([item.command, ...(item.args ?? []).map(argument)]);
			return multi.exec();
		},
		close: () => client.close(),
	};
}

interface Harness {
	adapter: ReturnType<typeof redis>;
	client: TestRedisClient;
	prefix: string;
}

async function createSharedHarness(prefix = `flue-test:${randomUUID()}`): Promise<Harness> {
	const client = createClient({ url: redisUrl });
	await client.connect();
	const adapter = redis(createRunner(client), { keyPrefix: prefix, inspectServer: false });
	await adapter.migrate?.();
	return { adapter, client, prefix };
}

let harness: Harness | undefined;

async function createHarness() {
	harness = await createSharedHarness();
	return harness.adapter.connect();
}

async function cleanupPrefix(target: Harness, extras: Harness[] = []) {
	let cursor = '0';
	do {
		const result = await target.client.scan(cursor, { MATCH: `${target.prefix}:*`, COUNT: 100 });
		cursor = result.cursor;
		if (result.keys.length > 0) await target.client.del(result.keys);
	} while (cursor !== '0');
	for (const item of [target, ...extras]) await item.adapter.close?.();
}

async function cleanupHarness() {
	if (!harness) return;
	await cleanupPrefix(harness);
	harness = undefined;
}

describeRedis('Redis shared contracts', () => {
	defineStoreContractTests('Redis AgentExecutionStore', {
		async create() {
			return (await createHarness()).executionStore;
		},
		cleanup: cleanupHarness,
	});
	defineAttachmentStoreContractTests('Redis AttachmentStore', {
		async create() {
			return (await createHarness()).attachmentStore;
		},
		cleanup: cleanupHarness,
	});
	defineConversationStreamStoreContractTests('Redis ConversationStreamStore', {
		async create() {
			const connected = await createHarness();
			if (!connected.conversationStreamStore) {
				throw new Error('Expected Redis conversation stream store.');
			}
			return {
				stream: connected.conversationStreamStore,
				executionStore: connected.executionStore,
			};
		},
		cleanup: cleanupHarness,
	});
});

function dispatchInput(dispatchId = 'dispatch-1') {
	return {
		dispatchId,
		agent: 'assistant',
		id: 'agent-1',
		message: { kind: 'signal' as const, type: 'test.event', body: 'hello' },
		acceptedAt: '2026-06-03T00:00:00.000Z',
	};
}

describeRedis('redis() concurrency', () => {
	it('allows one same-submission claim when independent adapters race', async () => {
		const first = await createSharedHarness();
		const second = await createSharedHarness(first.prefix);
		const firstStores = await first.adapter.connect();
		const secondStores = await second.adapter.connect();
		await firstStores.executionStore.submissions.admitDispatch(dispatchInput());
		await firstStores.executionStore.submissions.markSubmissionCanonicalReady('dispatch-1');
		const results = await Promise.all([
			firstStores.executionStore.submissions.claimSubmission({
				submissionId: 'dispatch-1',
				attemptId: 'a',
				ownerId: 'one',
				leaseExpiresAt: Date.now() + 30_000,
			}),
			secondStores.executionStore.submissions.claimSubmission({
				submissionId: 'dispatch-1',
				attemptId: 'b',
				ownerId: 'two',
				leaseExpiresAt: Date.now() + 30_000,
			}),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
		await cleanupPrefix(first, [second]);
	});
});

describeRedis('redis() malformed rows', () => {
	// Many sequential round trips (two admissions plus per-id list reads), so
	// allow for high-latency Redis servers.
	it(
		'settles a malformed submission row instead of wedging list calls',
		{ timeout: 60_000 },
		async () => {
			const stores = await createHarness();
			const submissions = stores.executionStore.submissions;
			await submissions.admitDispatch(dispatchInput('malformed'));
			await submissions.markSubmissionCanonicalReady('malformed');
			await submissions.admitDispatch({ ...dispatchInput('healthy'), id: 'agent-2' });
			await submissions.markSubmissionCanonicalReady('healthy');
			if (!harness) throw new TypeError('Harness is required.');
			const malformedKey = `${harness.prefix}:submission:${Buffer.from('malformed').toString('base64url')}`;
			// Corrupt persisted metadata so the row no longer matches its payload.
			await harness.client.hSet(malformedKey, 'acceptedAt', '1');
			const runnable = await submissions.listRunnableSubmissions();
			expect(runnable.map((item) => item.submissionId)).toEqual(['healthy']);
			expect(await harness.client.hGet(malformedKey, 'status')).toBe('settled');
			expect(await harness.client.hGet(malformedKey, 'error')).toContain('malformed');
			// A later pass must not resurrect or re-report the settled row.
			expect(
				(await submissions.listRunnableSubmissions()).map((item) => item.submissionId),
			).toEqual(['healthy']);
			await cleanupHarness();
		},
	);
});

describeRedis('redis() migration', () => {
	it('rejects unversioned Flue persistence without stamping it', async () => {
		if (!redisUrl) throw new TypeError('TEST_REDIS_URL is required.');
		const client = createClient({ url: redisUrl });
		await client.connect();
		const prefix = `flue-test:${randomUUID()}`;
		await client.set(`${prefix}:run:legacy`, '{}');
		const adapter = redis(createRunner(client), { keyPrefix: prefix, inspectServer: false });
		await expect(adapter.migrate?.()).rejects.toThrowError(PersistedSchemaVersionError);
		expect(await client.exists(`${prefix}:meta`)).toBe(0);
		await client.del(`${prefix}:run:legacy`);
		await adapter.close?.();
	});
	it('rejects an earlier schema version', async () => {
		const stores = await createHarness();
		void stores;
		await harness?.client.hSet(`${harness?.prefix}:meta`, 'schemaVersion', '2');
		await expect(harness?.adapter.migrate?.()).rejects.toThrowError(PersistedSchemaVersionError);
		await cleanupHarness();
	});
	it('rejects a newer schema version', async () => {
		const stores = await createHarness();
		void stores;
		await harness?.client.hSet(`${harness?.prefix}:meta`, 'schemaVersion', '999');
		await expect(harness?.adapter.migrate?.()).rejects.toThrowError(PersistedSchemaVersionError);
		await cleanupHarness();
	});
});
