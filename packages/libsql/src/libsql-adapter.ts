/**
 * libSQL / Turso persistence adapter.
 *
 * Implements {@link AgentSubmissionStore}, the canonical conversation
 * stream store, and the attachment store against a libSQL / Turso database
 * using SQLite-dialect parameterised queries (`?` placeholders).
 *
 * The adapter accepts any async SQL runner conforming to {@link LibsqlRunner}
 * so that an application can supply its own configured `@libsql/client`, and
 * tests can substitute an in-memory client without pulling in a real server.
 */

import type {
	AgentAttemptMarker,
	AgentDispatchAdmission,
	AgentSubmission,
	AgentSubmissionInput,
	AgentSubmissionStore,
	DispatchInput,
	PersistedChunkOwner,
	PersistedChunkRow,
	PersistedChunkStore,
	PersistenceAdapter,
	SubmissionAttemptRef,
	SubmissionClaimRef,
} from '@flue/runtime/adapter';
import {
	admitSubmissionWithBackend,
	assertSupportedFlueSchemaVersion,
	createDispatchAgentSubmissionInput,
	DURABILITY_DEFAULT_MAX_ATTEMPTS,
	DURABILITY_DEFAULT_TIMEOUT_MS,
	FLUE_SCHEMA_VERSION,
	hydratePersistedSubmissionAttachments,
	isSubmissionPayload,
	LEASE_DURATION_MS,
	submissionChunkOwner,
} from '@flue/runtime/adapter';
import { LibsqlAttachmentStore } from './libsql-attachment-store.ts';
import { createLibsqlConversationStreamStore } from './libsql-conversation-store.ts';

// ─── Bring-your-own-driver runner seam ──────────────────────────────────────

/** A single row returned from a query. */
type SqlRow = Record<string, unknown>;

/**
 * A query over a configured libSQL driver: a SQL string with `?` placeholders
 * plus positional parameters, resolving to result rows as plain objects.
 */
export type LibsqlParameter = string | number | boolean | ArrayBuffer | null;
export type LibsqlQuery = (text: string, params?: LibsqlParameter[]) => Promise<SqlRow[]>;

/**
 * The driver seam `@flue/libsql` runs against. Wrap your own configured
 * `@libsql/client` (local file, in-memory, or a Turso embedded/remote URL) in
 * this shape — `@flue/libsql` does not pick or bundle a driver, so you own
 * driver choice, sync settings, auth tokens, and every other connection option.
 *
 * `transaction` must run `fn` inside one transaction on a single connection,
 * committing on resolve and rolling back on throw. The `tx` passed to `fn`
 * only needs `query`; the adapter never nests transactions.
 */
export interface LibsqlRunner {
	query: LibsqlQuery;
	transaction<T>(fn: (tx: { query: LibsqlQuery }) => Promise<T>): Promise<T>;
	close(): void | Promise<void>;
}

// ─── Public factory ─────────────────────────────────────────────────────────

/**
 * Create a libSQL-backed {@link PersistenceAdapter} from a {@link LibsqlRunner}.
 *
 * `@flue/libsql` does not pick or bundle a driver — wrap your own configured
 * `@libsql/client` in the runner shape so you own driver choice and every
 * connection option.
 *
 * @example
 * ```ts
 * import { libsql } from '@flue/libsql';
 * import { createClient } from '@libsql/client';
 *
 * const client = createClient({
 *   url: process.env.LIBSQL_URL!,
 *   authToken: process.env.LIBSQL_AUTH_TOKEN,
 * });
 *
 * const toRows = (rs: { rows: ArrayLike<Record<string, unknown>>; columns: string[] }) =>
 *   Array.from(rs.rows, (row) =>
 *     Object.fromEntries(rs.columns.map((column) => [column, row[column]])));
 *
 * let tail: Promise<unknown> = Promise.resolve();
 * const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
 *   const result = tail.then(operation, operation);
 *   tail = result.then(() => undefined, () => undefined);
 *   return result;
 * };
 *
 * export default libsql({
 *   query: (text, params = []) =>
 *     serialize(async () => toRows(await client.execute({ sql: text, args: params }))),
 *   transaction: (fn) => serialize(async () => {
 *     const tx = await client.transaction('write');
 *     try {
 *       const result = await fn({
 *         query: async (text, params = []) =>
 *           toRows(await tx.execute({ sql: text, args: params })),
 *       });
 *       await tx.commit();
 *       return result;
 *     } catch (error) {
 *       await tx.rollback();
 *       throw error;
 *     } finally {
 *       tx.close();
 *     }
 *   }),
 *   close: () => client.close(),
 * });
 * ```
 */
export function libsql(runner: LibsqlRunner): PersistenceAdapter {
	let closed = false;
	return {
		async migrate() {
			await ensureTables(runner);
		},
		connect() {
			return {
				executionStore: {
					submissions: new LibsqlSubmissionStore(runner),
				},
				conversationStreamStore: createLibsqlConversationStreamStore(runner),
				attachmentStore: new LibsqlAttachmentStore(runner),
			};
		},
		async close() {
			if (closed) return;
			closed = true;
			await runner.close();
		},
	};
}

// ─── Schema ─────────────────────────────────────────────────────────────────

