---
title: Actions
description: Define finite agent-backed operations the model can run reliably.
lastReviewedAt: 2026-07-02
---

An Action is reusable logic that orchestrates an agent harness in a deterministic, reliable way. Use one when a sensitive or reliability-critical task needs application-controlled steps, context, and results.

Actions give [agents](/docs/guide/building-agents/) a reliable way to perform tasks that should follow application-defined logic instead of leaving every step to the model.

## Define an Action

Create an Action with `defineAction()`:

```ts title="src/actions/summarize.ts"
import { defineAction } from '@flue/runtime';
import * as v from 'valibot';

export const summarize = defineAction({
  name: 'summarize_document',
  description: 'Summarize a document clearly and concisely.',
  input: v.object({ text: v.string() }),
  output: v.object({ summary: v.string() }),

  async run({ harness, input, log }) {
    log.info('Summarizing document');
    const session = await harness.session();
    const response = await session.prompt(`Summarize this text:\n\n${input.text}`);
    return { summary: response.text };
  },
});
```

An Action has these parts:

- `name` is the model-facing name used when an agent exposes the Action.
- `description` helps the model decide when to call it.
- `input` is an optional top-level [Valibot](https://valibot.dev) object schema. Flue validates and transforms input before `run()` starts.
- `output` is an optional Valibot schema. Flue validates and snapshots the returned value as JSON-compatible data.
- `run({ harness, input, log })` performs the operation. Use the harness to open sessions, work with the configured sandbox, or call other agent capabilities.

This guide uses `src/actions/` to organize shared Actions, but that directory has no special meaning. An Action becomes available only when you import it into an agent configuration.

## Give an Action to an agent

Add an Action to the agent's `actions` list so the model can decide when to run it:

```ts title="src/agents/editor.ts"
'use agent';
import { defineAgent } from '@flue/runtime';
import { summarize } from '../actions/summarize.ts';

export default defineAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  instructions: 'Help the user edit and understand their documents.',
  actions: [summarize],
}));
```

Flue presents each configured Action to the model as a framework-managed tool using its name, description, and input schema. When the model calls it, Flue runs the Action with an isolated child harness and returns its result to the conversation. The child has independent sessions while sharing the parent agent's configuration, sandbox, and filesystem. Its conversation records remain in the append-only conversation stream rather than being recursively deleted.

Actions share the model-facing namespace with custom and framework-provided tools, so every active capability needs a distinct name.

## Run action-backed work as a job

An agent whose instructions point at an Action is Flue's shape for finite, repeatable jobs — background tasks, document transformations, reviews, CI steps. (This replaces the removed `defineWorkflow`; see the [Migration Guide](/docs/guide/migration/).) Dedicate an agent to the job:

```ts title="src/agents/daily-report.ts"
'use agent';
import { defineAgent } from '@flue/runtime';
import { dailyReport } from '../actions/daily-report.ts';

export default defineAgent(() => ({
  model: 'anthropic/claude-haiku-4-5',
  instructions:
    'When asked to run the daily report, call the `daily-report` action and report its result.',
  actions: [dailyReport],
}));
```

Then drive it through any agent entry point:

- **CLI / CI:** `flue run src/agents/daily-report.ts --message "Run the daily report" --id daily-2026-07-02` — a caller-chosen `--id` gives each occurrence its own conversation, or reuses one. See [flue run](/docs/cli/run/).
- **Application code and schedules:** `dispatch(dailyReport, { id, message })`. See [Schedules](/docs/guide/schedules/).
- **HTTP / SDK:** mount the agent in `app.ts` and prompt its conversation URL.

The Action's validated `input`/`output` still gate the work itself; the model's part is calling it. The record of a job is its conversation — read it back with the SDK's `history()` or `observe()`.

## When to use an Action

Actions are most useful when:

- application code needs to control the sequence of agent operations;
- sensitive or reliability-critical work needs validated inputs and results;
- a multi-step task should behave consistently instead of relying on the model to plan every step;
- the same agent-backed operation should be reusable across agents.

For a direct application function, use a [tool](/docs/guide/tools/). For reusable instructions and resources, use a [skill](/docs/guide/skills/).

## Next steps

- [Agents](/docs/guide/building-agents/) — expose Actions alongside an agent's other reusable capabilities.
- [Schedules](/docs/guide/schedules/) — dispatch action-backed work on a schedule.
- [Tools](/docs/guide/tools/) — define direct application functions for models.
- [Skills](/docs/guide/skills/) — package reusable instructions and supporting resources.
- [Action API](/docs/api/action-api/) — look up complete schemas, context types, and error contracts.
