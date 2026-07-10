---
title: Sandboxes
description: Give agents a workspace for files and command-driven work.
lastReviewedAt: 2026-07-10
---

Sandboxes give an agent a workspace to read, write, and run commands in while it works. Use them when an agent needs to operate on files or run commands, rather than only respond to prompts or call application-defined [tools](/docs/guide/tools/).

Flue provides a lightweight virtual sandbox by default. Use a local sandbox when a trusted Node.js agent should operate directly on its host machine, or a remote sandbox when work needs an isolated environment with its own tooling and lifecycle.

## Virtual sandbox

By default, an initialized agent works in a virtual sandbox unless you configure another environment. The virtual sandbox is a lightweight, in-memory workspace powered by [just-bash](https://justbash.dev/). It is the right starting point when your application can provide the files the agent needs.

For example, a [harness tool](/docs/guide/tools/#harness-tools) can stage an input document, let the agent work on it, and retrieve an output file:

```ts title="src/shared/review-tools.ts"
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

export const reviewDocument = defineTool({
  name: 'review_document',
  description: 'Review one supplied document and report findings.',
  input: v.object({ document: v.string() }),
  harness: true,

  async run({ harness, data }) {
    await harness.sandbox.writeFile('document.md', data.document);
    await harness.prompt('Review document.md and write your findings to review.md.');
    return { review: await harness.sandbox.readFile('review.md') };
  },
});
```

Configure the agent that mounts this tool with `cwd: '/workspace'` and no `useSandbox()` call: omitting it selects the virtual sandbox, and `cwd` sets the working directory, so these relative file paths resolve below `/workspace`. The agent can use built-in file and command capabilities in that workspace, while application code uses `harness.sandbox` to provide inputs and retrieve results.

The virtual sandbox starts without your application files or host filesystem, and its files do not persist beyond its in-memory lifetime. Its command environment is suitable for lightweight workspace work, not an arbitrary Linux toolchain. It is also not a network isolation boundary: current generated runtimes permit network access from the virtual sandbox.

## Local sandbox

On the Node.js target, use `local()` when an agent should operate directly on the host filesystem and shell. This is useful for trusted development tools or disposable CI runners working against an existing checkout:

```ts title="src/agents/repository-reviewer.ts"
'use agent';
import { defineAgent, useModel, useSandbox } from '@flue/runtime';
import { local } from '@flue/runtime/node';

function RepositoryReviewer() {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox(local(), { cwd: '/srv/checkouts/catalog-service' });
  return 'Inspect the requested change and run only relevant validation.';
}

export default defineAgent(RepositoryReviewer);
```

`local()` makes host files and installed commands reachable through the agent's workspace capabilities. It does not provide isolation between model-directed work and the host machine.

Host environment variables are deliberately limited by default. If a command requires an additional value, expose it explicitly through `local({ env: { ... } })`. Avoid giving a model-directed shell broad credentials when a narrow application [tool](/docs/guide/tools/) can perform the required action instead.

Use `local()` only where the host and input are already trusted for this level of access. Do not use it as an isolation boundary for untrusted requests or multiple tenants.

## Remote sandboxes

Use a remote sandbox when agent work needs an environment that should not run on the application host: for example, untrusted or tenant-specific tasks, coding work that requires a Linux toolchain, or workspaces that need provider-managed lifetime and storage.

A remote sandbox is supplied through an integration appropriate to the provider or platform. Your application is responsible for deciding which workspace belongs to which agent conversation, what credentials and network access it receives, whether it may be reused, and when it is deleted or expired.

See the Ecosystem **Sandboxes** integrations, such as [Daytona](/docs/ecosystem/sandboxes/daytona/), to connect a provider-managed remote sandbox. If you need to implement an integration, see the [Sandbox Adapter API](/docs/api/sandbox-api/).

Cloudflare deployments can use [Cloudflare Sandbox](/docs/ecosystem/sandboxes/cloudflare/) for a native container-backed Linux sandbox. Use it when an agent deployed on Cloudflare needs tools such as git, package installation, or native commands; its setup and lifecycle details belong in the integration guide.

A sandbox integration may expose different model-facing capabilities than the virtual and local sandboxes. Check the integration documentation before assuming ordinary file or command tools are available.

## Conditional attachment

An agent can start in the virtual sandbox and attach a real environment only when a condition is met — a support agent that answers most requests directly, say, and provisions a workspace only for conversations that need hands-on investigation:

```ts title="src/agents/support-desk.ts"
'use agent';
import { env } from 'cloudflare:workers';
import { type AgentProps, defineAgent, useModel, usePersistentState, useSandbox, useTool } from '@flue/runtime';
import { cloudflareSandbox } from '@flue/runtime/cloudflare';
import { getSandbox } from '@cloudflare/sandbox';

interface Env {
  Sandbox: DurableObjectNamespace;
}

function SupportDesk({ id }: AgentProps) {
  useModel('anthropic/claude-sonnet-4-6');
  const [sandboxEnabled, setSandboxEnabled] = usePersistentState('sandboxEnabled', false);

  const { Sandbox } = env as unknown as Env;
  if (sandboxEnabled) useSandbox(cloudflareSandbox(getSandbox(Sandbox, id)), { cwd: '/workspace' });

  useTool({
    name: 'enable_sandbox',
    description: 'Call when a request needs hands-on investigation.',
    run: () => {
      setSandboxEnabled(true);
      return 'Workspace enabled — it is attached as of your next step.';
    },
  });

  return 'Answer support requests directly when you can. For anything needing real investigation, call enable_sandbox first.';
}

export default defineAgent(SupportDesk);
```

The swap lands at the next turn boundary: the model calls `enable_sandbox`, and by its very next step the workspace is attached — same response, no extra round-trip. The runtime announces every swap to the model with a single `environment` signal that restates the complete current state (working directory, tools, skills, agents), so the agent always knows exactly what it has after the ground moved (see [Dynamic resources](/docs/api/agent-api/#dynamic-resources)). Persistent state replays durably, so every later submission re-evaluates the same condition and re-attaches the same declaration; sandbox adapters key their durable resources on the agent's instance id, so the agent gets the same workspace back each time.

Detaching works the same way: when the condition clears, the next turn boundary returns the agent to a **fresh** default virtual sandbox. Files in the detached environment follow that environment's own lifecycle — nothing carries over, and nothing from before the attach is restored. Swapping one sandbox for another is also possible and equally unguarded, with one nuance: the runtime observes only *presence*, so replacing sandbox A with sandbox B while staying attached takes effect at the next submission rather than the next turn. If your agent changes environments, you own keeping its behavior coherent about where its files went — the runtime will tell the model, but it won't stop you.

## Persistence and security

The sandbox controls workspace and command access. It does not determine whether a session retains conversation history. Keep these decisions separate:

| Decision                                                            | Controlled by                                                         |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Conversation history available in a later agent interaction         | Canonical conversation persistence via `db.ts` or the target default. |
| Files, installed packages, and generated artifacts available later  | The sandbox or workspace lifecycle you choose.                        |
| Access to repositories, APIs, credentials, and network destinations | The sandbox environment, tools, and application authorization policy. |

A persisted agent conversation does not make the virtual sandbox durable. Likewise, a durable remote workspace does not by itself preserve conversation history.

Choose the narrowest sandbox that supports the task. Expanding the environment expands what model-directed work can read, change, execute, and reach.

## Next steps

- [Agents](/docs/guide/building-agents/) — configure continuing agents that work inside a sandbox.
- [Tools](/docs/guide/tools/) — expose bounded application capabilities, including harness tools that stage files and collect artifacts, separately from workspace access.
- [Skills](/docs/guide/skills/) — bundle procedures or provide workspace-discovered skills.
- [Sandbox Adapter API](/docs/api/sandbox-api/) — implement a provider-backed sandbox integration.
- [Daytona](/docs/ecosystem/sandboxes/daytona/) and [Cloudflare Sandbox](/docs/ecosystem/sandboxes/cloudflare/) — configure remote sandbox integrations.