async function ensureTables(runner: LibsqlRunner): Promise<void> {
	// Wrap all schema setup in a single transaction so partial failures don't
	// leave the database half-migrated.
	await runner.transaction(async (tx) => {
		// Stamp a fresh database with the current schema version; refuse to
		// touch a database recorded with an unknown or newer version.
		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			)
		`);
		const versionRows = await tx.query(`SELECT value FROM flue_meta WHERE key = 'schema_version'`);
		const storedVersion = versionRows[0]?.value;
		if (storedVersion === undefined || storedVersion === null) {
			const existing = await tx.query(
				`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'flue_%' AND name <> 'flue_meta' LIMIT 1`,
			);
			if (existing.length > 0) assertSupportedFlueSchemaVersion('unversioned');
			await tx.query(`INSERT OR IGNORE INTO flue_meta (key, value) VALUES ('schema_version', ?)`, [
				String(FLUE_SCHEMA_VERSION),
			]);
		} else {
			assertSupportedFlueSchemaVersion(String(storedVersion));
		}

		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_image_chunks (
				owner_kind TEXT NOT NULL,
				owner_id TEXT NOT NULL,
				owner_part TEXT NOT NULL,
				image_id TEXT NOT NULL,
				chunk_index INTEGER NOT NULL,
				chunk_count INTEGER NOT NULL,
				data TEXT NOT NULL,
				PRIMARY KEY (owner_kind, owner_id, owner_part, image_id, chunk_index)
			)
		`);

		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_agent_submissions (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				submission_id TEXT NOT NULL UNIQUE,
				session_key TEXT NOT NULL,
				kind TEXT NOT NULL,
				payload TEXT NOT NULL,
				status TEXT NOT NULL,
				accepted_at INTEGER NOT NULL,
				canonical_ready_at INTEGER,
				attempt_id TEXT,
				input_applied_at INTEGER,
				recovery_requested_at INTEGER,
				abort_requested_at INTEGER,
				started_at INTEGER,
				joined_into TEXT,
				settled_at INTEGER,
				error TEXT,
				attempt_count INTEGER NOT NULL DEFAULT 0,
				max_retry INTEGER NOT NULL DEFAULT ${DURABILITY_DEFAULT_MAX_ATTEMPTS},
				timeout_at INTEGER NOT NULL DEFAULT 0,
				owner_id TEXT,
				lease_expires_at INTEGER NOT NULL DEFAULT 0,
				settlement_record_id TEXT,
				settlement_record TEXT
			)
		`);


		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_agent_dispatch_receipts (
				dispatch_id TEXT PRIMARY KEY,
				accepted_at INTEGER NOT NULL
			)
		`);

		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_agent_attempt_markers (
				submission_id TEXT NOT NULL,
				attempt_id TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				PRIMARY KEY (submission_id, attempt_id)
			)
		`);

		await tx.query(`
			CREATE INDEX IF NOT EXISTS flue_agent_submissions_status_sequence_idx
			ON flue_agent_submissions (status, sequence ASC)
		`);

		await tx.query(`
			CREATE INDEX IF NOT EXISTS flue_agent_submissions_session_status_sequence_idx
			ON flue_agent_submissions (session_key, status, sequence ASC)
		`);

		await tx.query(`
			CREATE INDEX IF NOT EXISTS flue_agent_submissions_joined_into_idx
			ON flue_agent_submissions (joined_into) WHERE joined_into IS NOT NULL
		`);

		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_conversation_streams (
				path TEXT PRIMARY KEY,
				identity_json TEXT NOT NULL,
				next_offset INTEGER NOT NULL DEFAULT 0,
				producer_id TEXT,
				producer_epoch INTEGER NOT NULL DEFAULT 0,
				next_producer_sequence INTEGER NOT NULL DEFAULT 0,
				incarnation TEXT NOT NULL
			)
		`);
		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_conversation_stream_batches (
				path TEXT NOT NULL,
				seq INTEGER NOT NULL,
				producer_id TEXT NOT NULL,
				producer_epoch INTEGER NOT NULL,
				producer_sequence INTEGER NOT NULL,
				data TEXT NOT NULL,
				submission_id TEXT,
				attempt_id TEXT,
				PRIMARY KEY (path, seq),
				UNIQUE (path, producer_id, producer_epoch, producer_sequence)
			)
		`);
		await tx.query(`
			CREATE TABLE IF NOT EXISTS flue_attachments (
				stream_path TEXT NOT NULL,
				attachment_id TEXT NOT NULL,
				mime_type TEXT NOT NULL,
				byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
				digest TEXT NOT NULL,
				conversation_id TEXT NOT NULL,
				bytes BLOB NOT NULL,
				created_at INTEGER NOT NULL,
				PRIMARY KEY (stream_path, attachment_id)
			)
		`);
		await tx.query(`
			CREATE INDEX IF NOT EXISTS flue_attachments_conversation_idx
			ON flue_attachments (stream_path, conversation_id, attachment_id)
		`);
	});
}

// ─── Session store ──────────────────────────────────────────────────────────

interface LibsqlQueryRunner {
	query: LibsqlQuery;
}

function createLibsqlChunkStore(runner: LibsqlQueryRunner): PersistedChunkStore<Promise<void>> {
	return {
		async read(owner) {
			const rows = await runner.query(
				`SELECT image_id, chunk_index, chunk_count, data
				 FROM flue_image_chunks
				 WHERE owner_kind = ? AND owner_id = ? AND owner_part = ?
				 ORDER BY image_id, chunk_index`,
				[owner.kind, owner.id, owner.part],
			);
			return rows.map(parsePersistedChunkRow);
		},
		async replace(owner, chunks) {
			await deleteLibsqlChunkOwner(runner, owner);
			for (const chunk of chunks) {
				await runner.query(
					`INSERT INTO flue_image_chunks
					 (owner_kind, owner_id, owner_part, image_id, chunk_index, chunk_count, data)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
					[owner.kind, owner.id, owner.part, chunk.imageId, chunk.index, chunk.count, chunk.data],
				);
			}
		},
		async delete(owner) {
			await deleteLibsqlChunkOwner(runner, owner);
		},
		async deleteMany(owners) {
			for (const owner of owners) await deleteLibsqlChunkOwner(runner, owner);
		},
		async deleteOwner(kind, id) {
			await runner.query('DELETE FROM flue_image_chunks WHERE owner_kind = ? AND owner_id = ?', [
				kind,
				id,
			]);
		},
	};
}

