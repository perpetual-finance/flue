---
title: Routing
description: Mount agents, channels, and custom routes explicitly in app.ts.
lastReviewedAt: 2026-07-02
---

`src/app.ts` is your application's route map — and the only file a Flue project requires. It default-exports an ordinary [Hono](https://hono.dev/) application, and every URL your application serves is mounted there explicitly. Flue does not generate routes from filenames or directory conventions: if a route exists, `app.ts` put it there.

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

The same `app.ts` works on both targets. On Node the [Vite plugin](/docs/guide/vite-plugin/) serves it during `vite dev` and builds it into `dist/server.mjs`; on Cloudflare it becomes the Worker's `fetch` handler.

URL shapes are yours. `/agents/triage` is a convention, not a requirement — mount an agent at `/api/assistants/triage`, at `/support`, or anywhere else. Clients address whatever URL you choose; see [SDK](/docs/sdk/overview/).

## Mount an agent

`agent.route()` returns a mountable Hono sub-app for one agent module. Relative to wherever you mount it, the sub-app serves:

| Route                                | Behavior                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `POST /:id`                          | Deliver one message to the conversation (`202` admission).                    |
| `GET` / `HEAD` `/:id`                | Read the conversation: durable event stream, or `?view=history` snapshot.     |
| `POST /:id/abort`                    | Abort in-flight and queued work for the conversation.                         |
| `GET /:id/attachments/:attachmentId` | Attachment byte download — exists only when the module exports `attachments`. |

`:id` is the caller-chosen conversation id. A conversation URL is therefore the mount path plus an id: mounting `triage.route()` at `/agents/triage` makes `/agents/triage/ticket-8472` one continuing conversation.

`.route()` is a **pure router factory**. It has no side effects, so calling it twice, mounting the same agent at two URLs, or never calling it at all are all fine. Both mounts of one agent share the same identity and the same conversations.

### Registration comes from the scan, not the mount

Mounting is not what makes an agent exist. The [`'use agent'` directive](/docs/guide/use-agent/) does: the build scans your source for marked modules, and that scanned set is the application's agent registry on both targets. `.route()` only builds an HTTP surface over an already-registered agent.

Two consequences:

