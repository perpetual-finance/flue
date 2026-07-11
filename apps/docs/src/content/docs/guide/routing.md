---
title: Routing
description: Mount agents, channels, and custom routes explicitly in app.ts.
lastReviewedAt: 2026-07-11
---

`src/app.ts` is your application's route map — and the only file a Flue project requires. It default-exports an ordinary [Hono](https://hono.dev/) application, and every URL your application serves is mounted there explicitly. Flue does not generate routes from filenames or directory conventions: if a route exists, `app.ts` put it there.

```ts title="src/app.ts"
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Triage } from './agents/triage.ts';
import { channel as slack } from './channels/slack.ts';

const app = new Hono();

app.route('/agents/triage', createAgentRouter(Triage));
app.route('/channels/slack', slack.route());
app.get('/api/ping', (c) => c.text('pong'));

export default app;
```

The same `app.ts` works on both targets. On Node the [Vite plugin](/docs/guide/vite-plugin/) serves it during `vite dev` and builds it into `dist/server.mjs`; on Cloudflare it becomes the Worker's `fetch` handler.

URL shapes are yours. `/agents/triage` is a convention, not a requirement — mount an agent at `/api/assistants/triage`, at `/support`, or anywhere else. Clients address whatever URL you choose; see [SDK](/docs/sdk/overview/).

## Mount an agent

`createAgentRouter(agent, options?)` — from `@flue/runtime/routing` — returns a mountable Hono sub-app for one agent function. Relative to wherever you mount it, the sub-app serves:

| Route                                | Behavior                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `POST /:id`                          | Deliver one message to the conversation (`202` admission).                    |
| `GET` / `HEAD` `/:id`                | Read the conversation: durable event stream, or `?view=history` snapshot.     |
| `POST /:id/abort`                    | Abort in-flight and queued work for the conversation.                         |
| `GET /:id/attachments/:attachmentId` | Attachment byte download.                                                     |

`:id` is the caller-chosen conversation id. A conversation URL is therefore the mount path plus an id: mounting `createAgentRouter(Triage)` at `/agents/triage` makes `/agents/triage/ticket-8472` one continuing conversation.

`createAgentRouter()` is a **pure router factory**. It has no registration side effects, so calling it twice, mounting the same agent at two URLs, or never calling it at all are all fine. Both mounts of one agent share the same identity and the same conversations. The returned Hono app has `.fetch`, so it also mounts in any fetch-based server framework.

Mounting is the **exposure decision**: an agent has an HTTP surface exactly where — and only where — `app.ts` gives it one.

### Registration comes from the scan, not the mount

Mounting is not what makes an agent exist. The [`'use agent'` directive](/docs/guide/use-agent/) does: the build scans your source for marked modules, and each exported capitalized function in them is a registered agent. That scanned set is the application's agent registry on both targets. `createAgentRouter()` only builds an HTTP surface over an already-registered agent.

Two consequences:

