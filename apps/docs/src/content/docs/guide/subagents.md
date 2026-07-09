---
title: Subagents
description: Let agents delegate focused work to named specialists.
lastReviewedAt: 2026-07-07
---

Subagents let an agent delegate a piece of work to a named specialist while it continues to own the interaction. Use them when an agent should ask another agent function to research, classify, or review something and then work with the returned answer.

A subagent is an **agent function** isolated as a delegate with `useSubagent({ name, description, agent })`, declared inside another agent. Delegated work runs in a separate child session, rather than continuing the parent agent's conversation history. The subagent is not a separately addressable agent endpoint.

## Define a subagent

Declare `useSubagent(...)` inside the agent function that should be able to delegate, passing it the delegate's own agent function:

```ts title="src/agents/support-assistant.ts"
'use agent';
import { defineAgent, useSubagent } from '@flue/runtime';

function IssueClassifier() {
  return 'Return the likely product area and urgency for the reported issue.';
}

function SupportAssistant() {
  useSubagent({
    name: 'issue_classifier',
    description: 'Classifies support issues for routing.',
    agent: IssueClassifier,
  });
  return 'Help resolve support requests. Delegate classification when it helps your answer.';
}

export default defineAgent(SupportAssistant, { model: 'anthropic/claude-sonnet-4-6' });
```

In this example, `support-assistant` can delegate work to `issue_classifier`. `agent` is the function that defines the delegate's whole world — Flue renders it fresh, in its own frame, at the moment the model delegates to it. It does not define another agent at `/agents/issue_classifier/:id`.

`description` is shown to the parent model alongside the delegate's name on the built-in `task` tool, so write it as delegation guidance: a short statement of what the subagent is good for.

## Delegate work

An agent with a declared subagent can decide to delegate while answering a prompt. Flue gives the agent a built-in `task` capability that renders the selected delegate's `agent` function, runs it in a child session, and returns that child's answer to the parent agent.

The delegate's render composes its own custom hooks, `useTool()`, `useInstruction()`, and `useSkill()` calls exactly like a root agent function, and it may declare further `useSubagent()` delegates of its own, up to the delegation depth cap. `usePersistentState()` and `useSandbox()` throw inside a delegate's render: durable state is scoped to the agent instance, and a delegate shares its parent's environment rather than attaching its own.

## Configuration inheritance

A subagent's `agent` function is self-contained: what it mounts is exactly what its own render produces — nothing flows in from the parent's agent function. Only environment defaults inherit.

| Field                                    | Behavior                                                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Instructions, tools, skills, subagents    | Delegate-owned. Exactly what the `agent` function composes when rendered at delegation time.                         |
| `model`, `thinkingLevel`                  | Inherits as a default: the parent's current values apply unless `useSubagent(...)` sets its own `model`/`thinkingLevel`. |

A delegated task runs inside the parent operation, so it has no independent durability configuration of its own.

A `task()` call without an `agent` name is not a subagent delegation: the child session reuses the parent's full configuration in a fresh context.

## Use subagents in tools

A [harness tool](/docs/guide/tools/#harness-tools) can choose delegation directly when application logic requires work from a particular subagent. Call `harness.task(...)` with the name of a declared subagent, and provide `result` when the tool needs validated data:

```ts title="src/shared/review-tools.ts"
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

const Review = v.object({
  summary: v.string(),
  risks: v.array(v.string()),
});

export const reviewChange = defineTool({
  name: 'review_change',
  description: 'Have the reviewer subagent assess one proposed change.',
  input: v.object({ change: v.string() }),
  harness: true,

  async run({ harness, data }) {
    const response = await harness.task(data.change, {
      agent: 'reviewer',
      result: Review,
    });
    return response.data;
  },
});
```

Here, application code chooses `reviewer` rather than leaving delegation to the parent agent. The agent that mounts this tool must also declare the `reviewer` delegate with its own `useSubagent({ name: 'reviewer', ... })` call. See the [Agent API](/docs/api/agent-api/) for task options and result types.

## Next steps

- [Agents](/docs/guide/building-agents/) — create agents composed from agent functions.
- [Tools](/docs/guide/tools/) — give a subagent's agent function its own tools, or delegate from inside a harness tool.
- [Skills](/docs/guide/skills/) — reusable instructions a delegate's agent function can mount.
- [Sandboxes](/docs/guide/sandboxes/) — how a delegate shares the parent's environment.
- [Agent API](/docs/api/agent-api/) — look up `harness.task(...)` options and results.
- [Observability](/docs/guide/observability/) — inspect delegated activity alongside other agent work.
