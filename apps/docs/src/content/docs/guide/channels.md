---
title: Channels
description: Receive verified provider events and connect them to Flue applications.
lastReviewedAt: 2026-07-07
---

Channels bring provider HTTP events into a Flue application. A channel verifies
the provider request, parses it into typed provider-native data, and calls your
application handler. Your handler can dispatch work to an agent, invoke
application code, or return a provider-specific response.

Channels are intentionally focused on inbound HTTP. They are not universal
clients for Slack, GitHub, Stripe, or another provider. Use the provider's
established SDK for outbound API calls, then expose only the operations your
application or agents need.

## Add a channel

Use `flue add` to give your coding agent the integration blueprint for a
first-party channel:

```sh
flue add channel slack --print | codex
```

The blueprint inspects the project and creates a module such as
`src/channels/slack.ts`. A typical channel module exports:

```ts title="src/channels/slack.ts"
import { createSlackChannel } from '@flue/slack';
import { WebClient } from '@slack/web-api';

export const client = new WebClient(process.env.SLACK_BOT_TOKEN);

export const channel = createSlackChannel({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,

  // Path: /channels/slack/events
  async events({ payload }) {
    if (payload.type !== 'event_callback') return;
    // Handle payload.event using Slack's native types and fields.
  },
});
```

The named `channel` export is the Flue integration. The named `client` export is
ordinary application code initialized with the provider SDK. A channel module
may also export application-owned tools or helper functions.

The channel serves HTTP only once your `app.ts` mounts it:

```ts title="src/app.ts"
import { channel as slack } from './channels/slack.ts';

app.route('/channels/slack', slack.route());
```

