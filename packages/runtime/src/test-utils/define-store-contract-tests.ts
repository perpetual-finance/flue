/**
 * Shared contract tests for AgentExecutionStore implementations.
 *
 * Adapter packages call {@link defineStoreContractTests} with a factory
 * function that creates their backend. The tests exercise every method
 * on `AgentSubmissionStore` with identical behavioral
 * assertions regardless of the underlying storage engine.
 *
 * @example
 * ```ts
 * import { defineStoreContractTests } from '@flue/runtime/test-utils';
 *
 * defineStoreContractTests('My Backend', {
 *   async create() { return myStore; },
 *   async cleanup() { await myStore.close(); },
 * });
 * ```
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { AgentExecutionStore } from '../agent-execution-store.ts';
import type { AgentSubmissionInput } from '../runtime/agent-submissions.ts';
import type { DispatchInput } from '../runtime/dispatch-queue.ts';

export { defineAttachmentStoreContractTests } from './define-attachment-store-contract-tests.ts';
export { defineConversationStreamStoreContractTests } from './define-conversation-stream-store-contract-tests.ts';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function dispatchInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
	return {
		dispatchId: 'dispatch-1',
		agent: 'assistant',
		id: 'agent-1',
		message: { kind: 'signal', type: 'test.event', body: 'Hello' },
		acceptedAt: '2026-06-03T00:00:00.000Z',
		...overrides,
	};
}

function directInput(
	overrides: Partial<AgentSubmissionInput> = {},
): AgentSubmissionInput {
	return {
		kind: 'direct',
		submissionId: 'direct-1',
		agent: 'assistant',
		id: 'agent-1',
		message: { kind: 'user', body: 'Hello' },
		acceptedAt: '2026-06-03T00:00:00.000Z',
		...overrides,
	};
}

function attempt(submissionId: string, attemptId: string) {
	return { submissionId, attemptId } as const;
}

function claim(submissionId: string, attemptId: string, ownerId = 'test-owner') {
	return { submissionId, attemptId, ownerId, leaseExpiresAt: Date.now() + 30_000 };
}

async function admitDispatchReady(store: AgentExecutionStore, input: DispatchInput) {
	const admission = await store.submissions.admitDispatch(input);
	if (admission.kind !== 'submission') return admission;
	const submission = await store.submissions.markSubmissionCanonicalReady(
		admission.submission.submissionId,
	);
	return { kind: 'submission' as const, submission: submission ?? admission.submission };
}

async function admitDirectReady(store: AgentExecutionStore, input: AgentSubmissionInput) {
	const submission = await store.submissions.admitDirect(input);
	return (await store.submissions.markSubmissionCanonicalReady(submission.submissionId)) ?? submission;
}

// ─── Contract test definition ───────────────────────────────────────────────

export interface StoreContractTestBackend {
	/** Create a fresh store instance for a single test. */
	create(): AgentExecutionStore | Promise<AgentExecutionStore>;
	/** Optional cleanup after each test (e.g. close connections, delete temp files). */
	cleanup?(): void | Promise<void>;
}

/**
 * Register the standard AgentExecutionStore contract tests under the given
 * describe label. Each test gets a fresh store from `backend.create()`.
 */