function parsePersistedChunkRow(row: SqlRow): PersistedChunkRow {
	const index = Number(row.chunk_index);
	const count = Number(row.chunk_count);
	if (
		typeof row.image_id !== 'string' ||
		!Number.isInteger(index) ||
		!Number.isInteger(count) ||
		typeof row.data !== 'string'
	) {
		throw new Error('[flue] Persisted image chunk row is malformed.');
	}
	return { imageId: row.image_id, index, count, data: row.data };
}

async function deleteLibsqlChunkOwner(
	runner: LibsqlQueryRunner,
	owner: PersistedChunkOwner,
): Promise<void> {
	await runner.query(
		'DELETE FROM flue_image_chunks WHERE owner_kind = ? AND owner_id = ? AND owner_part = ?',
		[owner.kind, owner.id, owner.part],
	);
}


// ─── Submission store ───────────────────────────────────────────────────────

const submissionColumns = [
	'sequence',
	'submission_id',
	'session_key',
	'kind',
	'payload',
	'status',
	'accepted_at',
	'canonical_ready_at',
	'attempt_id',
	'input_applied_at',
	'recovery_requested_at',
	'abort_requested_at',
	'started_at',
	'joined_into',
	'error',
	'attempt_count',
	'max_retry',
	'timeout_at',
	'owner_id',
	'lease_expires_at',
].join(', ');

function prefixed(table: string): string {
	return submissionColumns
		.split(', ')
		.map((c) => `${table}.${c}`)
		.join(', ');
}

class LibsqlSubmissionStore implements AgentSubmissionStore {
	constructor(private runner: LibsqlRunner) {}

	// ── Query ────────────────────────────────────────────────────────────

	async getSubmission(submissionId: string): Promise<AgentSubmission | null> {
		return this.runner.transaction(async (tx) => {
			const rows = await tx.query(
				`SELECT ${submissionColumns} FROM flue_agent_submissions WHERE submission_id = ? LIMIT 1`,
				[submissionId],
			);
			return rows[0]
				? parseSubmission(
						rows[0],
						await createLibsqlChunkStore(tx).read(submissionChunkOwner(submissionId)),
					)
				: null;
		});
	}

	async markSubmissionCanonicalReady(submissionId: string): Promise<AgentSubmission | null> {
		const rows = await this.runner.query(
			`UPDATE flue_agent_submissions SET canonical_ready_at = COALESCE(canonical_ready_at, ?)
			 WHERE submission_id = ? AND status = 'queued' RETURNING ${submissionColumns}`,
			[Date.now(), submissionId],
		);
		return rows[0] ? this.getSubmission(submissionId) : null;
	}

	async hasUnsettledSubmissions(): Promise<boolean> {
		const rows = await this.runner.query(
			`SELECT 1 FROM flue_agent_submissions WHERE status IN ('queued', 'running', 'terminalizing', 'joining', 'joined') LIMIT 1`,
		);
		return rows.length > 0;
	}

	async listUnreadySubmissions(): Promise<AgentSubmission[]> {
		return this.runner.transaction(async (tx) => {
			const rows = await tx.query(
				`SELECT ${submissionColumns}
				 FROM flue_agent_submissions
				 WHERE status = 'queued' AND canonical_ready_at IS NULL
				 ORDER BY sequence ASC`,
			);
			return this.parseOperationalRows(rows, 'queued', tx);
		});
	}

	async listRunnableSubmissions(): Promise<AgentSubmission[]> {
		return this.runner.transaction(async (tx) => {
			const rows = await tx.query(
				`SELECT ${prefixed('current_sub')}
			 FROM flue_agent_submissions AS current_sub
			 WHERE current_sub.status = 'queued'
			   AND current_sub.canonical_ready_at IS NOT NULL
			   AND NOT EXISTS (
			     SELECT 1
			     FROM flue_agent_submissions AS earlier
			     WHERE earlier.session_key = current_sub.session_key
			       AND earlier.status IN ('queued', 'running', 'terminalizing', 'joining', 'joined')
			       AND earlier.sequence < current_sub.sequence
			   )
			 ORDER BY current_sub.sequence ASC`,
			);
			return this.parseOperationalRows(rows, 'queued', tx);
		});
	}

