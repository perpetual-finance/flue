---
title: Durable Agents
description: Understand how Flue agents handle server restarts, interrupted connections, and other disruptions.
lastReviewedAt: 2026-07-02
---

Durable execution is about recovering safely when running work is disrupted by a server restart, deployment, lost connection, or unexpected failure. In Flue, the durable unit is the **conversation**: every piece of agent work — a direct prompt, a dispatched webhook, a scheduled job — is an operation inside one durable conversation, and recovery always works from that conversation's canonical record.

## Durable Agents

Agents are continuing, stateful contexts. Each agent conversation owns one canonical conversation stream. Sessions within the conversation select their context from that stream, and later operations rebuild model context from the same durable records that recovery and clients read.

Direct prompts and asynchronous `dispatch(...)` inputs are operations inside an agent conversation. For application-owned ingress such as webhooks or chat messages, see [Routing](/docs/guide/routing/).

```txt
agent input → canonical conversation stream → operation completes
                         ↓
later input → rebuilds context → continues the conversation
```

### Persist conversations

The canonical stream records model-visible messages, assistant output, tool calls and results, compaction, topology, and recovery facts. Attachment bytes live in a separate immutable attachment store and are referenced from canonical records. Mutable submission claims and leases remain operational state rather than a second transcript.

To persist this state in an application-controlled database, create a `src/db.ts` or `.flue/db.ts` file that default-exports a `PersistenceAdapter`. See [Database](/docs/guide/database/) for setup and [Data Persistence API](/docs/api/data-persistence-api/) for the storage contracts.

### Durable Agents on Cloudflare

On Cloudflare, each agent conversation is one Durable Object instance. Durable Object SQLite stores the canonical stream, attachment bytes, and accepted submissions. Direct HTTP prompts and asynchronous `dispatch(...)` inputs enter the same ordered queue.

```txt
direct HTTP prompt ─────────────────────┐
                                        ├→ durable queue → canonical stream
dispatch(...) input ────────────────────┘
```

The connection that submitted a prompt observes the work but does not own it. If the response closes after Cloudflare accepts the prompt, backend processing can continue. Clients can reconnect to the canonical conversation stream from a durable offset.

After interruption, Flue decides what to do next from the canonical conversation stream alone. It recognizes already-completed output, continues usable partial output from durable deltas, and reuses completed tool results. A tool call with no durable result is represented as interrupted with an unknown outcome rather than run again automatically. When no output was durably persisted before the interruption, recovery may re-dispatch the provider once — consistent with at-least-once execution.

This recovery is intentionally conservative because repeating model or tool activity can duplicate external effects. Use application-owned idempotency keys where repeated effects would be harmful. See [Cloudflare](/docs/guide/targets/cloudflare/) for platform configuration and migrations.

When recovery cannot complete the work — the retry budget (`durability.maxAttempts`) is exhausted, the processing timeout expires, or an abort settles a crash-interrupted submission — the submission is terminalized and its conversation is settled to a deterministic rest state. Every tool call without a confirmed outcome receives an explicit interrupted-error result (never a re-execution), an interrupted partial stream is completed as aborted, and a terminal advisory records the reason with the interrupted calls as structured metadata. No tool call is ever left permanently unresolved, and the settled turn stays visible to future model context.

### Durable Agents on Node.js

Without `db.ts`, Node uses process-local in-memory SQLite. Restarting the process loses conversations and accepted submissions.

A durable adapter persists canonical conversations and submission coordination across process or host replacement. Startup reconciliation and periodic lease scans reclaim interrupted submissions using the same conservative recovery policy as Cloudflare. Node does not receive Durable Object wake or Fiber recovery, so a replacement process must start before recovery can continue.

Node requires **one live process to own a given agent conversation**. A shared database supports restart or host-replacement recovery; it does not make active-active processing, round-robin routing, or concurrent ownership of the same conversation safe. Deployments with multiple Node replicas must route each conversation to one live owner and avoid overlapping owners during replacement.

On graceful shutdown, active submissions stop at a turn boundary and remain reclaimable. On restart, durable partial output and completed tool results are reused. A tool call that may have started without producing a durable result is not repeated automatically.

