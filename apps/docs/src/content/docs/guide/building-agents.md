---
title: Agents
description: Create an agent, configure its capabilities, and send it messages over time.
lastReviewedAt: 2026-07-07
---

Agents are useful when your application needs a model to keep working within a continuing context. This guide covers creating an agent, composing its capabilities and environment, and exposing it safely to users.

For the underlying mental model, start with [What is an agent?](/docs/concepts/agents/).

## Creating a new agent

In a Flue project, an agent is a module marked with the [`'use agent'` directive](/docs/guide/use-agent/) whose default export is created with `defineAgent(Capability, config)`. The **capability** is a plain function: Flue Hooks in its body attach tools, instructions, and state, and its returned string is the agent's instruction.

```ts title="src/agents/joke-teller.ts"
'use agent';
import { defineAgent, type AgentRouteHandler } from '@flue/runtime';

export const description = 'Tells a short joke in response to each message.';

export const route: AgentRouteHandler = async (_c, next) => next();

function JokeTeller() {
  return 'Tell a short joke in response to each message.';
}

export default defineAgent(JokeTeller, { model: 'anthropic/claude-haiku-4-5' });
```

In this example:

- **`'use agent'`:** This registers the module with the application. The filename gives the agent its durable identity: `joke-teller`.
- `description`: This optional static description of the agent. When present, it must be a non-empty string.
- `route`: This optional middleware runs on every HTTP request the agent's routes serve. Here it allows everything; real applications authenticate in it.
- `defineAgent(JokeTeller, config)`: This pairs the capability function with the agent's static identity — its model and tuning, fixed for the agent's lifetime.

The module defines the agent; making it reachable over HTTP is a separate, explicit step in `app.ts`:

```ts title="src/app.ts"
import { Hono } from 'hono';
import jokeTeller from './agents/joke-teller.ts';

const app = new Hono();
app.route('/agents/joke-teller', jokeTeller.route());

export default app;
```

See [Routing](/docs/guide/routing/) for the routes `.route()` serves and [Models & Providers](/docs/guide/models/) for model selection.

## The capability function

The capability function is where an agent's behavior lives. Flue Hooks called in its body — `useTool`, `useInstruction`, `useState`, and others — attach what the agent can do; the string it returns is the instruction text the model sees. A tools-only capability can return nothing at all.

```ts title="src/agents/order-assistant.ts"
'use agent';
import { defineAgent, useTool } from '@flue/runtime';
import { lookupOrderStatus } from '../shared/order-tools.ts';

function OrderAssistant() {
  useTool(lookupOrderStatus);
  return 'Help customers check the status of their orders.';
}

export default defineAgent(OrderAssistant, { model: 'anthropic/claude-haiku-4-5' });
```

The function runs again before every model turn, so guards and interpolated text always reflect current state — but the *shape* of what it mounts must stay the same across an instance's whole life: hook calls are never conditional, and every render must attach the same tools, state, and capabilities. See [Tools](/docs/guide/tools/), [Skills](/docs/guide/skills/), [Sandboxes](/docs/guide/sandboxes/), and [Subagents](/docs/guide/subagents/) for what an agent's body can compose, and [Durable Agents](/docs/concepts/durable-execution/) for how that state persists.

`defineAgent(Capability, config)`'s second argument is the agent's static identity — the fields that never render:

```ts title="src/agents/repository-reviewer.ts"
'use agent';
import { defineAgent, useSandbox, useSkill } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import reviewChecklist from '../skills/review-checklist/SKILL.md' with { type: 'skill' };

function RepositoryReviewer() {
  useSkill(reviewChecklist);
  useSandbox(local());
  return 'Review the requested change and report only findings supported by evidence.';
}

export default defineAgent(RepositoryReviewer, {
  model: 'anthropic/claude-sonnet-4-6',
  cwd: '/srv/repositories/catalog-service',
});
```

`config` accepts `model` (required), `thinkingLevel`, `compaction`, `durability`, and `cwd` — see the [Agent API](/docs/api/agent-api/) for each field's semantics.

### Composing capabilities with `use()`

Break a large agent into named pieces with `use(Capability, props?)`. Flue invokes the capability and records its instruction and attachments under that capability's identity — pass the function itself, never its result:

```ts title="src/agents/support-assistant.ts"
'use agent';
import { defineAgent, use, useTool } from '@flue/runtime';
import { escalateCase } from '../shared/support-tools.ts';

function Escalation() {
  useTool(escalateCase);
  return 'Escalate to a specialist only after you have confirmed the account and issue.';
}

function SupportAssistant() {
  use(Escalation);
  return 'Answer customer support questions clearly and accurately.';
}

export default defineAgent(SupportAssistant, { model: 'anthropic/claude-haiku-4-5' });
```

`use()` is subject to the same rule as every other hook: never call it conditionally. Drive behavior with state, props, and tool guards instead of mounting or unmounting capabilities — see [Durable Agents](/docs/concepts/durable-execution/) for the reasoning and the phased-workflow pattern this enables.