	async listRunningSubmissions(): Promise<AgentSubmission[]> {
		return this.runner.transaction(async (tx) => {
			const rows = await tx.query(
				`SELECT ${submissionColumns}
			 FROM flue_agent_submissions
			 WHERE status = 'running'
			 ORDER BY sequence ASC`,
			);
			return this.parseOperationalRows(rows, 'active', tx);
		});
	}

	async replaceSubmissionAttempt(
		attempt: SubmissionAttemptRef,
		nextAttemptId: string,
		lease?: { ownerId: string; leaseExpiresAt: number },
	): Promise<AgentSubmission | null> {
		return this.runner.transaction(async (tx) => {
			const now = Date.now();
			const subRows = lease
				? await tx.query(
						`UPDATE flue_agent_submissions
					 SET attempt_id = ?, recovery_requested_at = NULL, started_at = ?, attempt_count = attempt_count + 1,
					     owner_id = ?, lease_expires_at = ?
					 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
					 RETURNING ${submissionColumns}`,
						[
							nextAttemptId,
							now,
							lease.ownerId,
							lease.leaseExpiresAt,
							attempt.submissionId,
							attempt.attemptId,
						],
					)
				: await tx.query(
						`UPDATE flue_agent_submissions
					 SET attempt_id = ?, recovery_requested_at = NULL, started_at = ?, attempt_count = attempt_count + 1
					 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
					 RETURNING ${submissionColumns}`,
						[nextAttemptId, now, attempt.submissionId, attempt.attemptId],
					);
			if (!subRows[0]) return null;
			return parseSubmission(
				subRows[0],
				await createLibsqlChunkStore(tx).read(submissionChunkOwner(attempt.submissionId)),
			);
		});
	}

	// ── Admission ────────────────────────────────────────────────────────

	async admitDispatch(input: DispatchInput): Promise<AgentDispatchAdmission> {
		return this.admitSubmission(createDispatchAgentSubmissionInput(input));
	}

	async admitDirect(input: AgentSubmissionInput): Promise<AgentSubmission> {
		const admission = await this.admitSubmission(input);
		if (admission.kind !== 'submission') {
			throw new Error('[flue] Internal direct admission returned an unexpected result.');
		}
		return admission.submission;
	}

	// ── Submission lifecycle ─────────────────────────────────────────────

	async claimSubmission(claim: SubmissionClaimRef): Promise<AgentSubmission | null> {
		const now = Date.now();
		const timeoutAt = now + DURABILITY_DEFAULT_TIMEOUT_MS;

		// SQLite supports `UPDATE ... AS alias` with a self-referencing
		// NOT EXISTS subquery, so the claim is a single statement.
		return this.runner.transaction(async (tx) => {
			const rows = await tx.query(
				`UPDATE flue_agent_submissions AS current
			 SET status = 'running', attempt_id = ?, started_at = ?, attempt_count = attempt_count + 1,
			     max_retry = ?, timeout_at = CASE WHEN timeout_at = 0 THEN ? ELSE timeout_at END,
			     owner_id = ?, lease_expires_at = ?
			 WHERE current.submission_id = ? AND current.status = 'queued'
			   AND current.canonical_ready_at IS NOT NULL
			   AND NOT EXISTS (
			     SELECT 1
			     FROM flue_agent_submissions AS earlier
			     WHERE earlier.session_key = current.session_key
			       AND earlier.status IN ('queued', 'running', 'terminalizing', 'joining', 'joined')
			       AND earlier.sequence < current.sequence
			   )
			 RETURNING ${submissionColumns}`,
				[
					claim.attemptId,
					now,
					DURABILITY_DEFAULT_MAX_ATTEMPTS,
					timeoutAt,
					claim.ownerId,
					claim.leaseExpiresAt,
					claim.submissionId,
				],
			);
			return rows[0]
				? parseSubmission(
						rows[0],
						await createLibsqlChunkStore(tx).read(submissionChunkOwner(claim.submissionId)),
					)
				: null;
		});
	}

	async markSubmissionInputApplied(
		attempt: SubmissionAttemptRef,
		durability?: { maxRetry: number; timeoutAt: number },
	): Promise<boolean> {
		const now = Date.now();
		const rows = await this.runner.query(
			`UPDATE flue_agent_submissions
			 SET input_applied_at = COALESCE(input_applied_at, ?),
			     max_retry = CASE WHEN input_applied_at IS NULL THEN ? ELSE max_retry END,
			     timeout_at = CASE WHEN input_applied_at IS NULL THEN ? ELSE timeout_at END
			 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
			 RETURNING submission_id`,
			[
				now,
				durability?.maxRetry ?? DURABILITY_DEFAULT_MAX_ATTEMPTS,
				durability?.timeoutAt ?? now + DURABILITY_DEFAULT_TIMEOUT_MS,
				attempt.submissionId,
				attempt.attemptId,
			],
		);
		return rows.length > 0;
	}

	async requestSubmissionRecovery(attempt: SubmissionAttemptRef): Promise<boolean> {
		const rows = await this.runner.query(
			`UPDATE flue_agent_submissions
			 SET recovery_requested_at = COALESCE(recovery_requested_at, ?)
			 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
			 RETURNING submission_id`,
			[Date.now(), attempt.submissionId, attempt.attemptId],
		);
		return rows.length > 0;
	}

