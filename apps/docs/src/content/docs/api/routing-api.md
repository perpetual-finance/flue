---
title: Routing API
description: Mount agent and channel routes in the authored app.ts route map.
lastReviewedAt: 2026-07-07
---

`app.ts` is the application's route map — the only required file. Its default export owns the entire request pipeline, and every route the application serves is mounted there explicitly. There is no framework router and no file-based routing: Flue provides mountable per-agent and per-channel sub-apps, and `app.ts` decides their URLs.

```ts title="src/app.ts"
import { Hono } from 'hono';
import triage from './agents/triage.ts';
import { channel as slack } from './channels/slack.ts';

const app = new Hono();

app.route('/agents/triage', triage.route());
app.route('/channels/slack', slack.route());
app.get('/api/ping', (c) => c.text('pong'));

export default app;
```

The same `app.ts` shape works on both Node and Cloudflare targets; the `flue()` Vite plugin adapts internally. See [Routing](/docs/guide/routing/) for middleware composition and application-owned dispatch.

#### `Fetchable`

```ts
import type { Fetchable } from '@flue/runtime/routing';

interface Fetchable {
  fetch(request: Request, env?: unknown, ctx?: unknown): Response | Promise<Response>;
}
```

Structural contract for the default export of `app.ts`. Any object exposing a compatible `fetch()` method satisfies it, including a `new Hono()` instance.

On Cloudflare, `env` contains bindings and `ctx` is the `ExecutionContext`. On Node, `env` contains Hono's Node adapter bindings for the incoming and outgoing messages, and `ctx` is `undefined`.

## Registration comes from the scan, not from mounting

An agent joins the application through the `'use agent'` directive, not through `.route()`. At build time, the `flue()` Vite plugin scans the source root for modules whose first statement is `'use agent'`; that scanned set **is** the application's agent registry, and the generated bootstrap imports and registers every marked module. Consequences:

- `.route()` is a **pure router factory** over an already-registered definition: no side effects, safe to call twice, mountable at two URLs, or never called at all.
- A dispatch-only agent needs no mount — the scan registered it, and `dispatch()` resolves it by definition.
- Mounting an unmarked agent module fails: `.route()` throws with guidance to add the `'use agent'` directive.
- Mounting the same definition twice is allowed: both mounts address the same identity and the same conversations at two URLs.

The agent's durable identity is the module's file basename (`src/agents/triage.ts` → `triage`), injected by the build transform. Identity — not the mount path — keys durable storage: conversation streams on Node and the Durable Object class on Cloudflare. Re-mounting an agent at a different URL preserves its conversations; renaming the file is the storage-identity change. Duplicate basenames among an app's agents are a build error.

## `agent.route()`

```ts
// On AgentDefinition (returned by defineAgent):
route(): Hono;
```

Builds the agent's mountable Hono sub-app. Routes, relative to wherever the caller mounts it:

| Route                                | Purpose                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `POST /:id`                          | Deliver one message into the conversation; returns `202` with stream coordinates.                |
| `GET /:id`                           | Read materialized history (`?view=history`, the default) or projected updates (`?view=updates`). |
| `HEAD /:id`                          | Return canonical conversation-stream metadata.                                                   |
| `POST /:id/abort`                    | Abort the conversation's in-flight and queued durable work; returns `200 { aborted }`.           |
| `GET /:id/attachments/:attachmentId` | Serve one attachment's bytes. Exists only when the module exports `attachments`.                 |

`:id` is the caller-chosen conversation id — the trailing URL segment. An empty id segment is rejected with `400 invalid_request`. Unsupported methods on known paths render the canonical `405 method_not_allowed` envelope with an `Allow` header.

`route()` takes no options: the agent module's named exports are the single source of per-agent route configuration, carried onto the definition by the build transform.

### The module's named exports

```ts title="src/agents/triage.ts"
'use agent';
import { defineAgent, type AgentRouteHandler } from '@flue/runtime';

function Triage() {
  return '...';
}

export default defineAgent(Triage, { model: '...' });

export const route: AgentRouteHandler = async (c, next) => next(); // middleware on all routes
export const attachments: AgentRouteHandler = async (c, next) => next(); // opt-in downloads
export const description = 'Triage incoming bug reports.'; // static metadata
```

| Export        | Applied to                           | Meaning                                                                                                   |
| ------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `route`       | The prompt, stream, and abort routes | Hono middleware. May authenticate and call `await next()`, or short-circuit with its own response.        |
| `attachments` | The attachment-download route        | Opt-in gate for attachment byte downloads. Without this export, the endpoint renders the canonical `404`. |
| `description` | —                                    | Static human-facing metadata for the agent.                                                               |

Naming note: the `route` **named export** is middleware; the `.route()` **method** is the mount factory. They are related but distinct — `.route()` applies the `route` export automatically.

