---
title: Events Reference
description: Reference runtime activity, attached-agent event types, and global observation APIs.
lastReviewedAt: 2026-07-02
---

Observable runtime types and global observation APIs are exported from `@flue/runtime`.

```ts
import {
  type AttachedAgentEvent,
  type FlueEvent,
  type FlueEventContext,
  type FlueObservation,
  observe,
  type FlueObservationSubscriber,
} from '@flue/runtime';
```

## Runtime events

`FlueEvent` is the observable runtime activity union. Direct prompts and asynchronously dispatched agent inputs emit agent activity with `instanceId`; dispatched activity may also carry `dispatchId`.

Every delivered event carries the durable event-format version `v: 3`, a per-context `eventIndex`, and a `timestamp`. Runtime and SDK readers reject every non-v3 event with upgrade guidance rather than applying compatibility fallbacks. Applicable events may also carry harness and session names, generated operation and turn ids, submission and conversation correlation, task correlation, and parent-session correlation. Conversation-attached events are durably recorded in the canonical conversation stream; `turn_request` is delivered to in-process subscribers only (see below).

Runtime events can contain provider or transport payloads, prompts, system instructions, reasoning-bearing messages, logs, tool results, and terminal errors. Live observations additionally contain normalized tool arguments and telemetry detail. Apply an exporter-local sanitization policy before forwarding either surface to an external service.

Recognized image content blocks in framework event payloads never carry raw image bytes. They keep their `mimeType` but have `data` replaced with the sentinel string `'[image data omitted from event]'`, exported as the `IMAGE_DATA_OMITTED` constant from both `@flue/runtime` and `@flue/sdk`. Canonical conversation records retain attachment references, while the private attachment store retains verified bytes for model context.

### Lifecycle events

| Event                | Meaning                                                                                                                                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_start`        | Agent loop started.                                                                                                                                                                                                                                                          |
| `agent_end`          | Agent loop ended.                                                                                                                                                                                                                                                            |
| `idle`               | Agent activity became idle.                                                                                                                                                                                                                                                  |
| `submission_settled` | Recovery settled an interrupted durable agent submission. Includes the submission id, a `completed`, `failed`, or `aborted` outcome, and the terminal error message for non-completed outcomes. Emitted only by recovery — normally processed submissions settle without it. |

### Agent operations

| Event             | Meaning                                                                           |
| ----------------- | --------------------------------------------------------------------------------- |
| `operation_start` | A `prompt`, `skill`, `task`, `shell`, or `compact` operation started.             |
| `operation`       | An operation ended. Includes duration, error state, and optional result or usage. |
| `task_start`      | Delegated task started.                                                           |
| `task`            | Delegated task ended.                                                             |

Operations, turns, task ids, and tool-call ids are generated correlation boundaries. Harnesses and sessions have names. Harness-level shell activity emits tool telemetry without a session operation boundary.

### Model turns

| Event                                              | Meaning                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn_start`                                       | Model turn started.                                                                                                                                                                                                                                                          |
| `turn_request`                                     | Model-visible request. Its required `request` contains provider identity, requested model, API and request settings, plus the full `input`. **In-process only**: delivered to `observe()` subscribers and exporters, never persisted to durable streams or served over HTTP. |
| `turn`                                             | Model turn ended. Keeps `turnId`, `purpose`, `durationMs`, and `isError` at top level; required `request` summarizes the request and required `response` contains output, usage, finish reason, and normalized error data.                                                   |
| `turn_messages`                                    | Detailed turn payload. Includes the raw assistant message and tool-result messages.                                                                                                                                                                                          |
| `message_start`, `message_end`                     | General message boundaries for user and assistant messages. For completed assistant messages, `message_end` contains the authoritative message.                                                                                                                              |
| `text_delta`                                       | Best-effort live text progress.                                                                                                                                                                                                                                              |
| `thinking_start`, `thinking_delta`, `thinking_end` | Best-effort live thinking progress.                                                                                                                                                                                                                                          |

Streaming deltas are live progress signals, not authoritative message state. A reader that attaches after generation starts may miss earlier partial output until the assistant `message_end` supplies the complete message. Thinking events include `contentIndex`, the zero-based index of the thinking block in the assistant message; correlate thinking events within a turn by `contentIndex`. Historical persisted events may omit this field. Internal interrupted-turn recovery uses separate durable state and is unaffected by the public event contract.

