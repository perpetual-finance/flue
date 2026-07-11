---
title: Schedules
description: Dispatch agent input on a schedule with Cloudflare or Node.js.
lastReviewedAt: 2026-07-07
---

Schedules often start bounded work such as daily summaries, recurring reports, data synchronization, or cleanup. Model that work as an agent and deliver each occurrence with `dispatch(...)`. When the schedule's code needs the agent's result — to post it somewhere, or to gate a follow-up step — use the awaited `init(...).dispatch(...)` handle instead; on Cloudflare that awaiting belongs in a Workflow step rather than the cron invocation itself (see [Scripts](/docs/guide/scripts/#on-cloudflare)).

The conversation `id` you dispatch to sets the work's memory. A fresh id per occurrence (`daily-2026-07-02`) gives every run an independent conversation; a stable id (`daily-summary`) makes successive occurrences share conversation state, which is useful when the agent should remember what it reported yesterday.

Flue does not prescribe a scheduling library. Use the scheduler provided by your deployment environment.

## A scheduled agent

The scheduled agent is an ordinary agent module. It needs no mount in `app.ts` — being scanned via `'use agent'` is enough for `dispatch(...)` to reach it:

```ts title="src/agents/daily-summary.ts"
'use agent';
import { useModel } from '@flue/runtime';

export function DailySummary() {
  useModel('anthropic/claude-haiku-4-5');
  return 'When triggered, review recent activity and report a concise daily summary.';
}
```

Reach for a [harness tool](/docs/guide/tools/#harness-tools) instead of plain instructions when the scheduled work needs application-controlled steps — reading a data source, writing a report, calling an external API — that should behave the same way on every occurrence.

## Scheduling on Cloudflare

Add a [Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/) to your project's `wrangler.jsonc`:

```jsonc title="wrangler.jsonc"
{
  "triggers": {
    "crons": ["0 9 * * *"],
  },
}
```

Then import the agent function and dispatch to it from `src/cloudflare.ts`:

```ts title="src/cloudflare.ts"
import { dispatch, useModel } from '@flue/runtime';
import { DailySummary } from './agents/daily-summary.ts';

export default {
  async scheduled(controller: ScheduledController) {
    const scheduledAt = new Date(controller.scheduledTime).toISOString();
    await dispatch(DailySummary, {
      id: 'daily-summary',
      message: {
        kind: 'signal',
        type: 'schedule',
        body: 'Review recent activity and prepare the daily summary.',
        attributes: { scheduledAt },
      },
    });
  },
};
```

`dispatch(...)` resolves after the input is durably admitted to the agent's Durable Object and returns a `dispatchId`; it does not wait for the work to complete. Cron Triggers use UTC. See Cloudflare's [`scheduled()` handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/) documentation for the complete API, and [Cloudflare](/docs/guide/targets/cloudflare/) for `cloudflare.ts`.

For scheduled behavior that belongs to one specific agent's Durable Object, the Agents SDK scheduling APIs (`schedule()`, `scheduleEvery()`) via the module's `cloudflare` extension are an alternative; see [Extending Agents on Cloudflare](/docs/guide/targets/cloudflare/#extending-agents-on-cloudflare).

## Scheduling on Node.js

Node.js does not include a built-in cron scheduler, so choose an ecosystem option that fits how your application is deployed. This example uses [Croner](https://croner.56k.guru/), a lightweight scheduler with async callbacks, overlap protection, and timezone support, started from `app.ts` so it runs for the server's lifetime:

```ts title="src/app.ts"
import { dispatch, useModel } from '@flue/runtime';
import { Cron } from 'croner';
import { Hono } from 'hono';
import { DailySummary } from './agents/daily-summary.ts';

const app = new Hono();

new Cron(
  '0 9 * * *',
  {
    protect: true,
    timezone: 'UTC',
    catch: (error) => console.error('Scheduled agent admission failed', error),
  },
  async () => {
    await dispatch(DailySummary, {
      id: 'daily-summary',
      message: {
        kind: 'signal',
        type: 'schedule',
        body: 'Review recent activity and prepare the daily summary.',
        attributes: { scheduledAt: new Date().toISOString() },
      },
    });
  },
);

export default app;
```

For production schedules that must survive restarts or coordinate across replicas, use a persistent scheduler such as BullMQ. An in-process scheduler like Croner only runs while that Node process is alive.

A runnable version of this pattern is available in [`examples/node-schedules`](https://github.com/withastro/flue/tree/main/examples/node-schedules).

## One-shot occurrences from CI

A scheduler that can run a command — cron itself, a CI pipeline, GitHub Actions — can drive the same agent with [`flue run`](/docs/cli/run/) instead of a live server:

```bash
flue run src/agents/daily-summary.ts \
  --message "Review recent activity and prepare the daily summary." \
  --id "daily-$(date +%F)"
```

Each invocation runs locally, streams activity, prints the reply, and exits. The dated `--id` gives each day its own conversation.

## Next steps

- [Tools](/docs/guide/tools/) — put the reliability-critical steps of scheduled work behind a harness tool with validated input and output.
- [Agents](/docs/guide/building-agents/) — define the agent that receives scheduled input.
- [Cloudflare](/docs/guide/targets/cloudflare/) — configure the Cloudflare target and `cloudflare.ts` entrypoint.
- [Node.js](/docs/guide/targets/node/) — build and operate the Node.js server.