Additional path-level middleware composes as plain Hono:

```ts
app.use('/agents/triage/*', rateLimit);
app.route('/agents/triage', triage.route());
```

### Wire behavior

`POST /:id` accepts a [`DeliveredMessage`](/docs/api/agent-api/#deliveredmessage) as its JSON body — the same unified shape `dispatch()` admits. A chat turn is `{ "kind": "user", "body": string, "attachments"?: attachment[] }` with optional `{ type: 'image', data, mimeType, filename? }` attachments, where `data` is base64-encoded image content (capped at 14 MiB of base64 characters per image) for vision-capable models. A structured event is `{ "kind": "signal", "type": string, "body": string, "attributes"?, "tagName"? }`.

`data` and `uid` are reserved top-level siblings beside the message fields — not part of `DeliveredMessage` itself:

```json
{ "kind": "user", "body": "Triage this.", "data": { "issue": 17307 }, "uid": null }
```

`data` is instance-creation data, consulted only when this send creates the instance (see [Creation data](/docs/guide/building-agents/#creation-data)). `uid` is the send condition — the instance uid played as an ETag: omitted continues-or-creates unconditionally, a string continues only that incarnation, `null` creates only when no instance exists yet; see [Conditional sends](/docs/api/agent-api/#conditional-sends) for the full model. A condition failure is rejected synchronously, before anything is durably admitted: `404 agent_instance_not_found` for a missing instance or a mismatched uid, `409 agent_instance_exists` for a `uid: null` send against an instance that already exists (`details` names the existing uid).

```bash
# Deliver a message. The mount path is whatever app.ts chose;
# the trailing segment is any conversation id you choose.
curl -X POST http://localhost:5173/agents/triage/ticket-42 \
  -H 'Content-Type: application/json' \
  -d '{ "kind": "user", "body": "Summarize the open issues." }'
# → 202 { "streamUrl": "...", "offset": "...", "submissionId": "...", "uid": "inst_01KW..." }
```

Prompts are fire-and-forget: the `202` body carries `{ streamUrl, offset, submissionId, uid? }`, mirrored as `Location` and `Stream-Next-Offset` headers, and the request never blocks on the agent's response. `uid` is the contacted instance's uid — minted on a creating send, echoed on a continuing one, absent for instances created before uids shipped. A message is delivered into the living conversation and has no single terminal "result" value, so `?wait=result` is rejected with `400 invalid_request`; await completion with the SDK client's `wait()`, or read the conversation stream (GET the same URL).

`POST /:id/abort` stops all in-flight and queued durable work for the conversation and returns `200 { aborted }` — `aborted` is `true` when there was unsettled work, `false` when the conversation was idle. Abort records a durable intent and returns before settlement; the aborted work settles to a distinct **aborted** outcome visible in conversation history and on the stream. Work that already completed is unaffected.

For the `GET` stream views, see the [Streaming Protocol](/docs/api/streaming-protocol/).

## `channel.route()`

```ts
// On channel objects created by channel packages (createSlackChannel(), ...):
route(): Hono;
```

Builds a mountable Hono sub-app serving the channel's declared routes relative to the mount point. Like `agent.route()`, it is a pure factory with no registration side effects — mounting is what exposes the channel, and the mount path is yours:

```ts
app.route('/channels/slack', channel.route());
// Slack's `events` handler is now served at POST /channels/slack/events
```

Unknown paths beneath the mount and the bare mount root render the canonical `route_not_found` envelope; a known path with the wrong method renders `method_not_allowed` with an `Allow` header.

### `createChannelRouter(...)` and the channel contract

Channel packages implement `.route()` through a shared runtime helper. A channel is structurally an object exposing a declarative `routes` array:

```ts
import { createChannelRouter, type MountableChannel } from '@flue/runtime';

interface ChannelRouteDefinition {
  readonly method: string; // uppercase, e.g. 'POST'
  readonly path: string; // mount-relative absolute path, e.g. '/events'
  readonly handler: Handler; // Hono handler returning a Response
}

interface MountableChannel {
  readonly routes: readonly ChannelRouteDefinition[];
}

app.route('/channels/custom', createChannelRouter(myChannel.routes));
```

Route declarations are validated eagerly: invalid method/path/handler shapes and duplicate `"METHOD /path"` pairs throw at construction time. Handlers must return a `Response`.

## Removed router surface

The name-addressed `flue()` router (`/agents/:name/:id`), `createDefaultFlueApp()`, `/workflows/:name`, `/runs/:runId`, and the `listAgents()`/`listRuns()`/`getRun()` inspection primitives were removed. Agents are addressed only where `app.ts` mounts them, and workflows no longer exist — an agent with model-callable [harness tools](/docs/api/agent-api/#usetool) covers the deterministic-code role.