	async requestSessionAbort(sessionKey: string): Promise<string[]> {
		const rows = await this.runner.query(
			`UPDATE flue_agent_submissions
			 SET abort_requested_at = COALESCE(abort_requested_at, ?)
			 WHERE session_key = ? AND status IN ('queued', 'running', 'joining', 'joined')
			 RETURNING submission_id`,
			[Date.now(), sessionKey],
		);
		return rows.map((row) => String(row.submission_id));
	}

	async requeueSubmissionBeforeInputApplied(attempt: SubmissionAttemptRef): Promise<boolean> {
		const rows = await this.runner.query(
			`UPDATE flue_agent_submissions
			 SET status = 'queued', attempt_id = NULL, recovery_requested_at = NULL, started_at = NULL, owner_id = NULL, lease_expires_at = 0
			 WHERE submission_id = ? AND status = 'running'
			   AND attempt_id = ? AND input_applied_at IS NULL
			 RETURNING submission_id`,
			[attempt.submissionId, attempt.attemptId],
		);
		return rows.length > 0;
	}

	async listPendingSubmissionSettlements(): Promise<import('@flue/runtime/adapter').SubmissionSettlementObligation[]> {
		const rows = await this.runner.query(`SELECT submission_id, session_key, attempt_id, settlement_record_id, settlement_record FROM flue_agent_submissions WHERE status = 'terminalizing' ORDER BY sequence ASC`);
		return rows.map((row) => ({ submissionId: String(row.submission_id), sessionKey: String(row.session_key), attemptId: String(row.attempt_id), recordId: String(row.settlement_record_id), record: JSON.parse(String(row.settlement_record)) }));
	}
	async reserveSubmissionSettlement(attempt: SubmissionAttemptRef, settlement: { recordId: string; record: import('@flue/runtime/adapter').SubmissionSettledRecord }): Promise<import('@flue/runtime/adapter').SubmissionSettlementObligation | null> {
		if (settlement.record.id !== settlement.recordId) return null;
		const data = JSON.stringify(settlement.record);
		// Two reservable shapes, for either submission kind: the submission's
		// own running attempt, or a delivery JOINED into a host that is
		// running under the caller's attempt — the host settles the joined
		// waiter's record under its own authority, adopting the row
		// (attempt_id/started_at) so the terminalizing invariants and
		// finalize fencing hold.
		const rows = await this.runner.query(
			`UPDATE flue_agent_submissions AS current
			 SET status = 'terminalizing', settlement_record_id = ?, settlement_record = ?,
			     attempt_id = ?, started_at = COALESCE(started_at, ?)
			 WHERE current.submission_id = ?
			   AND (
			     (current.status = 'running' AND current.attempt_id = ?
			       AND current.owner_id IS NOT NULL AND current.settlement_record_id IS NULL)
			     OR (current.status = 'joined' AND EXISTS (
			       SELECT 1 FROM flue_agent_submissions AS host
			       WHERE host.submission_id = current.joined_into
			         AND host.status = 'running' AND host.attempt_id = ?
			     ))
			   )
			 RETURNING submission_id, session_key, attempt_id, settlement_record_id, settlement_record`,
			[settlement.recordId, data, attempt.attemptId, Date.now(), attempt.submissionId, attempt.attemptId, attempt.attemptId],
		);
		const row = rows[0] ?? (await this.runner.query(`SELECT submission_id, session_key, attempt_id, settlement_record_id, settlement_record FROM flue_agent_submissions WHERE submission_id = ? AND status = 'terminalizing' AND attempt_id = ?`, [attempt.submissionId, attempt.attemptId]))[0];
		return row?.settlement_record_id === settlement.recordId && row?.settlement_record === data ? { submissionId: String(row.submission_id), sessionKey: String(row.session_key), attemptId: String(row.attempt_id), recordId: String(row.settlement_record_id), record: JSON.parse(String(row.settlement_record)) } : null;
	}
	async finalizeSubmissionSettlement(
		attempt: SubmissionAttemptRef,
		recordId: string,
		options?: { errorMessage?: string },
	): Promise<boolean> {
		return this.runner.transaction(async (tx) => {
			const pending = await tx.query(
				`SELECT settlement_record FROM flue_agent_submissions
				 WHERE submission_id = ? AND status = 'terminalizing' AND attempt_id = ? AND settlement_record_id = ?`,
				[attempt.submissionId, attempt.attemptId, recordId],
			);
			if (!pending[0]) return false;
			// The durable settlement record is the outcome authority; the row's
			// error column mirrors it — the caller's raw server-side message
			// when provided, else the record's client-safe one.
			const record = JSON.parse(String(pending[0].settlement_record)) as {
				outcome?: string;
				error?: { message?: string };
			};
			const errorMessage =
				record.outcome === 'completed'
					? null
					: (options?.errorMessage ?? record.error?.message ?? 'The submission did not complete.');
			const rows = await tx.query(
				`UPDATE flue_agent_submissions SET status = 'settled', settled_at = ?, error = ?
				 WHERE submission_id = ? AND status = 'terminalizing' AND attempt_id = ? AND settlement_record_id = ?
				 RETURNING submission_id`,
				[Date.now(), errorMessage, attempt.submissionId, attempt.attemptId, recordId],
			);
			if (!rows[0]) return false;
			// A host settles through the outbox; fan its outcome out to joined
			// deliveries the same way completeSubmission/failSubmission do.
			await this.settleJoinedSubmissions(tx, attempt.submissionId, errorMessage);
			return true;
		});
	}

