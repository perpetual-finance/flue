---
title: Streaming Protocol
description: Reference for reading Flue agent conversations over Durable Streams.
lastReviewedAt: 2026-07-02
---

Flue serves each agent conversation as a Durable Streams read at the conversation's own URL — the agent's mount plus the conversation id. SDK users should use the client's `observe()` for a materialized live conversation, or `history()` for a one-shot snapshot. The HTTP `history` and `updates` views described here are the underlying wire protocol that `observe()` consumes.

## Stream routes

Relative to wherever `app.ts` mounts the agent's router (`createAgentRouter(...)`):

| Route                              | Purpose                                      |
| ---------------------------------- | -------------------------------------------- |
| `GET /:id?view=history`            | Read one materialized conversation snapshot. |
| `GET /:id?view=updates&offset=...` | Read conversation updates after an offset.   |
| `HEAD /:id`                        | Read conversation stream metadata.           |

A plain `GET` defaults to the history view. Any other `view` value is rejected with `400 invalid_request`.

## History and updates

History returns one JSON `FlueConversationSnapshot` after reducing the complete physical stream prefix. Its `offset` is the physical conversation tail, including records omitted from the projection. History reads accept no `offset`, `tail`, or `live` parameters.

The `updates` view emits the strict UI projection protocol (`ConversationStreamChunk`): UI-only operations such as message/part lifecycle, streaming deltas, tool input and structured output, settlement, and a full-snapshot reset. The private canonical record schema is never exposed on the wire.

Updates require exactly one `offset` and resume strictly after it. Use `live=long-poll` for one waitable read or `live=sse` for a continuous stream. Do not resume without retaining the projection state produced by the matching history snapshot; request fresh history when local state is unavailable.

The server reconstructs the canonical prefix through the supplied offset when an updates connection starts. The history response is an API-materialized projection, not a persisted conversation snapshot or replay cache, so reconnect cost grows with the physical conversation stream. Applications with very large streams should measure reconnect latency and avoid unnecessary reconnect loops.

Conversation reads do not support `tail`. A suffix can omit message starts, branches, compaction state, or earlier deltas and cannot be reduced safely.

## Offsets

Offsets are opaque resume-after tokens. Pass returned values back unchanged; do not parse or increment them. `-1` reads from the beginning.

One offset identifies one atomic canonical record batch. SDK stream checkpoints advance only after every public update derived from that batch has been delivered. A filtered batch may advance the offset without producing an update. Every updates chunk additionally carries a monotonic `position` that consumers use to drop redelivered chunks — at-least-once transports replay the in-flight batch on reconnect.

## Admission coordinates

`POST /:id` (the prompt route) returns `202` with the stream coordinates for observing exactly that submission's effects:

```json
{ "streamUrl": "https://host/agents/triage/ticket-42", "offset": "...", "submissionId": "..." }
```

The same values are mirrored as `Location` and `Stream-Next-Offset` response headers, matching the Durable Streams stream-creation convention. Reading `streamUrl` with `view=updates` from `offset` yields the admitted message's updates.

## Response headers

| Header               | Meaning                                        |
| -------------------- | ---------------------------------------------- |
| `Stream-Next-Offset` | Offset to use for the next read.               |
| `Stream-Up-To-Date`  | `true` when the read reached the current tail. |
| `Stream-Cursor`      | Cursor for long-poll continuation.             |

Canonical conversation streams remain open and do not emit `Stream-Closed`. Catch-up responses use `Cache-Control: no-store`; SSE uses `Cache-Control: no-cache`.

## SSE framing

SSE responses contain:

- `event: data` frames with a JSON array of conversation chunks;
- `event: control` frames with `streamNextOffset` and optional `upToDate`;
- heartbeat comments on idle connections.

Track `streamNextOffset` from control frames to resume after a disconnect.
