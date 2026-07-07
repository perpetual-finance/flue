---
title: Observability
description: Monitor agent activity and export telemetry from your application.
lastReviewedAt: 2026-07-07
---

Observability helps you understand whether Flue work completed, failed, became slow, or used more model resources than expected. Use `observe(...)` to monitor agent activity across your application, and tool logging to record application-specific facts inside a tool call.

## Log inside tools

Every tool's `run` context includes `log`, regardless of whether the tool is a pure function of its input or a [harness tool](/docs/guide/tools/#harness-tools). Use it to record application-specific facts that runtime activity alone cannot explain — for example, a summarization tool can report the size of the accepted document and the usage of the completed operation:

```ts title="src/shared/summarize-tools.ts"
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

export const summarizeDocument = defineTool({
  name: 'summarize_document',
  description: 'Summarize the supplied document clearly and concisely.',
  input: v.object({ text: v.string() }),
  harness: true,

  async run({ harness, log, input }) {
    log.info('Summarization requested', { characters: input.text.length });
    const response = await (await harness.session()).prompt(input.text);

    log.info('Summarization completed', {
      tokens: response.usage.totalTokens,
      cost: response.usage.cost.total,
    });

    return { summary: response.text };
  },
});
```

`log.info(...)`, `log.warn(...)`, and `log.error(...)` accept structured attributes. Use attributes for values that you may later search, aggregate, or forward to a monitoring system. These logs surface as `log` events to observers registered with `observe(...)`. See the [Agent API](/docs/api/agent-api/) for the complete tool run context.

## Observe application activity

Register `observe(...)` in your application entrypoint when you need telemetry across your agents. The observer receives activity handled by that running application context, including operations triggered by asynchronously dispatched input.

```ts title="src/app.ts"
import { observe } from '@flue/runtime';
import { Hono } from 'hono';
import triage from './agents/triage.ts';

observe((event) => {
  if (event.type === 'operation' && event.isError) {
    console.error('Operation failed', event.operationKind, event.error);
  }

  if (event.type === 'operation' && event.durationMs > 5_000) {
    console.warn('Slow operation', event.operationKind, event.durationMs);
  }

  if (event.type === 'log' && event.level === 'error') {
    console.error(event.message, event.attributes);
  }
});

const app = new Hono();
app.route('/agents/triage', triage.route());

export default app;
```

An operation is the useful finite boundary for agent activity, such as prompting a session, running a skill, or delegating work with a task. Direct and dispatched agent input can therefore be monitored as bounded units without any separate job abstraction.

When an operation is slow or unexpectedly expensive, its nested activity can provide the explanation. One prompt operation may include multiple model turns or tool calls. Model turns expose latency, token usage, and cost; tool activity shows where the agent spent time or encountered an error.

Callbacks registered with `observe(...)` are invoked while Flue emits activity and receive every emitted event object directly. Treat events as read-only, branch on `event.type`, and return immediately for activity you do not consume. Keep callbacks lightweight; returned promises are observed for rejection but are not awaited. In a distributed deployment, each running application context observes only the activity it handles; use an external backend to aggregate telemetry across processes or isolates.

Streaming deltas are best-effort live progress; use `message_end` as the authoritative completed assistant message. A subscriber attached after generation starts may miss earlier partial output until that event arrives. Internal interrupted-turn recovery uses separate durable state and is unaffected.

## Inspect a conversation's record

The durable record of agent work is its conversation. To inspect what happened in one conversation — the messages, tool calls, and results — read it back through the [SDK](/docs/sdk/overview/)'s `history()` or `observe()`, or `GET` the conversation URL directly. `submissionId` values on messages correlate a delivered prompt or dispatch with the activity it produced.

## Choose an observability provider

| Provider                                                | Choose it when                                                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [OpenTelemetry](/docs/ecosystem/tooling/opentelemetry/) | You need vendor-neutral traces or already operate an OpenTelemetry-compatible backend.                     |
| [Braintrust](/docs/ecosystem/tooling/braintrust/)       | You want content-bearing agent traces, model usage, costs, and evaluation-oriented debugging.              |
| [Sentry](/docs/ecosystem/tooling/sentry/)               | You primarily want actionable failures and explicit error logs without exporting model content by default. |

You can also consume `observe(...)` directly when these integrations do not match your telemetry or data-handling requirements.

## Export telemetry safely

Runtime events can contain prompts, model messages, logs, tool values, errors, and application-owned metadata. Flue replaces image data in recognized content blocks with an omission sentinel before events are observed or persisted, but arbitrary inputs, log attributes, tool details, and results still require an application-owned sanitization policy.

Start with outcome-oriented signals: failed operations, explicit application error logs, slow operations, and completed model usage. A model turn or tool call may fail before an agent recovers, so treating every nested error as an incident can create noisy alerts. When aggregating usage, sum model-turn leaf values rather than operation or compaction roll-ups; nested duration values can overlap and should not be summed.

Restrict subscriptions to required event types and review the retention, access, and redaction controls of any external backend before exporting content. The provider guides above describe each integration's default export policy and runtime-specific behavior.

## Next steps

- [Events reference](/docs/api/events-reference/) — inspect the complete observable event contract.
- [Tools](/docs/guide/tools/) — bounded operations with application-owned logging.
- [Agents](/docs/guide/building-agents/) — create agents and deliver direct or dispatched input.
- [Routing](/docs/guide/routing/) — the application entrypoint where telemetry observers are registered.