	async completeSubmission(attempt: SubmissionAttemptRef): Promise<boolean> {
		return this.runner.transaction(async (tx) => {
			const rows = await tx.query(
				`UPDATE flue_agent_submissions
				 SET status = 'settled', settled_at = ?, error = NULL
				 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
				 RETURNING submission_id`,
				[Date.now(), attempt.submissionId, attempt.attemptId],
			);
			if (rows.length === 0) return false;
			await this.settleJoinedSubmissions(tx, attempt.submissionId, null);
			return true;
		});
	}

	async failSubmission(attempt: SubmissionAttemptRef, error: unknown): Promise<boolean> {
		const message = error instanceof Error ? error.message : String(error);
		return this.runner.transaction(async (tx) => {
			const rows = await tx.query(
				`UPDATE flue_agent_submissions
				 SET status = 'settled', settled_at = ?, error = ?
				 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
				 RETURNING submission_id`,
				[Date.now(), message, attempt.submissionId, attempt.attemptId],
			);
			if (rows.length === 0) return false;
			await this.settleJoinedSubmissions(tx, attempt.submissionId, message);
			return true;
		});
	}

	// ── Turn-boundary joins ──────────────────────────────────────────────

	async claimJoinableSubmissions(
		host: SubmissionAttemptRef,
		agentName: string,
	): Promise<AgentSubmission[]> {
		return this.runner.transaction(async (tx) => {
			const hostRows = await tx.query(
				`SELECT session_key FROM flue_agent_submissions
				 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
				 LIMIT 1`,
				[host.submissionId, host.attemptId],
			);
			const hostRow = hostRows[0];
			if (!hostRow) return [];
			const queued = await tx.query(
				`SELECT ${submissionColumns}
				 FROM flue_agent_submissions
				 WHERE session_key = ? AND status = 'queued'
				 ORDER BY sequence ASC`,
				[String(hostRow.session_key)],
			);
			const chunkStore = createLibsqlChunkStore(tx);
			const claimed: AgentSubmission[] = [];
			for (const row of queued) {
				// Contiguous prefix: the first non-joinable row ends the claim so
				// admission order is preserved (everything behind it stays queued).
				if (row.canonical_ready_at == null || row.abort_requested_at != null) {
					break;
				}
				const submission = parseSubmission(
					row,
					await chunkStore.read(submissionChunkOwner(String(row.submission_id))),
				);
				if (submission.input.agent !== agentName) break;
				await tx.query(
					`UPDATE flue_agent_submissions
					 SET status = 'joining', joined_into = ?
					 WHERE submission_id = ? AND status = 'queued'`,
					[host.submissionId, submission.submissionId],
				);
				claimed.push({ ...submission, status: 'joining', joinedInto: host.submissionId });
			}
			return claimed;
		});
	}

	async finalizeJoinedSubmission(
		host: SubmissionAttemptRef,
		submissionId: string,
	): Promise<boolean> {
		const rows = await this.runner.query(
			`UPDATE flue_agent_submissions
			 SET status = 'joined', input_applied_at = COALESCE(input_applied_at, ?)
			 WHERE submission_id = ? AND status = 'joining' AND joined_into = ?
			   AND EXISTS (
			     SELECT 1 FROM flue_agent_submissions AS host
			     WHERE host.submission_id = ? AND host.status = 'running' AND host.attempt_id = ?
			   )
			 RETURNING submission_id`,
			[Date.now(), submissionId, host.submissionId, host.submissionId, host.attemptId],
		);
		return rows.length > 0;
	}

	async revertJoiningSubmission(
		host: SubmissionAttemptRef,
		submissionId: string,
	): Promise<boolean> {
		const rows = await this.runner.query(
			`UPDATE flue_agent_submissions
			 SET status = 'queued', joined_into = NULL, input_applied_at = NULL
			 WHERE submission_id = ? AND status = 'joining' AND joined_into = ?
			   AND EXISTS (
			     SELECT 1 FROM flue_agent_submissions AS host
			     WHERE host.submission_id = ? AND host.status = 'running' AND host.attempt_id = ?
			   )
			 RETURNING submission_id`,
			[submissionId, host.submissionId, host.submissionId, host.attemptId],
		);
		return rows.length > 0;
	}

	async listJoinedSubmissions(hostSubmissionId: string): Promise<AgentSubmission[]> {
		return this.runner.transaction(async (tx) => {
			const rows = await tx.query(
				`SELECT ${submissionColumns}
				 FROM flue_agent_submissions
				 WHERE joined_into = ? AND status IN ('joining', 'joined')
				 ORDER BY sequence ASC`,
				[hostSubmissionId],
			);
			return this.parseOperationalRows(rows, 'active', tx);
		});
	}

