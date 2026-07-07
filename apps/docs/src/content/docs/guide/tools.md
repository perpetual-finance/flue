---
title: Tools
description: Give agents application capabilities through custom tools and MCP servers.
lastReviewedAt: 2026-07-07
---

Tools let an agent retrieve information or perform actions while it works. Define tools when an agent needs to call your application's data layer or services, such as looking up an order, creating a ticket, or approving a request.

A [skill](/docs/guide/skills/) provides reusable instructions; a tool executes application code. File and command access in an agent's workspace comes from its configured [sandbox](/docs/guide/sandboxes/) rather than from a custom application tool.

## Custom tools

Use `defineTool(...)` to create a new tool:

```ts title="src/shared/order-tools.ts"
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

const orderStatuses = new Map([
  ['order_1042', 'packed'],
  ['order_1043', 'shipped'],
]);

export const lookupOrderStatus = defineTool({
  name: 'lookup_order_status',
  description: 'Look up the current fulfillment status for one order ID.',
  input: v.object({
    orderId: v.pipe(v.string(), v.description('Order ID in the form order_1234')),
  }),
  output: v.object({
    status: v.nullable(v.string()),
  }),
  async run({ data, signal }) {
    const status = orderStatuses.get(data.orderId) ?? null;
    return { status };
  },
});
```

A custom tool has these parts:

- `name` is the model-facing name used to call the tool.
- `description` helps the model decide when the capability is appropriate.
- `input` is an optional top-level [Valibot](https://valibot.dev) object schema for model-supplied input. Flue validates and parses it before `run`; when validation fails, the model receives a tool error and can retry.
- `output` is an optional Valibot schema for typed structured output. Flue validates the result, snapshots it as JSON-compatible data, and JSON-stringifies it for the model.
- `run({ data, log, signal })` performs the application-controlled work. `data` is the call's arguments parsed by the `input` schema, available when the schema is declared; `log` records structured progress (see [Observability](/docs/guide/observability/)); and `signal` can cancel downstream work. Without an `output` schema, return JSON-compatible data; returning `undefined` sends `null` to the model.

Use clear action-oriented names, such as `lookup_order_status` or `create_support_ticket`. Tools active in the same render must have distinct names.

## Using tools

Mount a tool with `useTool(...)` inside the agent function:

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

When this agent receives a request, the model can call `lookup_order_status` if it needs the current status before composing its answer. The call and returned text become part of the session context so the agent can continue working with the result.

`useTool(...)` accepts a `defineTool(...)` value or an inline definition object — either way the tool joins the render's flat tool set. When a tool is needed for only one bounded call, you can instead provide it in the options for `session.prompt(...)`, `session.skill(...)`, or `session.task(...)`; see the [Agent API](/docs/api/agent-api/).

## Harness tools

A tool needs `harness: true` when it must drive the agent's own runtime — start a scoped model call, run a shell command, or read and write the sandbox filesystem — rather than being a pure function of its input. `run` then receives `harness`: the same surface the agent's own session uses (`harness.session()`, `harness.shell()`, `harness.fs`).

```ts title="src/shared/review-tools.ts"
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

export const reviewChange = defineTool({
  name: 'review_change',
  description: 'Have a scoped model call assess one proposed change.',
  input: v.object({ change: v.string() }),
  harness: true,
  async run({ harness, data }) {
    const session = await harness.session();
    const response = await session.prompt(`Review this change:\n\n${data.change}`);
    return response.text;
  },
});
```

Mount it like any other tool with `useTool(reviewChange)`. Harness invocations are scoped to the tool call, count against the delegation-depth cap, and retain any child conversations they open — the same accounting a delegated [subagent](/docs/guide/subagents/) uses. Tools without `harness` cannot reach the runtime; keep them pure functions of their input.

## Protect access

A tool's parameters are model-selected inputs, not an authorization boundary. Your application should decide which customer, account, repository, or credential a tool can use, then let the model select only values within that boundary.

For an agent that receives dispatched, per-customer events — a support-system webhook, a chat platform message — carry the authorized identifier your application already validated in the delivered signal's `attributes`, and read it with `useDelivery()` rather than trusting a model-supplied value:

```ts title="src/agents/customer-orders.ts"
'use agent';
import { defineAgent, useDelivery, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { orders } from '../shared/orders.ts';

function CustomerOrders() {
  const delivery = useDelivery();
  const customerId = delivery.kind === 'signal' ? delivery.attributes?.customerId : undefined;

  useTool({
    name: 'lookup_customer_order',
    description: 'Look up one order belonging to this customer.',
    input: v.object({ orderId: v.string() }),
    async run({ data }) {
      const status = customerId ? await orders.getStatus(customerId, data.orderId) : undefined;
      return status ?? 'No accessible order was found.';
    },
  });

  return 'Help this customer check the status of their orders.';
}

export default defineAgent(CustomerOrders, { model: 'anthropic/claude-haiku-4-5' });
```

In this example, the model may choose an order ID to look up, but it cannot choose the customer used in the query — `customerId` comes from the delivered signal's `attributes`, set by the trusted code that called `dispatch(...)`. Your route or dispatching code must still verify the caller before attaching that identifier; see [Agents](/docs/guide/building-agents/) and [Routing](/docs/guide/routing/).

The same principle applies inside a [harness tool](#harness-tools): a value trusted code supplies (from `attributes`, a closure, or configuration) establishes the boundary, and the model's input only selects within it.

## Use provider SDKs directly

Channel integrations follow the same rule. Flue verifies inbound provider
events, while your application uses the provider SDK and defines only the
outbound tools its agents need:

```ts title="src/channels/github.ts"
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
    input: v.object({
      body: v.string(),
    }),
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

The model controls the comment body. Trusted application code controls the
token, repository, and issue — mount the result with `useTool(commentOnIssue(ref))`
the same way as any other tool. Avoid generic provider tools that expose
arbitrary destinations or API methods unless the application has an explicit
authorization design for them.

## Connect MCP servers

An MCP server supplies remotely implemented tools. `connectMcpServer(...)` lists those tools and returns ordinary tool definitions, which you mount the same way as your own custom tools:

```ts title="src/agents/inventory-assistant.ts"
'use agent';
import { connectMcpServer, defineAgent, useTool } from '@flue/runtime';

const inventory = await connectMcpServer('inventory', {
  url: process.env.INVENTORY_MCP_URL!,
  headers: { Authorization: `Bearer ${process.env.INVENTORY_MCP_TOKEN}` },
});

function InventoryAssistant() {
  for (const tool of inventory.tools) useTool(tool);
  return 'Answer inventory questions using the inventory tools.';
}

export default defineAgent(InventoryAssistant, { model: 'anthropic/claude-haiku-4-5' });
```

`inventory.tools` is a fixed array resolved once when the module loads, so looping over it mounts the same tools in the same order on every render — the same structural guarantee any other hook call needs. Flue prefixes each MCP tool's model-facing name with its connection name; for example, `lookup_item` from this server becomes `mcp__inventory__lookup_item`.

Provide MCP credentials and connection settings from trusted application code and close the connection during application shutdown.

## When to use a tool

Tools are most useful when:

- a model needs to read or update application data;
- an agent needs a narrow interface to an API or service;
- trusted application code must control credentials, authorization scope, or destinations;
- the model should decide whether and when to call a bounded function.

Add `harness: true` when the tool itself needs to drive the runtime — a scoped model call, a shell command, or sandbox file access. For reusable instructions and resources, use a [skill](/docs/guide/skills/).

## Next steps

- [Agents](/docs/guide/building-agents/) — configure continuing agents that use tools.
- [Skills](/docs/guide/skills/) — add reusable instructions that may direct an agent to use its tools.
- [Sandboxes](/docs/guide/sandboxes/) — control the workspace and command boundary available to agent work.
- [Subagents](/docs/guide/subagents/) — delegate focused work instead of driving it from a tool.
- [Agent API](/docs/api/agent-api/) — look up operation options, including tools supplied for one call.