To deliberately stop a conversation's work, `POST` its `/abort` route (the SDK client's `abort()`); this aborts the running submission and everything queued behind it. Abort is a distinct terminal outcome, not a failure: it signals the in-flight attempt to stop at the next halt point, settles queued work before its provider runs, and on recovery settles a crash-interrupted aborted submission as aborted rather than retrying it. Work that already completed is unaffected — an abort that loses the race to a finished response settles as completed.

Agent prompts are fire-and-forget; there is no synchronous result. Awaiting completion with the SDK client's `wait()` follows the durable conversation stream and is best-effort and process-scoped — if that process disappears, the submission still settles in the background. Observe the canonical conversation with `observe()` to receive the durable outcome and the agent's reply. `history()` and raw stream reads remain lower-level primitives for applications that manage their own materialized state.

A file-backed SQLite adapter protects against restart on the same host. Surviving host loss requires external durable storage such as Postgres, while still preserving the single-live-owner rule. See [Database](/docs/guide/database/) and [Deploy Agents on Node.js](/docs/ecosystem/deploy/node/).

### Cloudflare and Node recovery compared

| Failure case                         | Cloudflare                                                          | Node without `db.ts`         | Node with durable `db.ts`                                                                               |
| ------------------------------------ | ------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| Process disappears during agent work | Durable Object storage retains accepted work and canonical records. | Process-local state is lost. | Durable stores retain work for replacement-process recovery.                                            |
| Recovery trigger                     | Object startup, scheduled wake, and Fiber callbacks.                | None after restart.          | Replacement-process startup and periodic expired-lease scans.                                           |
| Ownership                            | Durable Object routing provides one owner per conversation.         | One process-local owner.     | One live Node owner per conversation; shared storage supports replacement, not active-active ownership. |

### Delegated tasks (subagents)

A model-invoked `task(...)` delegates work to a subagent that runs inside the parent operation, writing its own durable conversation records as it goes. If the process disappears while a subagent is mid-flight, recovery resumes that subagent in-process from its durable records — continuing an interrupted stream or an unfinished tool batch exactly as a top-level agent recovers — and resolves the parent's `task` tool call from the resumed result. The subagent shares the parent's durability envelope (timeout and retry budget) and has no independent durability configuration.

If a subagent's profile no longer exists after a redeploy, that one `task` call resolves with an error so the parent can continue; recovery never silently abandons work that a retry could still complete.

If the parent's budget runs out while a subagent is still unresolved, the parent is terminalized like any other submission: the `task` call settles with an interrupted-error outcome that links the child's retained conversation, rather than resuming the child past the budget. The child's durable transcript remains available for inspection.

Programmatic `session.task(...)` calls made directly from your own code are not recovered this way: like other programmatic session calls, they have no durable submission to resume from.

### Keep workspace state separate

Persisting a conversation does not make sandbox files durable. The default virtual sandbox is an in-memory workspace, while a durable remote workspace does not preserve conversation records by itself. Choose workspace and conversation persistence independently. See [Sandboxes](/docs/guide/sandboxes/).

## Finite work is a conversation too

Flue has no separate durable job primitive. Bounded, job-like work — a nightly report, a document review, a CI task — is an agent (usually with an [Action](/docs/guide/actions/) owning the reliability-critical steps) driven through a conversation whose id the caller chooses: a fresh id per occurrence for independent runs, or a stable id for work that should remember its history. The conversation is the run record; read it back with the SDK's `history()` or `observe()`.

Flue does not checkpoint arbitrary TypeScript execution and resume a function from its last completed line. Your application decides whether repeating interrupted work is safe: delivering the message again (a new `dispatch(...)` or a new `flue run` invocation) is a new operation in the conversation, and the durable record shows what the previous attempt completed. Use application-owned idempotency keys around external effects whose earlier outcome may be unknown. If a job requires resumable checkpointed steps, use a durable orchestration system suited to that requirement.

See [Observability](/docs/guide/observability/) for runtime telemetry.