	/**
	 * Joined-delivery settle fan-out, run inside the host's settle
	 * transaction: `joined` rows settle with the host's outcome (`error`
	 * copied, NULL on success); `joining` stragglers — a join whose canonical
	 * input was never confirmed (abort or crash window) — revert to `queued`
	 * so the delivery runs as its own submission instead of vanishing.
	 */
	private async settleJoinedSubmissions(
		tx: LibsqlQueryRunner,
		hostSubmissionId: string,
		error: string | null,
	): Promise<void> {
		await tx.query(
			`UPDATE flue_agent_submissions
			 SET status = 'settled', settled_at = ?, error = ?
			 WHERE joined_into = ? AND status = 'joined'`,
			[Date.now(), error, hostSubmissionId],
		);
		await tx.query(
			`UPDATE flue_agent_submissions
			 SET status = 'queued', joined_into = NULL, input_applied_at = NULL
			 WHERE joined_into = ? AND status = 'joining'`,
			[hostSubmissionId],
		);
	}

	// ── Attempt markers ──────────────────────────────────────────────────

	async insertAttemptMarker(attempt: SubmissionAttemptRef): Promise<void> {
		await this.runner.query(
			`INSERT OR IGNORE INTO flue_agent_attempt_markers (submission_id, attempt_id, created_at)
			 VALUES (?, ?, ?)`,
			[attempt.submissionId, attempt.attemptId, Date.now()],
		);
	}

	async deleteAttemptMarker(attempt: SubmissionAttemptRef): Promise<void> {
		await this.runner.query(
			'DELETE FROM flue_agent_attempt_markers WHERE submission_id = ? AND attempt_id = ?',
			[attempt.submissionId, attempt.attemptId],
		);
	}

	async listAttemptMarkers(): Promise<AgentAttemptMarker[]> {
		const rows = await this.runner.query(
			'SELECT submission_id, attempt_id, created_at FROM flue_agent_attempt_markers',
		);
		return rows.map((row) => {
			const createdAt = Number(row.created_at);
			if (
				typeof row.submission_id !== 'string' ||
				typeof row.attempt_id !== 'string' ||
				!Number.isFinite(createdAt)
			) {
				throw new Error('[flue] Persisted attempt marker row is malformed.');
			}
			return { submissionId: row.submission_id, attemptId: row.attempt_id, createdAt };
		});
	}

	// ── Lease management ────────────────────────────────────────────────

	async renewLeases(ownerId: string, submissionIds: string[]): Promise<void> {
		if (submissionIds.length === 0) return;
		const now = Date.now();
		const leaseExpiresAt = now + LEASE_DURATION_MS;
		const placeholders = submissionIds.map(() => '?').join(', ');
		await this.runner.query(
			`UPDATE flue_agent_submissions
			 SET lease_expires_at = ?
			 WHERE owner_id = ? AND status = 'running'
			   AND submission_id IN (${placeholders})`,
			[leaseExpiresAt, ownerId, ...submissionIds],
		);
	}

	async listExpiredSubmissions(): Promise<AgentSubmission[]> {
		const now = Date.now();
		return this.runner.transaction(async (tx) => {
			const rows = await tx.query(
				`SELECT ${submissionColumns}
			 FROM flue_agent_submissions
			 WHERE status = 'running' AND lease_expires_at > 0 AND lease_expires_at < ?
			 ORDER BY sequence ASC`,
				[now],
			);
			return this.parseOperationalRows(rows, 'active', tx);
		});
	}

	// ── Private ──────────────────────────────────────────────────────────

	private async admitSubmission(input: AgentSubmissionInput): Promise<AgentDispatchAdmission> {
		return this.runner.transaction(async (tx) => {
			const chunkStore = createLibsqlChunkStore(tx);
			return admitSubmissionWithBackend<SqlRow>(input, {
				getDispatchReceipt: async (submissionId) => {
					const receiptRows = await tx.query(
						'SELECT dispatch_id, accepted_at FROM flue_agent_dispatch_receipts WHERE dispatch_id = ? LIMIT 1',
						[submissionId],
					);
					return receiptRows[0] ? parseDispatchReceipt(receiptRows[0]) : null;
				},
				insertIfAbsent: async (row) => {
					await tx.query(
						`INSERT OR IGNORE INTO flue_agent_submissions
						 (submission_id, session_key, kind, payload, status, accepted_at)
						 VALUES (?, ?, ?, ?, 'queued', ?)`,
						[row.submissionId, row.sessionKey, row.kind, row.payload, row.acceptedAt],
					);
				},
				getExisting: async (submissionId) =>
					(
						await tx.query(
							`SELECT ${submissionColumns} FROM flue_agent_submissions WHERE submission_id = ? LIMIT 1`,
							[submissionId],
						)
					)[0],
				readChunks: (owner) => chunkStore.read(owner),
				replaceChunks: (owner, chunks) => chunkStore.replace(owner, chunks),
				parseSubmission,
			});
		});
	}


	private async parseOperationalRows(
		rows: SqlRow[],
		status: 'queued' | 'active',
		runner: LibsqlQueryRunner,
	): Promise<AgentSubmission[]> {
		const submissions: AgentSubmission[] = [];
		const chunkStore = createLibsqlChunkStore(runner);
		for (const row of rows) {
			try {
				submissions.push(
					parseSubmission(
						row,
						await chunkStore.read(submissionChunkOwner(String(row.submission_id))),
					),
				);
			} catch (error) {
				const seq = Number(row.sequence);
				if (!Number.isFinite(seq)) throw error;
				console.error('[flue] Terminating malformed submission (sequence %d):', seq, error);
				await this.failSubmissionSequence(seq, status, error, runner);
			}
		}
		return submissions;
	}