### Markdown instructions

Long instructions can live in their own markdown file. Import a `.md` file with the `with { type: 'markdown' }` import attribute and Flue inlines its contents as a string at build time — then return it as the capability's instruction:

```ts title="src/agents/repository-reviewer.ts"
'use agent';
import { defineAgent } from '@flue/runtime';
import instructions from './repository-reviewer.md' with { type: 'markdown' };

function RepositoryReviewer() {
  return instructions;
}

export default defineAgent(RepositoryReviewer, { model: 'anthropic/claude-sonnet-4-6' });
```

The attribute is required — a `.md` import without it fails the build. `SKILL.md` files are not plain markdown and must use `with { type: 'skill' }` instead; see [Skills](/docs/guide/skills/).

## Conversation ID

Each agent conversation is identified by an `id` — the trailing segment of its URL, chosen by the caller:

```text
POST /agents/support-assistant/ticket-8472
                               └─────────┘ id
```

It's up to the developer to decide what `id` means and whether it maps to important application data, such as a user ID, customer support ticket, or GitHub issue. A randomly generated ID can also work. The `id` keys the conversation's durable storage, and the runtime passes it to the top-level capability function as a prop — the way a web framework passes route params to the page component:

```ts
import { type AgentProps, defineAgent, useInitialData, useTool } from '@flue/runtime';
import type { SlackThreadRef } from '@flue/slack';
import { replyInThread } from '../channels/slack.ts';

function Assistant({ id }: AgentProps) {
  const thread = useInitialData<SlackThreadRef>();
  useTool(replyInThread(thread!));
  return `Reply in the Slack thread bound to conversation ${id}.`;
}

export default defineAgent(Assistant, { model: 'anthropic/claude-haiku-4-5' });
```

The `id` is the opaque address; structured facts like the thread ref arrive as
creation data (below), not by parsing `id` — channel packages expose a
`parseInstanceId(id)` escape hatch for the rare caller that must recover them
from the id itself. Only the top-level function receives `AgentProps`; a capability mounted with `use()` gets the props its caller passes, and a subagent's capability function gets nothing — a delegate runs in isolation from its parent, so share a value with it explicitly (close over it) or not at all. Agents that don't need the id keep the zero-argument form.

## Creation data

An instance usually exists *about something* — a support ticket, a GitHub issue, a customer. That fact is known when the instance is created, is constant for its whole life, and shouldn't be re-parsed out of later messages (only the first message is shaped by the code that creates the instance). Send it as `data` on the instance's first contact and read it with `useInitialData()`:

```ts
import * as v from 'valibot';

const input = v.object({ issue: v.pipe(v.number(), v.integer()) });

function Triage() {
  const data = useInitialData<v.InferOutput<typeof input>>();
  return `Triage GitHub issue #${data!.issue} end-to-end.`;
}

export default defineAgent(Triage, { model: 'anthropic/claude-opus-4-6', input });
```

```ts
await dispatch(triage, {
  id: 'issue-17307',
  data: { issue: 17307 },
  message: { kind: 'signal', type: 'github.issue', body: '…' },
});
```

The `input:` schema validates the data once, at instance creation — a creating call that omits or malforms it is rejected, so the value is guaranteed present and shaped from the first render on. Data sent to an existing instance is ignored; the recorded value never changes. Direct HTTP carries it the same way (`{ "data": {…}, "kind": "user", "body": "…" }`), as do `client.send({ message, data })` and `flue run --data '<json>'`.

The three input channels each have one job: **`useInitialData()` is what the instance is about, `useDelivery()` is what this message says, and `useState` is what the agent has learned.**

Authorize access to an `id` in the [`route`](#interacting-with-your-agent) handler. For work that arrives as a dispatched or signal-kind message — a webhook, a chat platform event — carry the identifier your application already validated in the message's `attributes` and read it inside the agent with `useDelivery()`; see [Tools](/docs/guide/tools/#protect-access) for the pattern.

### The id names the address, the uid names the incarnation

Every instance also gets a **uid** (`inst_<ulid>`), minted once at creation and recorded on its birth record. The `id` stays the address — client-chosen, reusable, the thing a URL or a `dispatch()` call names. The uid names *this incarnation* of that address, the way Kubernetes distinguishes `metadata.name` from `metadata.uid`: delete an id and recreate it, and the new incarnation gets a new uid.

Every send is a request against that address, and it can carry the uid as a condition — sends are conditional requests, with the uid playing the ETag:

| You pass | You're saying | Instance exists | Instance missing |
| --- | --- | --- | --- |
| neither | "deliver to this address" | continues | creates |
| `data` (no uid) | "seed if this creates" | continues, seed ignored | creates, seed validated and recorded |
| `uid: '<value>'` | "continue only that incarnation" | continues if the uid matches, else rejects | rejects |
| `uid: null` | "create only when fresh" | rejects (naming the existing uid) | creates |

Every successful send's receipt carries the uid — fresh on a creating send, echoed back on a continuing one — so the common case needs no separate lookup:

```ts
const receipt = await dispatch(triage, { id: 'issue-17307', data: { issue: 17307 }, message });
receipt.uid; // 'inst_01KW…'