export function defineStoreContractTests(label: string, backend: StoreContractTestBackend): void {
	describe(label, () => {
		let _cleanup: (() => void | Promise<void>) | undefined;

		async function create(): Promise<AgentExecutionStore> {
			_cleanup = backend.cleanup;
			return backend.create();
		}

		afterEach(async () => {
			await _cleanup?.();
			_cleanup = undefined;
		});

		// ── Dispatch admission ────────────────────────────────────────────

		describe('dispatch admission', () => {
			it('admits one queued dispatch row when the same submission is replayed', async () => {
				const store = await create();
				const first = await store.submissions.admitDispatch(dispatchInput());
				const replay = await store.submissions.admitDispatch(dispatchInput());
				expect(replay).toEqual(first);
				expect(first).toMatchObject({
					kind: 'submission',
					submission: {
						submissionId: 'dispatch-1',
						sessionKey: 'agent-session:["agent-1","default","default"]',
						status: 'queued',
					},
				});
			});

			it('returns conflict when one dispatch id is reused with another payload', async () => {
				const store = await create();
				await store.submissions.admitDispatch(dispatchInput());
				expect(
					await store.submissions.admitDispatch(
						dispatchInput({
							message: { kind: 'signal', type: 'test.event', body: 'Different' },
						}),
					),
				).toEqual({
					kind: 'conflict',
				});
			});

			it('round-trips a dispatched user message with attachments', async () => {
				const store = await create();
				const input = dispatchInput({
					message: {
						kind: 'user',
						body: 'Here is the screenshot.',
						attachments: [{ type: 'image', data: 'image-data', mimeType: 'image/png' }],
					},
				});
				const admitted = await admitDispatchReady(store, input);
				expect(admitted).toMatchObject({
					kind: 'submission',
					submission: { submissionId: input.dispatchId, input: { message: input.message } },
				});
				expect((await store.submissions.getSubmission(input.dispatchId))?.input).toMatchObject({
					message: input.message,
				});
			});

			it('returns conflict when one dispatch id is replayed with different attachment bytes', async () => {
				const store = await create();
				const attachmentMessage = (data: string): DispatchInput['message'] => ({
					kind: 'user',
					body: 'Hello',
					attachments: [{ type: 'image', data, mimeType: 'image/png' }],
				});
				await store.submissions.admitDispatch(
					dispatchInput({ message: attachmentMessage('first-image') }),
				);
				expect(
					await store.submissions.admitDispatch(
						dispatchInput({ message: attachmentMessage('second-image') }),
					),
				).toEqual({ kind: 'conflict' });
			});

			it('chunks dispatched attachment bytes out of the stored payload and hydrates them on read', async () => {
				const store = await create();
				// Strictly larger than one persisted chunk (256 KiB), so the
				// bytes must be stored as at least two chunk rows outside the
				// payload row and reassembled on every read.
				const imageData = 'd'.repeat(256 * 1024 + 1);
				const input = dispatchInput({
					message: {
						kind: 'user',
						body: 'Here is the screenshot.',
						attachments: [{ type: 'image', data: imageData, mimeType: 'image/png' }],
					},
				});
				const admitted = await admitDispatchReady(store, input);
				if (admitted.kind !== 'submission') throw new Error('Expected a dispatch submission.');
				expect(admitted.submission.input.message).toEqual(input.message);
				expect((await store.submissions.getSubmission(input.dispatchId))?.input.message).toEqual(
					input.message,
				);
			});
		});

		// ── Direct admission ───────────────────────────────────────────────

		describe('direct admission', () => {
			it('round-trips direct submission images', async () => {
				const store = await create();
				const input = directInput({
					message: {
						kind: 'user',
						body: 'Hello',
						attachments: [{ type: 'image', data: 'image-data', mimeType: 'image/png' }],
					},
				});
				const admitted = await admitDirectReady(store,input);
				expect(admitted.input).toEqual(input);
				expect((await store.submissions.getSubmission(input.submissionId))?.input).toEqual(input);
			});

			it('rejects replay when a direct submission image has different bytes', async () => {
				const store = await create();
				await admitDirectReady(store,
					directInput({
						message: {
							kind: 'user',
							body: 'Hello',
							attachments: [{ type: 'image', data: 'first-image', mimeType: 'image/png' }],
						},
					}),
				);
				await expect(
					admitDirectReady(store,
						directInput({
							message: {
								kind: 'user',
								body: 'Hello',
								attachments: [{ type: 'image', data: 'second-image', mimeType: 'image/png' }],
							},
						}),
					),
				).rejects.toThrow('unexpected result');
			});
		});

		describe('canonical readiness', () => {
			it('does not list or claim a queued submission before canonical readiness', async () => {
				const store = await create();
				const admission = await store.submissions.admitDispatch(dispatchInput());
				expect(admission).toMatchObject({
					kind: 'submission',
					submission: { canonicalReadyAt: null },
				});
				expect(await store.submissions.listRunnableSubmissions()).toEqual([]);
				expect(
					await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1')),
				).toBeNull();
			});

			it('lists unready queued submissions in admission order', async () => {
				const store = await create();
				const first = await store.submissions.admitDispatch(dispatchInput());
				await admitDispatchReady(store,dispatchInput({ dispatchId: 'dispatch-2' }));
				const third = await store.submissions.admitDirect(
					directInput({ submissionId: 'direct-2', id: 'agent-2' }),
				);
				expect(await store.submissions.listUnreadySubmissions()).toEqual([
					expect.objectContaining({
						submissionId: first.kind === 'submission' ? first.submission.submissionId : '',
					}),
					expect.objectContaining({ submissionId: third.submissionId }),
				]);
			});

			it('lists and claims a queued submission after canonical readiness', async () => {
				const store = await create();
				await store.submissions.admitDispatch(dispatchInput());
				const ready = await store.submissions.markSubmissionCanonicalReady('dispatch-1');
				expect(ready?.canonicalReadyAt).toEqual(expect.any(Number));
				expect(await store.submissions.markSubmissionCanonicalReady('dispatch-1')).toEqual(ready);
				expect(await store.submissions.listRunnableSubmissions()).toEqual([ready]);
				expect(
					await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1')),
				).toMatchObject({ status: 'running', canonicalReadyAt: ready?.canonicalReadyAt });
			});
		});

		// ── Submission ordering ───────────────────────────────────────────

		describe('submission ordering', () => {
			it('orders direct and dispatched submissions together within one session', async () => {
				const store = await create();
				const direct = await admitDirectReady(store,directInput());
				await admitDispatchReady(store,dispatchInput());
				const other = await admitDirectReady(store,
					directInput({ submissionId: 'direct-2', id: 'agent-2' }),
				);
				expect(await store.submissions.listRunnableSubmissions()).toEqual([direct, other]);
				expect(
					await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-blocked')),
				).toBeNull();
			});

			it('lists queued dispatches in admission order and selects one runnable head per session', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await admitDispatchReady(store,dispatchInput({ dispatchId: 'dispatch-2' }));
				await admitDispatchReady(store,
					dispatchInput({ dispatchId: 'dispatch-3', id: 'agent-2' }),
				);

				expect(await store.submissions.listRunnableSubmissions()).toEqual([
					expect.objectContaining({ submissionId: 'dispatch-1' }),
					expect.objectContaining({ submissionId: 'dispatch-3' }),
				]);
			});
		});

		// ── Claim semantics ──────────────────────────────────────────────

		describe('claim semantics', () => {
			it('claims only runnable session heads while allowing separate sessions to claim independently', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await admitDispatchReady(store,dispatchInput({ dispatchId: 'dispatch-2' }));
				await admitDispatchReady(store,
					dispatchInput({ dispatchId: 'dispatch-3', id: 'agent-2' }),
				);

				const first = await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));
				const blocked = await store.submissions.claimSubmission(claim('dispatch-2', 'attempt-2'));
				const other = await store.submissions.claimSubmission(claim('dispatch-3', 'attempt-3'));

				expect(first).toMatchObject({
					submissionId: 'dispatch-1',
					status: 'running',
					attemptId: 'attempt-1',
					startedAt: expect.any(Number),
				});
				expect(blocked).toBeNull();
				expect(other).toMatchObject({
					submissionId: 'dispatch-3',
					status: 'running',
					attemptId: 'attempt-3',
				});
				expect(await store.submissions.listRunningSubmissions()).toEqual([first, other]);
				expect(await store.submissions.listRunnableSubmissions()).toEqual([]);
			});
		});

		// ── Lifecycle transitions ─────────────────────────────────────────

		describe('lifecycle transitions', () => {
			it('records input application and recovery requests only for the owning attempt', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));

				expect(
					await store.submissions.markSubmissionInputApplied(attempt('dispatch-1', 'attempt-1')),
				).toBe(true);
				expect(
					await store.submissions.markSubmissionInputApplied(
						attempt('dispatch-1', 'stale-attempt'),
					),
				).toBe(false);
				expect(
					await store.submissions.requestSubmissionRecovery(attempt('dispatch-1', 'attempt-1')),
				).toBe(true);
				expect(
					await store.submissions.requestSubmissionRecovery(attempt('dispatch-1', 'stale-attempt')),
				).toBe(false);

				expect(await store.submissions.getSubmission('dispatch-1')).toMatchObject({
					status: 'running',
					attemptId: 'attempt-1',
					inputAppliedAt: expect.any(Number),
					recoveryRequestedAt: expect.any(Number),
				});
			});

			it('requeues interrupted attempts only before canonical input application', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput({ dispatchId: 'requeue-safe' }));
				await admitDispatchReady(store,
					dispatchInput({ dispatchId: 'requeue-unsafe', id: 'agent-2' }),
				);
				await store.submissions.claimSubmission(claim('requeue-safe', 'attempt-safe'));
				await store.submissions.claimSubmission(claim('requeue-unsafe', 'attempt-unsafe'));
				await store.submissions.markSubmissionInputApplied(
					attempt('requeue-unsafe', 'attempt-unsafe'),
				);

				expect(
					await store.submissions.requeueSubmissionBeforeInputApplied(
						attempt('requeue-safe', 'attempt-safe'),
					),
				).toBe(true);
				expect(
					await store.submissions.requeueSubmissionBeforeInputApplied(
						attempt('requeue-unsafe', 'attempt-unsafe'),
					),
				).toBe(false);
				expect(await store.submissions.getSubmission('requeue-safe')).toMatchObject({
					status: 'queued',
				});
				expect(await store.submissions.getSubmission('requeue-unsafe')).toMatchObject({
					status: 'running',
				});
			});

			it('reports unsettled visibility until a claimed dispatch completes', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				expect(await store.submissions.hasUnsettledSubmissions()).toBe(true);
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));
				expect(await store.submissions.listRunningSubmissions()).toHaveLength(1);
				await store.submissions.completeSubmission(attempt('dispatch-1', 'attempt-1'));
				expect(await store.submissions.hasUnsettledSubmissions()).toBe(false);
				expect(await store.submissions.getSubmission('dispatch-1')).toMatchObject({
					status: 'settled',
				});
			});

			it('ignores stale-attempt settlement and keeps the first owning terminal state', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));

				await store.submissions.completeSubmission(attempt('dispatch-1', 'stale-attempt'));
				await store.submissions.failSubmission(
					attempt('dispatch-1', 'attempt-1'),
					new Error('first failure'),
				);
				await store.submissions.completeSubmission(attempt('dispatch-1', 'attempt-1'));
				await store.submissions.failSubmission(
					attempt('dispatch-1', 'attempt-1'),
					new Error('later failure'),
				);

				expect(await store.submissions.getSubmission('dispatch-1')).toMatchObject({
					status: 'settled',
					error: 'first failure',
				});
			});
		});

		describe('session abort requests', () => {
			it('stamps an abort intent on a queued submission without changing its status', async () => {
				const store = await create();
				const admitted = await admitDispatchReady(store, dispatchInput());
				const sessionKey =
					admitted.kind === 'submission' ? admitted.submission.sessionKey : '';

				const affected = await store.submissions.requestSessionAbort(sessionKey);

				expect(affected).toEqual(['dispatch-1']);
				expect(await store.submissions.getSubmission('dispatch-1')).toMatchObject({
					status: 'queued',
					abortRequestedAt: expect.any(Number),
				});
			});

			it('stamps the running head and every queued submission in the session at once', async () => {
				const store = await create();
				// Same instance/session: dispatch-1 runs, the rest queue behind it.
				const admitted = await admitDispatchReady(store, dispatchInput());
				await admitDispatchReady(store, dispatchInput({ dispatchId: 'dispatch-2' }));
				await admitDispatchReady(store, dispatchInput({ dispatchId: 'dispatch-3' }));
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));
				const sessionKey =
					admitted.kind === 'submission' ? admitted.submission.sessionKey : '';

				const affected = await store.submissions.requestSessionAbort(sessionKey);

				expect(new Set(affected)).toEqual(new Set(['dispatch-1', 'dispatch-2', 'dispatch-3']));
				expect(await store.submissions.getSubmission('dispatch-1')).toMatchObject({
					status: 'running',
					attemptId: 'attempt-1',
					abortRequestedAt: expect.any(Number),
				});
				expect(await store.submissions.getSubmission('dispatch-3')).toMatchObject({
					status: 'queued',
					abortRequestedAt: expect.any(Number),
				});
			});

			it('keeps the first abort timestamp when the request is repeated', async () => {
				const store = await create();
				const admitted = await admitDispatchReady(store, dispatchInput());
				const sessionKey =
					admitted.kind === 'submission' ? admitted.submission.sessionKey : '';

				await store.submissions.requestSessionAbort(sessionKey);
				const stampedAt = (await store.submissions.getSubmission('dispatch-1'))?.abortRequestedAt;
				await store.submissions.requestSessionAbort(sessionKey);

				expect((await store.submissions.getSubmission('dispatch-1'))?.abortRequestedAt).toBe(
					stampedAt,
				);
			});

			it('leaves settled submissions untouched and does not resurrect them', async () => {
				const store = await create();
				const admitted = await admitDispatchReady(store, dispatchInput());
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));
				await store.submissions.completeSubmission(attempt('dispatch-1', 'attempt-1'));
				const sessionKey =
					admitted.kind === 'submission' ? admitted.submission.sessionKey : '';

				expect(await store.submissions.requestSessionAbort(sessionKey)).toEqual([]);
				// A settled submission is an immovable sink: never offered for
				// re-processing and cannot be re-claimed.
				expect(await store.submissions.listRunnableSubmissions()).toHaveLength(0);
				expect(await store.submissions.listExpiredSubmissions()).toHaveLength(0);
				expect(
					await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-2')),
				).toBeNull();
			});

			it('returns an empty array for a session with no unsettled submissions', async () => {
				const store = await create();

				expect(await store.submissions.requestSessionAbort('no-such-session')).toEqual([]);
			});
		});

		describe('direct settlement obligation', () => {
			const settlementRecord = (outcome: 'completed' | 'failed') => ({
				v: 1 as const,
				id: 'direct-1:settled',
				type: 'submission_settled' as const,
				conversationId: 'conversation-1',
				harness: 'default',
				session: 'default',
				timestamp: '2026-06-22T00:00:00.000Z',
				submissionId: 'direct-1',
				attemptId: 'attempt-1',
				outcome,
			});

			it('reserves a canonical settlement only for the owning direct attempt', async () => {
				const store = await create();
				await admitDirectReady(store,directInput());
				await store.submissions.claimSubmission(claim('direct-1', 'attempt-1'));
				const record = settlementRecord('completed');

				expect(
					await store.submissions.reserveSubmissionSettlement(attempt('direct-1', 'stale'), {
						recordId: record.id,
						record,
					}),
				).toBeNull();
				const reserved = await store.submissions.reserveSubmissionSettlement(
					attempt('direct-1', 'attempt-1'),
					{ recordId: record.id, record },
				);
				expect(reserved).toEqual({
					submissionId: 'direct-1',
					sessionKey: 'agent-session:["agent-1","default","default"]',
					attemptId: 'attempt-1',
					recordId: record.id,
					record,
				});
				expect(await store.submissions.getSubmission('direct-1')).toMatchObject({
					status: 'terminalizing',
				});
			});

			it('replays an exact obligation and rejects a conflicting settlement payload', async () => {
				const store = await create();
				await admitDirectReady(store,directInput());
				await store.submissions.claimSubmission(claim('direct-1', 'attempt-1'));
				const ref = attempt('direct-1', 'attempt-1');
				const completed = settlementRecord('completed');
				const first = await store.submissions.reserveSubmissionSettlement(ref, {
					recordId: completed.id,
					record: completed,
				});
				expect(
					await store.submissions.reserveSubmissionSettlement(ref, {
						recordId: completed.id,
						record: completed,
					}),
				).toEqual(first);
				expect(
					await store.submissions.reserveSubmissionSettlement(ref, {
						recordId: completed.id,
						record: settlementRecord('failed'),
					}),
				).toBeNull();
			});

			it('keeps terminalizing work unsettled and ordered but not runnable or reclaimable', async () => {
				const store = await create();
				await admitDirectReady(store,directInput());
				await admitDirectReady(store,directInput({ submissionId: 'direct-2' }));
				await store.submissions.claimSubmission({
					...claim('direct-1', 'attempt-1'),
					leaseExpiresAt: 1,
				});
				const record = settlementRecord('completed');
				await store.submissions.reserveSubmissionSettlement(attempt('direct-1', 'attempt-1'), {
					recordId: record.id,
					record,
				});

				expect(await store.submissions.hasUnsettledSubmissions()).toBe(true);
				expect(await store.submissions.listRunnableSubmissions()).toEqual([]);
				expect(await store.submissions.listRunningSubmissions()).toEqual([]);
				expect(await store.submissions.listExpiredSubmissions()).toEqual([]);
			});

			it('lists and finalizes a pending settlement obligation', async () => {
				const store = await create();
				await admitDirectReady(store,directInput());
				await store.submissions.claimSubmission(claim('direct-1', 'attempt-1'));
				const ref = attempt('direct-1', 'attempt-1');
				const record = settlementRecord('completed');
				await store.submissions.reserveSubmissionSettlement(ref, {
					recordId: record.id,
					record,
				});
				expect(await store.submissions.listPendingSubmissionSettlements()).toEqual([
					{
						submissionId: 'direct-1',
						sessionKey: 'agent-session:["agent-1","default","default"]',
						attemptId: 'attempt-1',
						recordId: record.id,
						record,
					},
				]);
				expect(await store.submissions.finalizeSubmissionSettlement(ref, record.id)).toBe(true);
				expect(await store.submissions.listPendingSubmissionSettlements()).toEqual([]);
				expect(await store.submissions.hasUnsettledSubmissions()).toBe(false);
			});

			it('leaves dispatch settlement behavior unchanged', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));
				const record = settlementRecord('completed');
				expect(
					await store.submissions.reserveSubmissionSettlement(attempt('dispatch-1', 'attempt-1'), {
						recordId: record.id,
						record,
					}),
				).toBeNull();
				expect(
					await store.submissions.completeSubmission(attempt('dispatch-1', 'attempt-1')),
				).toBe(true);
			});
		});

		// ── Durability ───────────────────────────────────────────────────

		describe('durability', () => {
			it('initializes attempt_count to 0 and timeout_at to 0 at admission', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				const submission = await store.submissions.getSubmission('dispatch-1');
				expect(submission).toMatchObject({
					attemptCount: 0,
					maxRetry: 10,
					timeoutAt: 0,
				});
			});

			it('sets attempt_count to 1 and applies system defaults at claim time', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				const before = Date.now();
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));
				const claimed = await store.submissions.getSubmission('dispatch-1');
				if (!claimed) throw new Error('Expected claimed submission to exist.');
				expect(claimed.attemptCount).toBe(1);
				expect(claimed.maxRetry).toBe(10);
				expect(claimed.timeoutAt).toBeGreaterThanOrEqual(before + 60 * 60_000);
			});

			it('applies custom durability when input is marked applied', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				const customTimeout = Date.now() + 6 * 60 * 60_000;
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));
				await store.submissions.markSubmissionInputApplied(attempt('dispatch-1', 'attempt-1'), {
					maxRetry: 5,
					timeoutAt: customTimeout,
				});
				expect(await store.submissions.getSubmission('dispatch-1')).toMatchObject({
					attemptCount: 1,
					maxRetry: 5,
					timeoutAt: customTimeout,
				});
			});

			it('increments attempt_count on recovery via replaceSubmissionAttempt', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));
				expect(await store.submissions.getSubmission('dispatch-1')).toMatchObject({
					attemptCount: 1,
				});

				const replaced = await store.submissions.replaceSubmissionAttempt(
					attempt('dispatch-1', 'attempt-1'),
					'attempt-2',
				);
				expect(replaced).toMatchObject({ attemptCount: 2, attemptId: 'attempt-2' });
			});

			it('increments attempt_count and preserves timeout_at when reclaiming after requeue', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));
				const first = await store.submissions.getSubmission('dispatch-1');
				if (!first) throw new Error('Expected claimed submission to exist.');
				expect(first.attemptCount).toBe(1);

				await store.submissions.requeueSubmissionBeforeInputApplied(
					attempt('dispatch-1', 'attempt-1'),
				);
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-2'));
				expect(await store.submissions.getSubmission('dispatch-1')).toMatchObject({
					attemptCount: 2,
					timeoutAt: first.timeoutAt,
				});
			});
		});

		// ── Recovery attempt replacement ──────────────────────────────────

		describe('replaceSubmissionAttempt()', () => {
			it('replaces a running attempt and returns the updated submission', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));

				const replaced = await store.submissions.replaceSubmissionAttempt(
					attempt('dispatch-1', 'attempt-1'),
					'attempt-2',
				);

				expect(replaced).toMatchObject({
					submissionId: 'dispatch-1',
					status: 'running',
					attemptId: 'attempt-2',
				});
			});

			it('returns null without writing when the attempt no longer owns the submission', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));

				expect(
					await store.submissions.replaceSubmissionAttempt(
						attempt('dispatch-1', 'attempt-stale'),
						'attempt-2',
					),
				).toBeNull();
				expect(await store.submissions.getSubmission('dispatch-1')).toMatchObject({
					attemptId: 'attempt-1',
					attemptCount: 1,
				});
			});

			it('installs the new lease when one is supplied', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));
				const leaseExpiresAt = Date.now() + 60_000;

				const replaced = await store.submissions.replaceSubmissionAttempt(
					attempt('dispatch-1', 'attempt-1'),
					'attempt-2',
					{ ownerId: 'owner-2', leaseExpiresAt },
				);

				expect(replaced).toMatchObject({
					attemptId: 'attempt-2',
					ownerId: 'owner-2',
					leaseExpiresAt,
				});
			});
		});

		// ── Attempt markers ──────────────────────────────────────────────

		describe('attempt markers', () => {
			it('lists inserted markers with creation timestamps', async () => {
				const store = await create();
				const before = Date.now();
				await store.submissions.insertAttemptMarker(attempt('dispatch-1', 'attempt-1'));
				const markers = await store.submissions.listAttemptMarkers();
				expect(markers).toEqual([
					{ submissionId: 'dispatch-1', attemptId: 'attempt-1', createdAt: expect.any(Number) },
				]);
				const [marker] = markers;
				expect(marker).toBeDefined();
				if (!marker) throw new Error('Expected an attempt marker.');
				expect(marker.createdAt).toBeGreaterThanOrEqual(before);
			});

			it('keeps one marker with the original timestamp when the same attempt is inserted twice', async () => {
				const store = await create();
				await store.submissions.insertAttemptMarker(attempt('dispatch-1', 'attempt-1'));
				const first = await store.submissions.listAttemptMarkers();
				await store.submissions.insertAttemptMarker(attempt('dispatch-1', 'attempt-1'));
				expect(await store.submissions.listAttemptMarkers()).toEqual(first);
			});

			it('deletes only the marker matching both submission and attempt', async () => {
				const store = await create();
				await store.submissions.insertAttemptMarker(attempt('dispatch-1', 'attempt-1'));
				await store.submissions.insertAttemptMarker(attempt('dispatch-1', 'attempt-2'));
				await store.submissions.deleteAttemptMarker(attempt('dispatch-1', 'attempt-1'));
				expect(await store.submissions.listAttemptMarkers()).toEqual([
					expect.objectContaining({ submissionId: 'dispatch-1', attemptId: 'attempt-2' }),
				]);
			});

			it('silently handles deleting nonexistent markers', async () => {
				const store = await create();
				await expect(
					store.submissions.deleteAttemptMarker(attempt('missing', 'attempt-1')),
				).resolves.toBeUndefined();
			});
		});

		// ── Lease management ────────────────────────────────────────────────

		describe('renewLeases()', () => {
			it('extends lease timestamp for owned running submissions', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				const expiry = Date.now() + 5_000;
				await store.submissions.claimSubmission({
					submissionId: 'dispatch-1',
					attemptId: 'attempt-1',
					ownerId: 'owner-a',
					leaseExpiresAt: expiry,
				});
				await store.submissions.renewLeases('owner-a', ['dispatch-1']);
				const submission = await store.submissions.getSubmission('dispatch-1');
				if (!submission) throw new Error('Expected renewed submission to exist.');
				expect(submission.leaseExpiresAt).toBeGreaterThan(expiry);
			});

			it('ignores submissions owned by a different coordinator', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				const expiry = Date.now() + 5_000;
				await store.submissions.claimSubmission({
					submissionId: 'dispatch-1',
					attemptId: 'attempt-1',
					ownerId: 'owner-a',
					leaseExpiresAt: expiry,
				});
				await store.submissions.renewLeases('owner-b', ['dispatch-1']);
				const submission = await store.submissions.getSubmission('dispatch-1');
				if (!submission) throw new Error('Expected submission to exist.');
				expect(submission.leaseExpiresAt).toBe(expiry);
			});

			it('ignores settled submissions', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await store.submissions.claimSubmission(claim('dispatch-1', 'attempt-1'));
				await store.submissions.completeSubmission(attempt('dispatch-1', 'attempt-1'));
				// Should not throw — settled submissions are silently skipped.
				await store.submissions.renewLeases('test-owner', ['dispatch-1']);
			});
		});

		describe('listExpiredSubmissions()', () => {
			it('returns running submissions with expired leases', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await store.submissions.claimSubmission({
					submissionId: 'dispatch-1',
					attemptId: 'attempt-1',
					ownerId: 'owner-a',
					leaseExpiresAt: 1, // expired in the past
				});
				const expired = await store.submissions.listExpiredSubmissions();
				expect(expired).toHaveLength(1);
				const submission = expired[0];
				if (!submission) throw new Error('Expected one expired submission.');
				expect(submission.submissionId).toBe('dispatch-1');
			});

			it('excludes submissions with future lease expiry', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await store.submissions.claimSubmission({
					submissionId: 'dispatch-1',
					attemptId: 'attempt-1',
					ownerId: 'owner-a',
					leaseExpiresAt: Date.now() + 60_000,
				});
				const expired = await store.submissions.listExpiredSubmissions();
				expect(expired).toHaveLength(0);
			});

			it('excludes settled submissions', async () => {
				const store = await create();
				await admitDispatchReady(store,dispatchInput());
				await store.submissions.claimSubmission({
					submissionId: 'dispatch-1',
					attemptId: 'attempt-1',
					ownerId: 'owner-a',
					leaseExpiresAt: 1,
				});
				await store.submissions.completeSubmission(attempt('dispatch-1', 'attempt-1'));
				const expired = await store.submissions.listExpiredSubmissions();
				expect(expired).toHaveLength(0);
			});

			it('returns empty when no submissions exist', async () => {
				const store = await create();
				const expired = await store.submissions.listExpiredSubmissions();
				expect(expired).toHaveLength(0);
			});
		});

		// ── Turn-boundary joins (dispatch-while-busy) ───────────────────────

		describe('turn-boundary joins', () => {
			/** A running host with `count` queued dispatches behind it. */
			async function hostWithQueued(store: AgentExecutionStore, count: number) {
				await admitDispatchReady(store, dispatchInput({ dispatchId: 'host-1' }));
				await store.submissions.claimSubmission(claim('host-1', 'attempt-1'));
				for (let index = 0; index < count; index++) {
					await admitDispatchReady(store, dispatchInput({ dispatchId: `queued-${index + 1}` }));
				}
				return attempt('host-1', 'attempt-1');
			}

			it('claims the queued dispatch prefix in admission order onto a running host', async () => {
				const store = await create();
				const host = await hostWithQueued(store, 2);
				const claimed = await store.submissions.claimJoinableSubmissions(host, 'assistant');
				expect(claimed.map((submission) => submission.submissionId)).toEqual([
					'queued-1',
					'queued-2',
				]);
				expect(claimed.map((submission) => submission.status)).toEqual(['joining', 'joining']);
				expect(claimed.map((submission) => submission.joinedInto)).toEqual(['host-1', 'host-1']);
				expect(await store.submissions.getSubmission('queued-1')).toMatchObject({
					status: 'joining',
					joinedInto: 'host-1',
				});
				// No double-claim: the prefix is spoken for.
				expect(await store.submissions.claimJoinableSubmissions(host, 'assistant')).toEqual([]);
			});

			it('claims nothing for a stale attempt or a host that is not running', async () => {
				const store = await create();
				const host = await hostWithQueued(store, 1);
				expect(
					await store.submissions.claimJoinableSubmissions(
						attempt('host-1', 'stale-attempt'),
						'assistant',
					),
				).toEqual([]);
				await store.submissions.completeSubmission(host);
				expect(await store.submissions.claimJoinableSubmissions(host, 'assistant')).toEqual([]);
				expect(await store.submissions.getSubmission('queued-1')).toMatchObject({
					status: 'queued',
				});
			});

			it('claims direct (HTTP) deliveries alongside dispatches — both kinds join alike', async () => {
				const store = await create();
				const host = await hostWithQueued(store, 1);
				await admitDirectReady(store, directInput({ submissionId: 'direct-mid' }));
				await admitDispatchReady(store, dispatchInput({ dispatchId: 'queued-behind' }));
				const claimed = await store.submissions.claimJoinableSubmissions(host, 'assistant');
				expect(claimed.map((submission) => [submission.submissionId, submission.kind])).toEqual([
					['queued-1', 'dispatch'],
					['direct-mid', 'direct'],
					['queued-behind', 'dispatch'],
				]);
			});

			it('stops the prefix at the first non-joinable row, preserving admission order', async () => {
				const store = await create();
				const host = await hostWithQueued(store, 1);
				// Admitted but never canonical-ready: not joinable, and everything
				// behind it stays queued (stop, don't skip).
				await store.submissions.admitDispatch(dispatchInput({ dispatchId: 'unready-mid' }));
				await admitDispatchReady(store, dispatchInput({ dispatchId: 'queued-behind' }));
				const claimed = await store.submissions.claimJoinableSubmissions(host, 'assistant');
				expect(claimed.map((submission) => submission.submissionId)).toEqual(['queued-1']);
				expect(await store.submissions.getSubmission('unready-mid')).toMatchObject({
					status: 'queued',
				});
				expect(await store.submissions.getSubmission('queued-behind')).toMatchObject({
					status: 'queued',
				});
			});

			it('reserves a joined direct delivery settlement under the host attempt', async () => {
				const store = await create();
				const host = await hostWithQueued(store, 0);
				await admitDirectReady(store, directInput({ submissionId: 'direct-joined' }));
				await store.submissions.claimJoinableSubmissions(host, 'assistant');
				await store.submissions.finalizeJoinedSubmission(host, 'direct-joined');
				const record = {
					v: 1 as const,
					id: 'direct-joined:settled',
					type: 'submission_settled' as const,
					conversationId: 'conversation-1',
					harness: 'default',
					session: 'default',
					timestamp: '2026-06-22T00:00:00.000Z',
					submissionId: 'direct-joined',
					attemptId: 'attempt-1',
					outcome: 'completed' as const,
				};
				// Fenced on the HOST attempt: a stale attempt reserves nothing.
				expect(
					await store.submissions.reserveSubmissionSettlement(
						attempt('direct-joined', 'stale-attempt'),
						{ recordId: record.id, record },
					),
				).toBeNull();
				const reserved = await store.submissions.reserveSubmissionSettlement(
					attempt('direct-joined', 'attempt-1'),
					{ recordId: record.id, record },
				);
				expect(reserved).toMatchObject({
					submissionId: 'direct-joined',
					attemptId: 'attempt-1',
					recordId: record.id,
				});
				// The row adopted the host attempt on its way to terminalizing.
				expect(await store.submissions.getSubmission('direct-joined')).toMatchObject({
					status: 'terminalizing',
					attemptId: 'attempt-1',
				});
				expect(
					await store.submissions.finalizeSubmissionSettlement(
						attempt('direct-joined', 'attempt-1'),
						record.id,
					),
				).toBe(true);
				const settled = await store.submissions.getSubmission('direct-joined');
				expect(settled).toMatchObject({ status: 'settled' });
				expect(settled?.error).toBeUndefined();
			});

			it('stops the prefix at an abort-requested delivery and at a different agent', async () => {
				const store = await create();
				const host = await hostWithQueued(store, 0);
				await admitDispatchReady(store, dispatchInput({ dispatchId: 'aborted-head' }));
				await store.submissions.requestSessionAbort('agent-session:["agent-1","default","default"]');
				await admitDispatchReady(store, dispatchInput({ dispatchId: 'queued-behind' }));
				expect(await store.submissions.claimJoinableSubmissions(host, 'assistant')).toEqual([]);
				// Different agent name: same stop-don't-skip rule.
				expect(await store.submissions.claimJoinableSubmissions(host, 'other-agent')).toEqual([]);
			});

			it('finalizes a claimed join once and fences on the host attempt', async () => {
				const store = await create();
				const host = await hostWithQueued(store, 1);
				await store.submissions.claimJoinableSubmissions(host, 'assistant');
				expect(
					await store.submissions.finalizeJoinedSubmission(
						attempt('host-1', 'stale-attempt'),
						'queued-1',
					),
				).toBe(false);
				expect(await store.submissions.finalizeJoinedSubmission(host, 'queued-1')).toBe(true);
				expect(await store.submissions.getSubmission('queued-1')).toMatchObject({
					status: 'joined',
					joinedInto: 'host-1',
					inputAppliedAt: expect.any(Number),
				});
				// Already joined: no second transition.
				expect(await store.submissions.finalizeJoinedSubmission(host, 'queued-1')).toBe(false);
			});

			it('reverts an unapplied join back to the queue', async () => {
				const store = await create();
				const host = await hostWithQueued(store, 1);
				await store.submissions.claimJoinableSubmissions(host, 'assistant');
				expect(
					await store.submissions.revertJoiningSubmission(
						attempt('host-1', 'stale-attempt'),
						'queued-1',
					),
				).toBe(false);
				expect(await store.submissions.revertJoiningSubmission(host, 'queued-1')).toBe(true);
				const reverted = await store.submissions.getSubmission('queued-1');
				expect(reverted).toMatchObject({ status: 'queued' });
				expect(reverted?.joinedInto).toBeUndefined();
				expect(reverted?.inputAppliedAt).toBeUndefined();
			});

			it('lists unsettled joins for the host in admission order', async () => {
				const store = await create();
				const host = await hostWithQueued(store, 2);
				await store.submissions.claimJoinableSubmissions(host, 'assistant');
				await store.submissions.finalizeJoinedSubmission(host, 'queued-1');
				const joined = await store.submissions.listJoinedSubmissions('host-1');
				expect(joined.map((submission) => [submission.submissionId, submission.status])).toEqual([
					['queued-1', 'joined'],
					['queued-2', 'joining'],
				]);
			});

			it('joined deliveries settle with a completing host; joining stragglers revert', async () => {
				const store = await create();
				const host = await hostWithQueued(store, 2);
				await store.submissions.claimJoinableSubmissions(host, 'assistant');
				await store.submissions.finalizeJoinedSubmission(host, 'queued-1');
				await store.submissions.completeSubmission(host);
				const joined = await store.submissions.getSubmission('queued-1');
				expect(joined).toMatchObject({ status: 'settled' });
				expect(joined?.error).toBeUndefined();
				// The unconfirmed join goes back to the queue instead of vanishing.
				expect(await store.submissions.getSubmission('queued-2')).toMatchObject({
					status: 'queued',
				});
			});

			it('joined deliveries share a failing host outcome', async () => {
				const store = await create();
				const host = await hostWithQueued(store, 1);
				await store.submissions.claimJoinableSubmissions(host, 'assistant');
				await store.submissions.finalizeJoinedSubmission(host, 'queued-1');
				await store.submissions.failSubmission(host, new Error('host exploded'));
				expect(await store.submissions.getSubmission('queued-1')).toMatchObject({
					status: 'settled',
					error: 'host exploded',
				});
			});

			it('joined deliveries settle when a direct host finalizes its settlement', async () => {
				const store = await create();
				await admitDirectReady(store, directInput({ submissionId: 'direct-host' }));
				await store.submissions.claimSubmission(claim('direct-host', 'attempt-1'));
				const host = attempt('direct-host', 'attempt-1');
				await admitDispatchReady(store, dispatchInput({ dispatchId: 'queued-1' }));
				await store.submissions.claimJoinableSubmissions(host, 'assistant');
				await store.submissions.finalizeJoinedSubmission(host, 'queued-1');
				const record = {
					v: 1 as const,
					id: 'direct-host:settled',
					type: 'submission_settled' as const,
					conversationId: 'conversation-1',
					harness: 'default',
					session: 'default',
					timestamp: '2026-06-22T00:00:00.000Z',
					submissionId: 'direct-host',
					attemptId: 'attempt-1',
					outcome: 'completed' as const,
				};
				await store.submissions.reserveSubmissionSettlement(host, {
					recordId: record.id,
					record,
				});
				await store.submissions.finalizeSubmissionSettlement(host, record.id);
				const joined = await store.submissions.getSubmission('queued-1');
				expect(joined).toMatchObject({ status: 'settled' });
				expect(joined?.error).toBeUndefined();
			});

			it('unsettled joins block later queued work and clear with the host', async () => {
				const store = await create();
				const host = await hostWithQueued(store, 1);
				await store.submissions.claimJoinableSubmissions(host, 'assistant');
				await store.submissions.finalizeJoinedSubmission(host, 'queued-1');
				await admitDispatchReady(store, dispatchInput({ dispatchId: 'later' }));
				// The joined row is unsettled and earlier: 'later' is not runnable.
				expect(await store.submissions.listRunnableSubmissions()).toEqual([]);
				expect(await store.submissions.hasUnsettledSubmissions()).toBe(true);
				await store.submissions.completeSubmission(host);
				// Settle fan-out cleared the joined row in the same step: 'later'
				// is now the runnable head.
				expect(
					(await store.submissions.listRunnableSubmissions()).map(
						(submission) => submission.submissionId,
					),
				).toEqual(['later']);
			});

			it('requestSessionAbort stamps joining and joined deliveries', async () => {
				const store = await create();
				const host = await hostWithQueued(store, 2);
				await store.submissions.claimJoinableSubmissions(host, 'assistant');
				await store.submissions.finalizeJoinedSubmission(host, 'queued-1');
				const stamped = await store.submissions.requestSessionAbort(
					'agent-session:["agent-1","default","default"]',
				);
				expect(new Set(stamped)).toEqual(new Set(['host-1', 'queued-1', 'queued-2']));
			});
		});

		// ── Edge cases ──────────────────────────────────────────────────────

		describe('edge cases', () => {
			it('reports no unsettled submissions initially', async () => {
				const store = await create();
				expect(await store.submissions.hasUnsettledSubmissions()).toBe(false);
			});

			it('getSubmission returns null for unknown ids', async () => {
				const store = await create();
				expect(await store.submissions.getSubmission('nonexistent')).toBeNull();
			});
		});
	});
}