	private async failSubmissionSequence(
		sequence: number,
		status: 'queued' | 'active',
		error: unknown,
		runner: LibsqlQueryRunner = this.runner,
	): Promise<void> {
		const statusFilter = status === 'queued' ? "status = 'queued'" : "status = 'running'";
		await runner.query(
			`UPDATE flue_agent_submissions
			 SET status = 'settled', settled_at = ?, error = ?
			 WHERE sequence = ? AND ${statusFilter}`,
			[Date.now(), error instanceof Error ? error.message : String(error), sequence],
		);
	}
}

// ─── Submission row parsers ─────────────────────────────────────────────────

function parseDispatchReceipt(row: SqlRow): { submissionId: string; acceptedAt: number } {
	const acceptedAt = Number(row.accepted_at);
	if (typeof row.dispatch_id !== 'string' || !Number.isFinite(acceptedAt)) {
		throw new Error('[flue] Persisted dispatch receipt row is malformed.');
	}
	return { submissionId: row.dispatch_id, acceptedAt };
}
// Intentionally adapter-specific: each backend has its own column types,
// coercion rules, and storage representation. libSQL returns INTEGER columns
// as JS numbers, so `Number(...)` coercion is safe and idempotent.

function parseSubmission(row: SqlRow, chunks: readonly PersistedChunkRow[]): AgentSubmission {
	const sequence = Number(row.sequence);
	const acceptedAt = Number(row.accepted_at);
	const canonicalReadyAt = row.canonical_ready_at != null ? Number(row.canonical_ready_at) : null;
	const attemptCount = Number(row.attempt_count);
	const maxRetry = Number(row.max_retry);
	const timeoutAt = Number(row.timeout_at);

	const attemptId = row.attempt_id != null ? String(row.attempt_id) : undefined;
	const inputAppliedAt = row.input_applied_at != null ? Number(row.input_applied_at) : undefined;
	const recoveryRequestedAt =
		row.recovery_requested_at != null ? Number(row.recovery_requested_at) : undefined;
	const abortRequestedAt =
		row.abort_requested_at != null ? Number(row.abort_requested_at) : undefined;
	const startedAt = row.started_at != null ? Number(row.started_at) : undefined;
	const joinedInto = row.joined_into != null ? String(row.joined_into) : undefined;
	const ownerId = row.owner_id != null ? String(row.owner_id) : undefined;
	const leaseExpiresAt = Number(row.lease_expires_at);

	if (
		!Number.isFinite(sequence) ||
		typeof row.submission_id !== 'string' ||
		typeof row.session_key !== 'string' ||
		(row.kind !== 'dispatch' && row.kind !== 'direct') ||
		typeof row.payload !== 'string' ||
		(row.status !== 'queued' &&
			row.status !== 'running' &&
			row.status !== 'terminalizing' &&
			row.status !== 'settled' &&
			row.status !== 'joining' &&
			row.status !== 'joined') ||
		!Number.isFinite(acceptedAt) ||
		(canonicalReadyAt !== null && !Number.isFinite(canonicalReadyAt)) ||
		// Status-specific invariants: queued rows must not have running fields,
		// running rows must have attemptId and startedAt, joining/joined rows
		// must record the host they joined.
		(row.status === 'queued' &&
			(attemptId !== undefined ||
				inputAppliedAt !== undefined ||
				recoveryRequestedAt !== undefined ||
				startedAt !== undefined ||
				joinedInto !== undefined)) ||
		((row.status === 'joining' || row.status === 'joined') && joinedInto === undefined) ||
		(row.status === 'running' && (attemptId === undefined || startedAt === undefined)) ||
		!Number.isFinite(attemptCount) ||
		!Number.isFinite(maxRetry) ||
		!Number.isFinite(timeoutAt) ||
		!Number.isFinite(leaseExpiresAt)
	) {
		throw new Error('[flue] Persisted agent submission row is malformed.');
	}

	const parsedInput = JSON.parse(row.payload) as AgentSubmissionInput;
	const input = hydratePersistedSubmissionAttachments(parsedInput, chunks);
	if (
		!isSubmissionPayload(input, {
			kind: row.kind as string,
			submissionId: row.submission_id as string,
			sessionKey: row.session_key as string,
			acceptedAt,
		})
	) {
		throw new Error('[flue] Persisted agent submission payload is malformed.');
	}

	const error = row.error != null ? String(row.error) : undefined;

	return {
		sequence,
		submissionId: row.submission_id,
		sessionKey: row.session_key,
		kind: row.kind,
		input,
		status: row.status,
		acceptedAt,
		canonicalReadyAt,
		...(attemptId !== undefined ? { attemptId } : {}),
		...(inputAppliedAt !== undefined ? { inputAppliedAt } : {}),
		...(recoveryRequestedAt !== undefined ? { recoveryRequestedAt } : {}),
		...(abortRequestedAt !== undefined ? { abortRequestedAt } : {}),
		...(startedAt !== undefined ? { startedAt } : {}),
		...(joinedInto !== undefined ? { joinedInto } : {}),
		...(error !== undefined ? { error } : {}),
		attemptCount,
		maxRetry,
		timeoutAt,
		...(ownerId !== undefined ? { ownerId } : {}),
		leaseExpiresAt,
	};
}