- **An unmarked agent cannot be mounted.** Calling `.route()` on a definition whose module lacks the directive fails with an error telling you to add `'use agent'`.
- **A dispatch-only agent needs no mount at all.** An agent that only receives input through [`dispatch(...)`](/docs/guide/building-agents/#dispatch) is registered by the scan and simply never appears in `app.ts`. It has no HTTP surface, but its conversations are as durable as any other agent's.

## Per-agent middleware: the `route` export

An agent module configures its own routes through optional named exports. The build transform carries them onto the definition, so `triage.route()` in `app.ts` is fully configured by the agent file alone:

```ts title="src/agents/triage.ts"
'use agent';
import { defineAgent, type AgentRouteHandler } from '@flue/runtime';
import { authenticate } from '../auth.ts';

// Middleware applied to every route `.route()` serves for this agent.
export const route: AgentRouteHandler = async (c, next) => {
  const principal = await authenticate(c.req.header('authorization'));
  if (!principal) return c.json({ error: 'Unauthorized' }, 401);
  if (!principal.ticketIds.includes(c.req.param('id'))) return c.notFound();
  await next();
};

export default defineAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  instructions: `Help with support ticket ${id}.`,
}));
```

| Named export  | Meaning                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `route`       | Hono middleware applied to the prompt, stream, and abort routes. Call `next()` to allow; return a response to deny.                  |
| `attachments` | Opts the attachment-download endpoint in, and is the middleware that protects it. Without this export, attachment URLs return `404`. |
| `description` | Optional static human-facing description of the agent.                                                                               |

A naming adjacency to keep straight: the **`route` named export** is middleware _inside_ the agent module, while the **`.route()` method** is the mount factory called _from `app.ts`_. The export configures what the method serves.

Middleware that isn't specific to one agent composes as plain Hono, ordered before the mount:

```ts title="src/app.ts"
app.use('/agents/*', requireUser);
app.route('/agents/triage', triage.route());
```

## Mount a directory of agents

Per-route mounting keeps the route map explicit, but nothing stops you from generating it. Vite's `import.meta.glob` recovers directory-style mounting in userland — one agent per file under `src/agents/`, mounted by basename:

```ts title="src/app.ts"
import type { AgentDefinition } from '@flue/runtime';
import { Hono } from 'hono';

const app = new Hono();

const agents = import.meta.glob<AgentDefinition>('./agents/*.ts', {
  import: 'default',
  eager: true,
});
for (const [path, agent] of Object.entries(agents)) {
  const name = path.split('/').at(-1)!.replace(/\.ts$/, '');
  app.route(`/agents/${name}`, agent.route());
}

export default app;
```

This is exactly as capable as hand-written mounts because it _is_ hand-written mounting — the glob only enumerates the files. Skip the glob (or filter it) for agents that should stay dispatch-only.

## Mount a channel

Channel objects expose the same `.route()` factory. It serves the provider's declared routes relative to the mount point:

```ts title="src/app.ts"
import { channel as slack } from './channels/slack.ts';

app.route('/channels/slack', slack.route());
// Slack's Events API endpoint is now POST /channels/slack/events
```

The channel package declares its route suffixes (`/events`, `/webhook`, `/interactions`, …); the mount point is yours. See [Channels](/docs/guide/channels/).

## Custom routes and dispatch

Anything else your service needs is an ordinary Hono route. A common pattern accepts an external event, verifies it in application code, and delivers it to an agent without exposing a prompt route for that event source:

```ts title="src/app.ts"
import { dispatch } from '@flue/runtime';
import { Hono } from 'hono';
import supportAssistant from './agents/support-assistant.ts';
import { parseVerifiedSupportComment } from './support-webhooks.ts';

const app = new Hono();

app.post('/webhooks/support-comments', async (c) => {
  const event = await parseVerifiedSupportComment(c.req.raw);
  const receipt = await dispatch(supportAssistant, {
    id: event.ticketId,
    message: {
      kind: 'signal',
      type: 'support.comment.created',
      body: event.text,
      attributes: { commentId: event.commentId },
    },
  });

  return c.json(receipt, 202);
});

export default app;
```

The webhook route belongs to your application: it decides which requests are valid and which agent conversation receives the accepted message. `dispatch(...)` resolves the agent by its imported definition — no mount required.

## Prefixes and larger applications

Because `app.ts` owns every path, prefixing Flue routes is just choosing mount paths:

```ts title="src/app.ts"
app.route('/api/agents/triage', triage.route());
app.route('/api/channels/slack', slack.route());
app.get('/health', (c) => c.json({ ok: true }));
```

Clients are unaffected by how you arrange this — an SDK or React client addresses one full conversation URL (`https://example.com/api/agents/triage/123`), so the mount layout never leaks into framework configuration. See [SDK](/docs/sdk/overview/) and [React](/docs/guide/react/).

## Authorize the conversation, not just the caller

Use broad middleware for requirements shared by a group of routes, such as requiring an authenticated user. When access depends on the selected resource, check that too: an agent's `route` middleware should verify that the caller may access the conversation named by `:id`, as in the triage example above. A conversation id is an identifier, not a credential.

## Next steps

- [Vite plugin](/docs/guide/vite-plugin/) — how `app.ts` is served, built, and deployed.
- [`'use agent'`](/docs/guide/use-agent/) — how agents join the application and get their identity.
- [Agents](/docs/guide/building-agents/) — define agent behavior and deliver direct or dispatched input.
- [Channels](/docs/guide/channels/) — verified provider ingress mounted into the route map.
- [SDK](/docs/sdk/overview/) — address a mounted conversation from clients.