`turn_request` and `turn` use purpose `agent`, `compaction`, or `compaction_prefix`. `request.providerId` is the Flue provider-registration key; `request.providerName` is the semantic provider name used by observability projections and may differ when a gateway or custom registration is involved. Count model activity from either the normalized `turn` events or the detailed `turn_messages`/`message_*` family, not both.

### Tool calls

| Event        | Meaning                                                           |
| ------------ | ----------------------------------------------------------------- |
| `tool_start` | Tool execution started. Includes tool name and call id.           |
| `tool`       | Tool execution ended. Includes duration, error state, and result. |

Both model-driven and programmatic (`shell()`) tool activity emit `tool_start` and `tool`. Use `toolCallId` to correlate related events. Live `FlueObservation` values additionally carry applicable origin, semantic type, description, effective arguments/result, and normalized error detail; these exporter-oriented fields are not persisted or replayed.

### Compaction

| Event              | Meaning                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `compaction_start` | Conversation compaction started. Includes `threshold`, `overflow`, or `manual` reason.             |
| `compaction`       | Conversation compaction ended. Includes message counts, duration, error state, and optional usage. |

### Application events

| Event | Meaning                                                                                   |
| ----- | ----------------------------------------------------------------------------------------- |
| `log` | Structured application log with `info`, `warn`, or `error` level and optional attributes. |

### Stable contract vs. provider-shaped fields

Event type names, the envelope fields (`v`, `eventIndex`, `timestamp`, identity and correlation fields), and the normalized payloads — `turn_request`/`turn` (the `Llm*` mirror types), `tool_start`/`tool`, `task`, `operation`, `compaction`, `log`, `submission_settled`, `text_delta`, and `thinking_*` — are the stable event contract.

The detailed message payloads are **not yet stable**: `message` on `message_start`/`message_end`, `message` and `toolResults` on `turn_messages`, and `messages` on `agent_end` mirror the message shape of the underlying agent library (pi-agent-core's `AgentMessage`) and may change shape before 1.0, when they will be replaced with a Flue-owned message type. Readers of persisted streams can branch on the envelope's `v` field when the format changes.

#### `FlueEvent`

```ts
type FlueEvent = RuntimeEventVariant & {
  v: 3;
  eventIndex: number;
  timestamp: string;
  instanceId?: string;
  dispatchId?: string;
  submissionId?: string;
  agentName?: string;
  conversationId?: string;
  session?: string;
  parentSession?: string;
  taskId?: string;
  harness?: string;
  operationId?: string;
  turnId?: string;
};
```

## Attached agent events

Attached-agent events represent direct-agent activity and require `instanceId`.

#### `AttachedAgentEvent`

```ts
type AttachedAgentEvent = FlueEvent & {
  instanceId: string;
};
```

## Global observation

### `observe(...)`

```ts
function observe(subscriber: FlueObservationSubscriber): () => void;
```

Subscribes to live agent-interaction activity emitted in the current isolate. The returned function unsubscribes the listener. Subscribers run synchronously from the event emission path and receive one detached, frozen `FlueObservation`: the product event plus applicable live-only detail, using the same `v` field. Branch on `observation.type` and return immediately for activity the subscriber does not consume. Keep callbacks lightweight and queue substantial asynchronous work instead of blocking emission. Returned promises are observed for rejection but are not awaited.

`observe()` receives every emitted event, including `turn_request` — the full model-visible request is available to in-process observability without being persisted to the primary database.

See [Observability](/docs/guide/observability/) for application setup and exporter guidance.

#### `FlueObservationSubscriber`

```ts
type FlueObservationSubscriber = (
  observation: FlueObservation,
  ctx: FlueEventContext,
) => void | Promise<void>;
```

Receives a detached immutable observation and its originating context. Subscriber failures are logged and do not halt event dispatch or the originating execution.

## Public errors

Transport errors use the shared `FluePublicError` shape. See [Errors Reference](/docs/api/errors-reference/) for its fields, stable categories, and transport envelopes.
