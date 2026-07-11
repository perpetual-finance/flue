---
title: Data Persistence API
description: Reference for Flue persistence adapters and stores.
lastReviewedAt: 2026-07-02
---

Adapter authors implement these contracts to back a custom database. Import them from `@flue/runtime/adapter`:

```ts
import type {
  AgentExecutionStore,
  AgentSubmissionStore,
  AttachmentStore,
  ConversationStreamStore,
  PersistenceAdapter,
  PersistenceStores,
} from '@flue/runtime/adapter';
```

Application code usually configures an adapter through `db.ts`; see [Database](/docs/guide/database/). Always typecheck an adapter against the package exports. If this page and the package differ, the package wins.

Every backend implements the same observable contract. Atomic operations must remain atomic under concurrency regardless of whether the backend uses transactions, conditional writes, or another native primitive.

## `PersistenceAdapter`

```ts
interface PersistenceAdapter {
  connect(): PersistenceStores | Promise<PersistenceStores>;
  migrate?(): void | Promise<void>;
  close?(): void | Promise<void>;
}

interface PersistenceStores {
  readonly executionStore: AgentExecutionStore;
  readonly conversationStreamStore: ConversationStreamStore;
  readonly attachmentStore: AttachmentStore;
}
```

Flue calls `migrate()` once at startup when present, then awaits `connect()` once. An unreachable or misconfigured database therefore fails at boot. Flue calls `close()` during shutdown when present.

There are exactly three stores. The run store and event-stream store that earlier betas required were deleted with workflows — the append-only conversation stream is the only durable transcript, and submissions are the only durable execution state.

### Schema versioning

An adapter must record its schema or format version when creating storage and reject every mismatch before reading or writing data. The current pre-1.0 format is reset-only: clear stores created by another version rather than attempting an in-place migration. Use `FLUE_SCHEMA_VERSION`, `assertSupportedFlueSchemaVersion()`, and `PersistedSchemaVersionError` from `@flue/runtime/adapter`.

## `AgentExecutionStore`

```ts
interface AgentExecutionStore {
  readonly submissions: AgentSubmissionStore;
}
```

`AgentExecutionStore` contains submission lifecycle state only. Conversation transcripts are not session rows; they live exclusively in `ConversationStreamStore`.

## `AgentSubmissionStore`

`AgentSubmissionStore` owns ordered admission, claim ownership, turn journals, settlement obligations, recovery, attempt markers, and lease renewal for direct prompts and `dispatch(...)` input. Its turn-journal, settlement, and lease groups mirror the durable-execution engine and remain subject to change until 1.0.

### Admission and ordering

`admitDispatch()` is idempotent by dispatch id. An exact replay returns the existing admission; the same id with a different payload reports a conflict. `admitDirect()` provides equivalent idempotent admission for direct prompts.

`claimSubmission()` atomically changes a queued submission to running only when it is the first unsettled submission for that session. `listRunnableSubmissions()` returns at most one queued head per session, in admission order. Sessions are append-only for the lifetime of the agent instance; the contract has no per-session deletion operation.

### Lifecycle and recovery

Lifecycle transitions are gated by the owning attempt. Input application, recovery requests, requeue-before-input, completion, and failure must reject stale attempts. The first terminal state wins.

Recovery replaces a running attempt through a single fenced compare-and-set that must preserve attempt ownership. Settlement reservation records the exact canonical settlement before finalization. Attempt markers and leases provide durable evidence for recovery and ownership.

## `ConversationStreamStore`

```ts
interface ConversationStreamStore {
  createStream(path: string, identity: ConversationStreamIdentity): Promise<void>;
  acquireProducer(path: string, producerId: string): Promise<ConversationProducerClaim>;
  append(input: ConversationAppendInput): Promise<{ offset: string }>;
  read(
    path: string,
    options?: { offset?: string; limit?: number },
  ): Promise<ConversationStreamReadResult>;
  getMeta(path: string): Promise<ConversationStreamMeta | null>;
  delete(path: string): Promise<void>;
  subscribe(path: string, listener: () => void): () => void;
}
```

This append-only, per-agent-instance stream is the sole canonical transcript. Stream paths key on the agent's identity (the exported agent function's name, or its `agentName` static override) plus the conversation id. The stream contains records for all sessions in that instance and preserves their history for the instance lifetime. Adapters must not model a second authoritative transcript in session rows, snapshots, or event streams.

Producer claims fence stale writers. Appends preserve producer sequence invariants, and reads return durable resume offsets. `delete(path)` is a low-level whole-instance primitive; its presence does not promise a public retention or deletion workflow.

Canonical state is reconstructed by replaying the conversation stream from its beginning. Replay acceleration and compaction of this persisted log are deferred; adapters should not invent a second transcript or cache contract.

## `AttachmentStore`

```ts
interface AttachmentStore {
  put(input: PutAttachmentInput): Promise<void>;
  get(input: GetAttachmentInput): Promise<StoredAttachment | null>;
  deleteForInstance(streamPath: string): Promise<void>;
}
```

Attachments are immutable external payloads referenced by canonical conversation records. An `AttachmentRef` is opaque storage identity and integrity metadata—`{ id, mimeType, size, digest }`—not a download URL. Each attachment is owned by the conversation it belongs to (`put()` takes a `conversationId`), and `get()` scopes reads to that conversation. `put()` must be idempotent for identical bytes, metadata, and conversation, and reject conflicting reuse of an attachment id.

`deleteForInstance()` is a low-level whole-instance cleanup primitive. The adapter contract does not expose per-session attachment deletion or promise public orchestration around whole-instance deletion.

## Offsets

Use `formatOffset()` and `parseOffset()` from `@flue/runtime/adapter` for Durable Streams offsets. `nextOffset` is the last delivered or appended offset, suitable as the next strictly-after cursor.

## Validating an adapter

`@flue/runtime/test-utils` exports contract suites for the three stores: `defineStoreContractTests` (submissions), `defineConversationStreamStoreContractTests`, and `defineAttachmentStoreContractTests`. Run every applicable suite against isolated storage. These suites are the acceptance tests for the observable adapter contract.
