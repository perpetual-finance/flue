---
title: createFlueClient(...)
description: Create a client for one agent conversation of a deployed Flue application.
lastReviewedAt: 2026-07-02
---

```ts
import { createFlueClient } from '@flue/sdk';

const conversation = createFlueClient({
  url: 'https://example.com/agents/triage/123456',
  token: process.env.FLUE_TOKEN,
});
```

A client addresses exactly one agent conversation by URL: wherever the application mounts the agent's `.route()` (its `app.ts` route map decides that) plus the caller-chosen conversation id. Starting a new conversation is constructing a client with a fresh id appended to the mount URL — ids are caller-chosen, and the conversation is created on the first admitted message.

In a browser, `url` may be relative to `location.origin`. This is the usual same-origin setup:

```ts
const conversation = createFlueClient({ url: '/api/agents/triage/123456' });
```

Outside a browser, `url` must be absolute; a relative value throws an error.

## `createFlueClient(...)`

```ts
function createFlueClient(options: CreateFlueClientOptions): FlueClient;
```

Creates a client for one agent conversation of a deployed Flue application.

## `CreateFlueClientOptions`

| Field     | Type             | Default        | Description                                                                                                                                                                                                                            |
| --------- | ---------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`     | `string`         | —              | URL of one agent conversation: the agent's mount URL plus the conversation id. Browser clients may use a relative URL.                                                                                                                 |
| `fetch`   | `typeof fetch`   | global `fetch` | Custom HTTP implementation. Also used for Durable Streams event streaming. Point it at a [Cloudflare service binding](/docs/guide/targets/cloudflare/#calling-a-private-agent-over-a-service-binding) to reach a private agent Worker. |
| `headers` | `RequestHeaders` | —              | Headers merged into each HTTP and stream request.                                                                                                                                                                                      |
| `token`   | `string`         | —              | Bearer token added to HTTP and stream requests.                                                                                                                                                                                        |

### `RequestHeaders`

```ts
type RequestHeaders =
  | Record<string, string>
  | (() => Record<string, string> | Promise<Record<string, string>>);
```

Use a function to resolve headers separately for each HTTP request and stream reconnection — for example, to refresh a token.

## `FlueClient`

```ts
interface FlueClient {
  readonly url: string;
  send(options: AgentPromptOptions): Promise<AgentSendResult>;
  wait(admission: AgentSendResult, options?: AgentWaitOptions): Promise<void>;
  abort(options?: { signal?: AbortSignal }): Promise<AgentAbortResult>;
  history(options?: FlueConversationHistoryOptions): Promise<FlueConversationSnapshot>;
  observe(options?: AgentConversationObserveOptions): AgentConversationObservation;
  attachmentUrl(attachmentId: string): string;
}
```

`url` is the fully resolved conversation URL the client addresses.

## `conversation.send(...)`

```ts
send(options: AgentPromptOptions): Promise<AgentSendResult>;
```

Delivers one message into the conversation and resolves as soon as the submission is durably admitted — it does **not** wait for the agent to respond. This uses `POST <url>`, which returns `202`.

Sends are fire-and-forget: a message is delivered into the living conversation and has no single terminal "result" value to return. To await completion, pass the result to `wait()`; to read the agent's reply, observe the conversation with `observe()` or read `history()`.

### `AgentPromptOptions`

| Field     | Type               | Description                                     |
| --------- | ------------------ | ----------------------------------------------- |
| `message` | `DeliveredMessage` | The message delivered into the agent's session. |
| `signal`  | `AbortSignal`      | Cancel the in-flight HTTP request.              |

### `DeliveredMessage`

```ts
type DeliveredMessage =
  | { kind: 'user'; body: string; attachments?: DeliveredAttachment[] }
  | {
      kind: 'signal';
      type: string;
      body: string;
      attributes?: Record<string, string>;
      tagName?: string;
    };