See the [Ecosystem](/docs/ecosystem/#channels) for first-party packages
and provider-specific setup.

## Custom Channel

When Flue does not provide a first-party channel, give `flue add` the provider's
webhook documentation and select the generic channel blueprint:

```sh
flue add channel https://provider.example/webhooks --print | codex
```

The blueprint guides your coding agent through creating a
`channels/<provider>.ts` module, verifying requests against the unconsumed body,
preserving provider-native events, and adding the provider's established SDK for
outbound calls. Review the generated code and test valid and invalid signatures,
protocol handshakes, responses, and the configured Node or Cloudflare target.

See the [generic channel blueprint](https://github.com/withastro/flue/blob/main/blueprints/channel.md)
for the full implementation and verification checklist.

## Understand ownership

Flue channels own the provider ingress boundary. Your application owns how that
event affects the rest of the system.

| Concern                                                | Owner           |
| ------------------------------------------------------ | --------------- |
| Request authentication and signature verification      | Channel package |
| Provider handshakes and automatic protocol responses   | Channel package |
| Body limits, parsing, and typed provider payloads      | Channel package |
| Route suffixes beneath the mount (`/events`, …)        | Channel package |
| The mount path chosen in `app.ts`                      | Application     |
| Provider SDK client and outbound credentials           | Application     |
| OAuth, installation, token storage, and token rotation | Application     |
| Agent tools and authorization policy                   | Application     |
| Delivery deduplication and business persistence        | Application     |

This boundary keeps each provider's large outbound API in its established SDK
instead of rebuilding it inside Flue. Provider ecosystem guides can document
useful SDK operations, but those methods remain SDK capabilities rather than
features implemented by the channel package.

## Mounting

A channel object exposes `.route()`, a pure router factory that serves the
provider's declared routes relative to wherever `app.ts` mounts it:

```ts title="src/app.ts"
import { Hono } from 'hono';
import { channel as github } from './channels/github.ts';
import { channel as slack } from './channels/slack.ts';

const app = new Hono();

app.route('/channels/github', github.route()); // -> POST /channels/github/webhook
app.route('/channels/slack', slack.route()); // -> POST /channels/slack/events
//    POST /channels/slack/interactions
//    POST /channels/slack/commands

export default app;
```

The provider package defines one or more fixed, non-empty suffixes such as
`/webhook`, `/events`, or `/interactions`. The mount path is yours —
`/channels/slack` is a convention, and a prefix is just a longer mount path
(`app.route('/api/channels/slack', slack.route())`). The mount root itself is
not an endpoint.

Point the provider's webhook configuration at your chosen mount plus the
provider's suffix. Use an application-owned Hono route instead when a provider
requires a fully custom URL shape. See [Routing](/docs/guide/routing/).

## Handle verified events

Each provider constructor accepts callbacks for its HTTP surfaces. The callback
runs only after the package has performed the applicable request
authentication, parsing, and protocol handling. Handshakes that do not represent
application events are handled before the callback:

```ts title="src/channels/slack.ts"
import { dispatch } from '@flue/runtime';
import { createSlackChannel } from '@flue/slack';
import assistant from '../agents/assistant.ts';

export const channel = createSlackChannel({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,

  // Path: /channels/slack/events
  async events({ payload }) {
    if (payload.type !== 'event_callback') return;

    switch (payload.event.type) {
      case 'app_mention': {
        const event = payload.event;
        await dispatch(assistant, {
          id: channel.instanceId({
            teamId: payload.team_id,
            channelId: event.channel,
            threadTs: event.thread_ts ?? event.ts,
          }),
          message: {
            kind: 'signal',
            type: 'slack.app_mention',
            body: event.text,
            attributes: { eventId: payload.event_id },
          },
        });
        return;
      }
      default:
        return;
    }
  },
});
```

The callback receives one extensible object containing the authentic Hono
context as `c` and provider-specific typed data such as `payload`, `event`, or
`interaction`. First-party channels prefer authoritative provider-maintained
types and preserve provider field names, nesting, and discriminants. Use a
`switch` to group provider event types that share behavior, and consult the
provider package reference for its exact callback shape.

Some providers expose multiple optional surfaces. Omitting an optional callback
omits its route instead of publishing an empty handler.

## Return provider responses

Channel callbacks use ordinary Hono and Fetch responses:

- Return nothing when an empty successful acknowledgement is appropriate.
- Return `c.json(...)`, `c.text(...)`, or another `Response` for explicit
  status, headers, or body control.
- When supported by the provider package, return a JSON-compatible value to use
  it as the response body.

Provider protocols may narrow the accepted return values. Discord interactions
require a provider response, Slack view submissions can return validation
errors, and Twilio handlers use explicit responses for provider-specific XML or
other bodies. Follow the provider guide and API reference for the exact
contract.

## Deliver events to agents

Use `dispatch(...)` when an accepted event should become asynchronous input to
a continuing agent:

```ts
if (payload.type === 'event_callback' && payload.event.type === 'app_mention') {
  await dispatch(assistant, {
    id: channel.instanceId(thread),
    message: {
      kind: 'signal',
      type: 'slack.app_mention',
      body: payload.event.text,
      attributes: { eventId: payload.event_id },
    },
  });
}
```

Channel deliveries use `kind: 'signal'` rather than `kind: 'user'`. A `user`
message models one person talking directly to the assistant, which fits a
direct 1:1 chat surface such as an SDK-driven chat UI. Most channels are more
advanced than that: a Slack thread, GitHub issue, or group chat is a
multi-user conversation that the agent participates in as one member, and
signals model that activity — with sender identity carried in `attributes` —
without conflating other participants with the assistant's own user.

Keep `body` as the message itself — the comment, chat message, or email text —
and put structured metadata such as sender identity, provider ids, and
deduplication keys in `attributes` as flat string values.

Your application chooses the agent and instance id before dispatch. A provider
thread, issue, ticket, or conversation is often a useful instance boundary
because later events continue the same agent session.

Channels send unconditionally, on purpose: they never pass a `uid` send
condition. A channel's derived id (`channel.instanceId(thread)`) can't be
typo'd the way a hand-picked id can, and "the instance already exists" is the
normal case for every event after the first — a condition built for guarding
against creating the wrong instance would misfire on the common path. Channels
may still pass `data` freely as the creation seed (thread id, author, or
whatever the first event carries): it is validated and recorded only on the
event that actually creates the instance, and silently ignored on every later
one. See [Creation data](/docs/guide/building-agents/#creation-data) and
[Conditional sends](/docs/api/agent-api/#conditional-sends).

Instance ids are canonical identifiers, not authorization capabilities.
If a caller can select an agent id through another route, authorize that id
before deriving provider destinations or outbound tools from it.

A dispatched event is an operation inside an agent session. See
[Agents](/docs/guide/building-agents/) for continuing agent state.

## Use provider SDKs

Initialize the provider's established SDK in application code and export the
client from the channel module:

```ts
import { defineTool } from '@flue/runtime';
import { Octokit } from '@octokit/rest';
import * as v from 'valibot';

export const client = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

export function commentOnIssue(ref: { owner: string; repo: string; issueNumber: number }) {
  return defineTool({
    name: 'comment_on_github_issue',
    description: 'Comment on the GitHub issue bound to this agent.',
    input: v.object({ body: v.string() }),
    async run({ data, signal }) {
      await client.rest.issues.createComment({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
        body: data.body,
        request: { signal },
      });
      return { posted: true };
    },
  });
}
```

Bind credentials and destinations in trusted code. Let the model select message
content or other intentionally variable values, not arbitrary account ids,
URLs, credentials, or provider methods.

There is no universal channel client or generic provider tool collection.
Provider APIs, authorization models, and SDKs are too different for a shared
outbound abstraction to preserve their capabilities well.

## Handle retries and delivery identity

Channel packages are stateless and do not deduplicate provider deliveries.
Providers may retry failed requests, deliver events more than once, or deliver
them out of order.

Preserve the provider delivery or event id in application input when it is
useful for tracing. When duplicate admission is unacceptable, claim that id in
application-owned durable storage before performing external effects or
dispatching work.

Handlers wait for application work such as `dispatch(...)` admission before
acknowledging. Some packages impose a deadline so the provider receives a
response within its protocol window. A timed-out JavaScript operation cannot be
forcibly stopped and may still complete later, so a timeout does not replace
idempotency.

Retry behavior and useful delivery identifiers are provider-specific. See the
corresponding ecosystem guide.

## Protect sensitive provider data

Keep credentials, raw request bodies, webhook response URLs, interaction
tokens, and other short-lived provider capabilities out of:

- model context;
- dispatched messages;
- logs;
- durable agent session history.

Use those values only in immediate trusted application code. Provider identity
such as a workspace id, repository name, or channel id may still be sensitive
and does not by itself authorize an operation.

## Run on Node and Cloudflare

First-party channel packages use Fetch and Web Crypto and are tested on Node
and workerd. Flue Cloudflare builds enable `nodejs_compat`.

The outbound client remains application-owned. A client import successfully
bundling for Cloudflare is not proof that every SDK operation works there.
Provider blueprints select a credible cross-runtime client, and examples execute a
representative client operation in workerd without contacting the provider.
Validate any additional SDK paths your application depends on.

Long-lived sockets, polling loops, and provider-managed background transports
are outside the current channel model. Use verified HTTP delivery, or keep that
integration in application-owned infrastructure until Flue supports the
required transport.

## Other integration paths

[Chat SDK](https://chat-sdk.dev/docs) is a separate option when its
cross-provider conversation model, adapters, and chat-side state are a better
fit than provider-native first-party channels. In that design, Chat SDK owns
its adapter and state boundary, while application handlers call
`dispatch(...)` to deliver accepted messages to Flue agents.

## Next steps

- [Ecosystem](/docs/ecosystem/#channels) — choose a first-party provider.
- [Agents](/docs/guide/building-agents/) — deliver events into continuing agent
  sessions.
- [Routing](/docs/guide/routing/) — compose channels with application routes,
  middleware, and a shared prefix.
