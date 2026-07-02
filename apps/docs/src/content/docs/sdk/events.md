---
title: Events and records
description: SDK event and normalized model-turn types.
lastReviewedAt: 2026-07-02
---

## `FlueEvent`

`FlueEvent` is the observable runtime activity union: agent lifecycle, model turn, message, tool, task, compaction, operation, log, idle, and settlement (`submission_settled`) events.

The conversation wire — `observe()`, `history()`, and `wait()` — does not carry this union; it carries the materialized-conversation protocol (`ConversationStreamChunk`), which `observe()` reduces into `FlueConversationState`. `FlueEvent` is exported for first-party presenters that consume runtime activity delivered outside HTTP (for example, the `flue run` CLI presenter), and it mirrors the runtime's event union exactly.

Every delivered event carries the durable event-format version `v: 3`, a per-context `eventIndex`, and a `timestamp`. SDK readers reject v1, v2, missing, and unknown versions with `UnsupportedFlueEventVersionError`; they do not normalize historical formats. Applicable events also carry identity and correlation fields — `instanceId`, `conversationId`, `submissionId`, `agentName`, `dispatchId`, `session`, `parentSession`, `taskId`, `harness`, `operationId`, `turnId`.

`message_start` and `message_end` bound both user and assistant messages. Text and thinking deltas are best-effort live progress; for a completed assistant message, `message_end` is authoritative. A reader that attaches after generation starts may miss earlier partial output until it arrives. Internal interrupted-turn recovery uses separate durable state and is unaffected by this public event behavior.

## `AttachedAgentEvent`

`AttachedAgentEvent` is a `FlueEvent` emitted by direct interactions with an agent instance. It requires `instanceId`.

## `ConversationStreamChunk`

The conversation `updates` wire union. It is not stable application API — application code should consume materialized `FlueConversationState` via `observe()` rather than handling chunks — but first-party presenters reduce it directly, so the type is exported. `wait()`'s `onEvent` callback also receives it for progress rendering.

## Normalized model-turn types

`turn` events keep correlation, duration, purpose, and error status at top level. Their required `request` is a `ModelRequestInfo` summary; their required `response` is a `ModelResponse`. Output, usage, finish reason, and normalized errors exist only under `response`.

| Type                  | Description                                                              |
| --------------------- | ------------------------------------------------------------------------ |
| `ModelRequestInput`   | Model-visible system prompt, messages, and tools.                        |
| `ModelRequestInfo`    | Provider identity, requested model, API, and request settings.           |
| `ModelRequest`        | `ModelRequestInfo` plus the full request `input`.                        |
| `ModelResponse`       | Response identity, output, usage, finish reason, and normalized error.   |
| `LlmAssistantMessage` | Normalized assistant message.                                            |
| `LlmTextContent`      | Text content.                                                            |
| `LlmThinkingContent`  | Reasoning content.                                                       |
| `LlmToolCall`         | Tool call content.                                                       |
| `LlmTurnPurpose`      | Model-turn purpose: `'agent'`, `'compaction'`, or `'compaction_prefix'`. |

`request.providerId` is the provider-registration key used in model specifiers. `request.providerName` is the semantic provider identity and may differ for gateways or custom registrations.

See the [Events Reference](/docs/api/events-reference/) for the full per-event vocabulary.
