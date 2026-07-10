---
title: Scripts
description: Drive agents from plain Node scripts, cron jobs, and tests with start() and init().
lastReviewedAt: 2026-07-08
---

Sometimes you are not answering traffic — you are running a script: a nightly job, a CI step, a one-off migration, a test. For that, Flue gives you a programmatic client for agents. `init(agent)` addresses an agent instance; `await agent.dispatch(...)` sends it a message exactly as any other delivery would — a bare string is shorthand for a user message — waits for the run to settle, and returns the reply.

There is no separate "workflow" concept: a script is plain code that holds the same agents your server runs, and a send from a script is indistinguishable to the agent from any other delivery — `useDelivery` reads the message, lifecycle hooks fire, state persists.

## Driving an agent from a script

Inside a running Flue app (a cron callback in `app.ts`, a route handler), the runtime is already configured — `init()` works directly, like `dispatch()`:

```ts title="src/app.ts"
import { init } from '@flue/runtime';
import { Cron } from 'croner';
import reporter from './agents/reporter.ts';

new Cron('7 3 * * *', async () => {
  const agent = init(reporter, { id: `nightly-${new Date().toISOString().slice(0, 10)}` });
  const reply = await agent.dispatch('You have been triggered. Produce the nightly report.');
  console.log(reply.text);
});
```

Use the top-level `dispatch(...)` when you only need to deliver input and move on — it resolves at durable admission ([Schedules](/docs/guide/schedules/)). Use the `init(...)` handle when the script needs the result: same verb, same message shapes, awaited to settlement.

### On Cloudflare

The handle works in a deployed Worker too — the awaited send admits the message to the agent's Durable Object and observes its settlement over the same bounded reads the web client uses, so nothing holds a request open against the platform. The context that makes awaiting genuinely worthwhile is a [Cloudflare Workflow](https://developers.cloudflare.com/workflows/) step, where the reply becomes the step's durable result:

```ts title="src/workflows.ts"
import { init } from '@flue/runtime';
import { WorkflowEntrypoint } from 'cloudflare:workers';
import reviewer from './agents/reviewer.ts';

export class NightlyReview extends WorkflowEntrypoint {
  async run(event, step) {
    const findings = await step.do('collect findings', () => collect(event.payload));

    // Once this step completes, the workflow engine never re-runs it — the
    // reply is recorded in the workflow's own history.
    const review = await step.do('agent review', async () => {
      const agent = init(reviewer, { id: `nightly-${event.payload.date}` });
      const reply = await agent.dispatch(`Review these findings:\n${findings}`);
      return { text: reply.text, data: reply.data };
    });

    await step.do('file report', () => fileReport(review));
  }
}
```

A step that fails mid-await is re-fired by the workflow engine and dispatches again — `dispatch` delivery is at-least-once, and the step boundary is the dedup: keep one agent send per step, and let the completed step's recorded result stand in for the reply on every later access.

In plain fetch handlers and [Cron Triggers](/docs/guide/schedules/#scheduling-on-cloudflare), prefer the top-level `dispatch(...)` — fire-and-forget at durable admission — and let the agent deliver its own result through a tool, a finish hook, or a channel: an agent run can outlast what those invocation contexts want to hold open, and each settlement poll while awaiting counts against the invocation's subrequest budget. To await a reply from outside the Worker, use the `@flue/sdk` client against the agent's HTTP routes.

## Standalone scripts: `start()`

Outside a Flue server — `node ./scripts/nightly.ts` — boot the runtime first with `start()` from `@flue/runtime/node`. It performs the same startup a generated server entry does (agent registration, persistence, the durable submission coordinator) with no HTTP surface:

```ts title="scripts/nightly.ts"
import { init } from '@flue/runtime';
import { sqlite, start } from '@flue/runtime/node';
import reporter from '../src/agents/reporter.ts';

await using flue = await start({
  agents: [{ name: 'reporter', agent: reporter }],
  db: sqlite('./nightly.db'), // omit for in-memory (nothing survives exit)
});

const agent = init(reporter, { id: `nightly-${new Date().toISOString().slice(0, 10)}` });
const reply = await agent.dispatch('You have been triggered. Produce the nightly report.');
console.log(reply.text);
```

Run it with `node --env-file=.env scripts/nightly.ts` (provider API keys come from the environment; a bare script loads `.env` itself). Without `await using`, call `await flue.stop()` when done.

`start()` refuses to run inside an already-configured Flue process — there, `init()` needs no bootstrap. One process holds one Flue runtime.

Two loader caveats for bare `node`: markdown and skill imports (`.md` / `SKILL.md` / `?skill`) and `cloudflare:workers` imports do not load outside the Vite pipeline. Agents that use them run under `flue dev`/`flue run` instead.

## The handle

`init(agent, options?)` returns a handle addressing one instance. It creates nothing — the instance is created on first contact, with the same semantics as every other transport:

- `id` — the instance address. Omit it for a fresh unique id (a throwaway instance for this run); pass a stable id to share conversation state across runs.
- `initialData` — creation data, validated against the agent's `initialDataSchema` export; the seed, consulted only when the handle's first send creates the instance.
- `uid` — a [send condition](/docs/guide/building-agents/) for the first contact: a string continues only that incarnation, `null` creates only. After a send, the handle pins the incarnation it contacted and later sends continue it.

`dispatch(message, options?)` accepts exactly what the top-level verb accepts — a `DeliveredMessage` of either kind, or a bare string as shorthand for `{ kind: 'user', body }` — and resolves with the settled reply:

```ts
const reply = await agent.dispatch('Summarize the failures.', {
  onEvent: (chunk) => process.stdout.write(chunk.type === 'message-delta' ? chunk.delta : ''),
});
reply.text; // final assistant text
reply.data; // useDataWriter parts, keyed by name
reply.metadata; // useResponseStart/useResponseFinish, when attached
reply.submissionId; // this run's settled submission
```

A failed or aborted run rejects with `AgentRunError` (`error.outcome`, `error.submissionId`, `error.cause`). Concurrent sends to one instance serialize, or join a live response at a turn boundary — a joined delivery resolves with the coalesced reply that answered it.

## Durability is the store's, not the await's

The records a script produces are exactly as durable as the configured persistence: with `db: sqlite('./run.db')` (or any adapter), conversations survive and a re-run with the same instance id continues them; with the in-memory default, everything is gone at exit.

The `await` itself is deliberately not durable. If the process dies mid-await, the in-flight promise is lost — for CI jobs and scripts, re-running is the recovery. If a job requires resumable checkpointed steps, that is a durable-orchestration concern; see [Durable execution](/docs/concepts/durable-execution/).

## Testing agents with the same API

`start()` with the default in-memory store makes agent tests plain scripts:

```ts title="reporter.test.ts"
import { registerFauxProvider } from '@earendil-works/pi-ai/compat';
import { init, registerProvider } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import reporter from '../src/agents/reporter.ts';

test('produces a report on trigger', async () => {
  const faux = registerFauxProvider({ provider: 'faux', models: [{ id: 'faux-model' }] });
  registerProvider('faux', { api: faux.api, baseUrl: 'https://faux.invalid' });
  faux.setResponses([
    /* scripted turns */
  ]);

  await using flue = await start({ agents: [{ name: 'reporter', agent: reporter }] });
  const reply = await init(reporter).dispatch('You have been triggered.');
  expect(reply.text).toContain('# Nightly Report');
});
```

(The agent module under test must be configured with the faux model, e.g. via its `model` config or an environment switch.)