- **An unregistered function cannot serve requests.** The router resolves the agent's identity from the function; requests to a mount for a function the scan never registered fail rather than invent an agent.
- **A dispatch-only agent needs no mount at all.** An agent that only receives input through [`dispatch(...)`](/docs/guide/building-agents/#dispatch) is registered by the scan and simply never appears in `app.ts`. It has no HTTP surface, but its conversations are as durable as any other agent's.

### Durability: the binding decides

Submission retry policy is not part of the agent — it belongs to whoever runs the agent. The router is one of those binding sites:

```ts title="src/app.ts"
app.route(
  '/agents/triage',
  createAgentRouter(IssueTriage, {
    durability: { maxAttempts: 5, timeoutMs: 7_200_000 },
  }),
);
```

`durability` (`maxAttempts`, `timeoutMs`) is recorded for the agent's identity when the router is created. The other binding sites — [`start()` entries](/docs/guide/scripts/#standalone-scripts-start) and [`flue run` flags](/docs/cli/run/) — carry the same policy for the same reason: it must be readable even when a render crashes, so it lives entirely outside the function. An agent author who wants to *suggest* a policy exports a plain object and the binding spreads it — no framework blessing involved. One policy per identity per process; mounting one agent twice with different policies is a configuration smell — give both mounts the same value.

## Middleware is plain Hono

There is no per-agent middleware export. Auth and other middleware compose in the host app, ordered before the mount:

```ts title="src/app.ts"
import { createAgentRouter } from '@flue/runtime/routing';
import { authenticate } from './auth.ts';

app.use('/agents/triage/*', async (c, next) => {
  const principal = await authenticate(c.req.header('authorization'));
  if (!principal) return c.json({ error: 'Unauthorized' }, 401);
  const id = c.req.path.split('/')[3]; // the conversation id segment under the mount
  if (!id || !principal.ticketIds.includes(id)) return c.notFound();
  await next();
});
app.route('/agents/triage', createAgentRouter(Triage));
```

Everything Hono gives you applies: shared middleware over a prefix (`app.use('/agents/*', requireUser)`), per-mount guards like the one above, rate limits, logging. The middleware wraps every route the sub-app serves, attachment downloads included, because it runs before the mount matches.

## Mount a directory of agents

Per-route mounting keeps the route map explicit, but nothing stops you from generating it. Vite's `import.meta.glob` recovers directory-style mounting in userland — enumerate the agent modules and mount each exported agent:

```ts title="src/app.ts"
import type { Agent } from '@flue/runtime';
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';

const app = new Hono();

const modules = import.meta.glob<Record<string, Agent>>('./agents/*.ts', { eager: true });
for (const mod of Object.values(modules)) {
  for (const [exportName, agent] of Object.entries(mod)) {
    if (typeof agent !== 'function' || !/^[A-Z]/.test(exportName)) continue; // agents are the capitalized exports
    app.route(`/agents/${agent.agentName ?? exportName}`, createAgentRouter(agent));
  }
}

export default app;
```

This is exactly as capable as hand-written mounts because it _is_ hand-written mounting — the glob only enumerates the modules. Skip the glob (or filter it) for agents that should stay dispatch-only.

## Mount a channel

Channel objects expose their own `.route()` factory — a separate API from the agent router. It serves the provider's declared routes relative to the mount point:

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
import { SupportAssistant } from './agents/support-assistant.ts';
import { parseVerifiedSupportComment } from './support-webhooks.ts';

const app = new Hono();

app.post('/webhooks/support-comments', async (c) => {
  const event = await parseVerifiedSupportComment(c.req.raw);
  const receipt = await dispatch(SupportAssistant, {
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

The webhook route belongs to your application: it decides which requests are valid and which agent conversation receives the accepted message. `dispatch(...)` resolves the agent by the imported function — no mount required.

## Prefixes and larger applications

Because `app.ts` owns every path, prefixing Flue routes is just choosing mount paths:

```ts title="src/app.ts"
app.route('/api/agents/triage', createAgentRouter(Triage));
app.route('/api/channels/slack', slack.route());
app.get('/health', (c) => c.json({ ok: true }));
```

Clients are unaffected by how you arrange this — an SDK or React client addresses one full conversation URL (`https://example.com/api/agents/triage/123`), so the mount layout never leaks into framework configuration. See [SDK](/docs/sdk/overview/) and [React](/docs/guide/react/).

## Authorize the conversation, not just the caller

Use broad middleware for requirements shared by a group of routes, such as requiring an authenticated user. When access depends on the selected resource, check that too: the middleware in front of an agent's mount should verify that the caller may access the conversation named by `:id`, as in the triage example above. A conversation id is an identifier, not a credential.

## Next steps

- [Vite plugin](/docs/guide/vite-plugin/) — how `app.ts` is served, built, and deployed.
- [`'use agent'`](/docs/guide/use-agent/) — how agents join the application and get their identity.
- [Agents](/docs/guide/building-agents/) — define agent behavior and deliver direct or dispatched input.
- [Channels](/docs/guide/channels/) — verified provider ingress mounted into the route map.
- [SDK](/docs/sdk/overview/) — address a mounted conversation from clients.