await dispatch(triage, { id: 'issue-17307', uid: receipt.uid, message }); // continue only this incarnation
await dispatch(triage, { id: 'issue-17307', uid: null, data: { issue: 17307 }, message }); // create only, fresh
```

Reach for a uid condition in programmatic callers that mint their own ids and want to guard against a typo'd id silently continuing the wrong conversation, or against a stale reference reaching an instance that was deleted and re-created under the same id. Most callers don't need this: quick starts and a first prototype send unconditionally, and so do channels — a channel's derived instance id can't be typo'd, and "already exists" is its normal case for every message after the first (see [Channels](/docs/guide/channels/)). `uid: '<string>'` combined with `data` is a contradiction Flue rejects: the condition forbids creation, so the seed could never apply. See the [Agent API](/docs/api/agent-api/#conditional-sends) for the full condition semantics and error shapes, including `getAgentInstance()` for code that wants to condition a send it did not originate.

Instances created before this feature shipped have no uid: uid-conditioned sends against them are rejected, bare sends work as before, and their receipts omit `uid`.

## Interacting with your agent

Users can interact directly with a mounted agent over HTTP. Your application must verify that the caller can access the selected conversation `id`.

### HTTP

A mounted agent accepts one message per `POST` to its conversation URL. The body is the delivered message:

```http title="Prompt a support agent conversation"
POST /agents/support-assistant/ticket-8472 HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/json

{
  "kind": "user",
  "body": "Can you summarize the open issues in my case?"
}
```

The server responds `202` with an admission record — prompts are fire-and-forget, and the reply is read from the conversation (`GET` the same URL for the durable event stream, or `?view=history` for a snapshot). A `kind: 'user'` message may also carry an `attachments` array of `{ "type": "image", "data": "<base64>", "mimeType": "image/png" }` values for vision-capable models. The [SDK](/docs/sdk/overview/) wraps all of this — `send()`, `wait()`, `observe()`, `history()` — around one conversation URL.

Use the `route` handler to protect direct HTTP access to a conversation:

```ts title="src/agents/support-assistant.ts"
'use agent';
import { defineAgent, type AgentRouteHandler } from '@flue/runtime';
import { authenticate } from '../auth.ts';

export const route: AgentRouteHandler = async (c, next) => {
  const principal = await authenticate(c.req.header('authorization'));
  const ticketId = c.req.param('id');

  if (!principal) return c.json({ error: 'Unauthorized' }, 401);
  if (!principal.supportTicketIds.includes(ticketId)) return c.notFound();

  await next();
};

function SupportAssistant() {
  return 'Help with the authorized support ticket for this conversation.';
}

export default defineAgent(SupportAssistant, { model: 'anthropic/claude-haiku-4-5' });
```

For more information, see [Routing](/docs/guide/routing/) and [SDK](/docs/sdk/overview/).

## `dispatch()`

Use `dispatch(...)` when your application receives an event for an agent asynchronously, such as a webhook, queue message, chat event, or notification. For example, an application route can verify an incoming support-system webhook and dispatch the comment to the agent for that ticket:

```ts title="src/app.ts"
import { dispatch } from '@flue/runtime';
import { Hono } from 'hono';
import supportAssistant from './agents/support-assistant.ts';
import { verifySupportWebhook } from './shared/support-webhooks.ts';

const app = new Hono();

app.post('/webhooks/support-comments', async (c) => {
  const event = await verifySupportWebhook(c.req.raw);
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

app.route('/agents/support-assistant', supportAssistant.route());

export default app;
```

Your application chooses the agent conversation before dispatching the event. `dispatch(...)` accepts it for asynchronous processing rather than waiting for an agent response. Because registration comes from the `'use agent'` scan, an agent used only through `dispatch(...)` needs no mount at all. See [Channels](/docs/guide/channels/) for verified provider ingress and application-owned outbound behavior.

## Next steps

- [Agent API](/docs/api/agent-api/) — look up session operations and their results.
- [Tools](/docs/guide/tools/), [Skills](/docs/guide/skills/), and [Sandboxes](/docs/guide/sandboxes/) — configure what an agent can do and where it works.
- [Subagents](/docs/guide/subagents/) — delegate focused work to a specialist capability.
- [Routing](/docs/guide/routing/) — mount agent HTTP surfaces inside an authenticated application.
- [Schedules](/docs/guide/schedules/) — dispatch agent input on a schedule.
- [Channels](/docs/guide/channels/) — deliver verified provider events into agent sessions.
- [Observability](/docs/guide/observability/) — inspect agent activity.