interface DeliveredAttachment {
  type: 'image';
  data: string;
  mimeType: string;
  filename?: string;
}
```

This is the same unified shape a server-side `dispatch()` call admits. A `kind: 'user'` message is a direct chat turn — `attachments` carry base64-encoded images (`data`, capped at 14 MiB of base64 characters each; `mimeType` such as `image/png`) for vision-capable models. A `kind: 'signal'` message is a structured event; see the [agent API reference](/docs/api/agent-api/#deliveredmessage) for when to use each kind.

### `AgentSendResult`

```ts
interface AgentSendResult {
  streamUrl: string;
  offset: string;
  submissionId: string;
}
```

`submissionId` identifies the durable submission; `streamUrl` and `offset` are the coordinates for observing its conversation. All fields are server-provided.

## `conversation.wait(...)`

```ts
wait(admission: AgentSendResult, options?: AgentWaitOptions): Promise<void>;
```

Awaits completion of a submission returned by `send()`. Resolves once the submission settles completed, and rejects with `FlueExecutionError` when it settles failed or aborted. It does not return the assistant's reply — read that from the conversation via `observe()` or `history()`.

`wait()` follows the durable conversation stream from the admission's `offset`, so it survives reconnects. If the process that called `wait()` disappears, the submission still settles in the background; re-observe the conversation to recover the outcome.

### `AgentWaitOptions`

| Field            | Type                                       | Description                                                                                                            |
| ---------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `signal`         | `AbortSignal`                              | Stop waiting locally. This does not abort the submission — use `abort()` for that.                                     |
| `onEvent`        | `(chunk: ConversationStreamChunk) => void` | Called for each conversation update while waiting, for progress rendering. Prefer `observe()` for maintained UI state. |
| `backoffOptions` | `BackoffOptions`                           | Reconnect backoff tuning for the underlying stream.                                                                    |

## `conversation.abort(...)`

```ts
abort(options?: { signal?: AbortSignal }): Promise<AgentAbortResult>;
```

Aborts all in-flight and queued durable work for the conversation — the submission it is currently running and anything queued behind it. This uses `POST <url>/abort`.

Abort records a durable intent and returns once it is recorded; settlement happens asynchronously. The aborted work settles to a distinct **aborted** terminal outcome rather than a failure: an aborted settlement is written to the conversation (visible via `observe()`/`history()`), and a pending `wait()` rejects with `FlueExecutionError` carrying `failure: 'aborted'`. Work that has already completed is not affected — an abort that loses the race to a finished response settles as completed.

### `AgentAbortResult`

```ts
interface AgentAbortResult {
  aborted: boolean;
}
```

`aborted` is `true` when there was in-flight or queued work that is now being aborted, and `false` when the conversation was idle.

## `conversation.observe(...)`

```ts
observe(options?: AgentConversationObserveOptions): AgentConversationObservation;
```

Observes the materialized conversation across initial history catch-up, live updates, reconnects, and canonical resets. This is the default API for applications that retain conversation state.

```ts
const observation = conversation.observe({ live: 'sse' });

let retry = 0;
const unsubscribe = observation.subscribe(() => {
  const snapshot = observation.getSnapshot();

  // A conversation that does not exist yet reports `phase: 'absent'` and stops.
  // When and how to re-check is up to you; refresh() re-runs history catch-up.
  if (snapshot.phase === 'absent') {
    setTimeout(() => observation.refresh(), Math.min(1000 * 2 ** retry++, 30_000));
    return;
  }

  retry = 0;
  render(snapshot.conversation?.messages ?? []);
});
```

`getSnapshot()` returns the materialized `FlueConversationState`, its safe resume offset, the current phase (`loading`, `connecting`, `live`, `absent`, `error`, or `closed`), and any transport error. A conversation that has not been created yet reports `phase: 'absent'`; call `refresh()` to re-run history catch-up and resume live updates — the example above retries with a simple backoff — and `close()` when observation is no longer needed.

### `AgentConversationObserveOptions`

| Field            | Type                   | Default       | Description                                                                                   |
| ---------------- | ---------------------- | ------------- | --------------------------------------------------------------------------------------------- |
| `live`           | `'long-poll' \| 'sse'` | `'long-poll'` | Live update mode. `'sse'` holds a long-lived stream for lower-latency token-by-token updates. |
| `signal`         | `AbortSignal`          | —             | Close the observation when aborted.                                                           |
| `backoffOptions` | `BackoffOptions`       | —             | Reconnect backoff tuning for the underlying stream.                                           |

Both live modes are safe under at-least-once redelivery: every chunk carries a monotonic position and `observe()` drops chunks at or below the last applied one, so a reconnect replay never double-applies streamed deltas.

### Materialized conversation state

The observed conversation is a `FlueConversationState` of `FlueConversationMessage` values. Each message carries a `role` (`user`, `assistant`, `system`), a semantic `purpose` (`user`, `assistant`, `dispatch`, `advisory`), a `display` hint (`visible`, `diagnostic`, `hidden`), optional `submissionId`/`turnId` correlation, and clean, render-ready parts (`text`, `reasoning`, `dynamic-tool`, `file`). Streaming assembly is handled internally, so a `text` part is always `{ type, text, state }`. Structured tool output appears on the `dynamic-tool` part's `output`. The state's `settlements` array records each submission's terminal outcome.

## `conversation.history(...)`

```ts
history(options?: FlueConversationHistoryOptions): Promise<FlueConversationSnapshot>;
```

Returns one materialized conversation snapshot. The snapshot includes its opaque stream `offset`; historical token deltas are already reduced into complete message parts. Use `observe()` for live state — it performs the snapshot-to-live handoff and reduction for you. The snapshot is materialized by the API on demand and is not a persisted replay cache. A conversation that does not exist yet rejects with a `404` `FlueApiError`.

## `conversation.attachmentUrl(...)`

```ts
attachmentUrl(attachmentId: string): string;
```

Returns the absolute URL for one `file` part's attachment bytes (`<url>/attachments/<attachmentId>`), suitable as an `<img>`/`<a>` source. The download endpoint is opt-in per agent — the agent module must export `attachments` middleware; without it the URL returns `404`.

You rarely need to call this: for durably recorded attachments, `history()` and `observe()` fill each `file` part's `url` field with this value already.
