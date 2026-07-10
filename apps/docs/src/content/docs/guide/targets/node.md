---
title: Node.js
description: Understand the Node.js-specific runtime behavior and APIs for Flue applications.
lastReviewedAt: 2026-07-02
---

The Node.js target builds your agents as a standard Node.js server. The built server runs anywhere Node runs: a local machine, a container, a VM, a CI runner, or a managed hosting service. Node is also the target where agents can operate directly on the host filesystem and shell through `local()`.

For a deployment walkthrough, see [Deploy Agents on Node.js](/docs/ecosystem/deploy/node/). To run agents on a cron schedule, see [Schedules](/docs/guide/schedules/).

## The built server

The [Vite plugin](/docs/guide/vite-plugin/) builds your application — the `app.ts` route map plus every scanned [`'use agent'`](/docs/guide/use-agent/) module — into a self-starting server entry at `dist/server.mjs` (plus the non-listening `dist/app.mjs` chunk it imports, which `vite preview` serves):

```bash
vite build
node dist/server.mjs
```

The server owns HTTP for whatever `app.ts` mounts, agent dispatch, and durable conversation streaming. It listens on port `3000` by default; set `PORT` to change it.

During development, `vite dev` serves the same application on Vite's dev server (default port `5173`) with reload on changes. `vite preview` serves the built artifact with production behavior.

The build externalizes your application dependencies rather than bundling them. Deploy the built artifact alongside its `node_modules`, or package it inside a container that installs dependencies first.

## State and durability

Without `db.ts`, the Node server uses process-local in-memory SQLite for canonical agent conversations and accepted submissions. This gives one running process ordered state handling, but a restart loses that state.

With a durable adapter, direct prompts and `dispatch(...)` inputs enter the same persisted per-conversation queue. Inputs for one agent conversation are processed in accepted order, and a replacement process can recover canonical conversation progress and interrupted submissions.

Node requires one live process to own a given agent conversation. A shared database supports process or host replacement, but does not make active-active ownership or round-robin routing for the same conversation safe. Multi-replica deployments must route each conversation to one owner and avoid overlapping owners during replacement.

Node does not get Cloudflare's automatic Durable Object wake or Fiber recovery. A replacement process must start successfully before startup reconciliation runs, and the coordinator periodically scans expired leases so work stranded by a fast restart is eventually reclaimed.

See [Database](/docs/guide/database/) for `db.ts`, SQLite, Postgres, and custom adapters. See [Durable Agents](/docs/concepts/durable-execution/) for recovery behavior.

## `local()` sandbox

Node is the only target with the built-in `local()` sandbox factory. It gives an agent direct access to the host filesystem and shell, making it useful for development tools, CI tasks, coding agents, and self-hosted automation where the host environment already provides isolation.

```ts title="src/agents/repository-reviewer.ts"
'use agent';
import { defineAgent, useModel, useSandbox } from '@flue/runtime';
import { local } from '@flue/runtime/node';

function RepositoryReviewer() {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox(local());
}

export default defineAgent(RepositoryReviewer);
```

`local()` uses `process.cwd()` as the working directory by default. Shell commands run through the host shell via `child_process`, and file operations read and write the real filesystem.

Only shell-essential environment variables are exposed to the agent's shell by default. API keys, tokens, and credentials are deliberately excluded. Pass specific values through `env` when a command needs them:

```ts
function RepositoryReviewer() {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox(
    local({
      env: { GH_TOKEN: process.env.GH_TOKEN },
    }),
  );
}

const reviewer = defineAgent(RepositoryReviewer);
```

Passing `env: { ...process.env }` exposes the full host environment to the model's shell. Do this only in trusted environments.

## Remote sandboxes

When agent work needs per-session isolation, a Linux toolchain, or a provider-managed environment, use a remote sandbox adapter instead of `local()`. Remote sandboxes run on external infrastructure and connect through the [Sandbox Adapter API](/docs/api/sandbox-api/).

See the Ecosystem [Sandboxes](/docs/ecosystem/#sandboxes) catalog for available integrations, including [Daytona](/docs/ecosystem/sandboxes/daytona/), [E2B](/docs/ecosystem/sandboxes/e2b/), and [Modal](/docs/ecosystem/sandboxes/modal/).

## Environment and secrets

Local development loads your project's `.env` files automatically, with shell-exported values taking precedence:

- [`flue run`](/docs/cli/run/) loads the project-root `.env`; use `--env <path>` to select one alternate file.
- `vite dev` loads Vite's standard file set from the project root: `.env`, `.env.local`, `.env.<mode>`, and `.env.<mode>.local`.

The built server is different: `node dist/server.mjs` reads only the environment supplied when it starts, because deployed environments own their configuration:

```bash
# Production
set -a; source .env; set +a
node dist/server.mjs
```

Use the environment variable name your provider expects, such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Do not commit `.env` files.

## Reference

### `local(...)`

```ts
import { local } from '@flue/runtime/node';

function local(options?: LocalSandboxOptions): SandboxFactory;
```

Creates a sandbox factory that binds directly to the host filesystem and shell. Pass it to `defineAgent(...)` through the `sandbox` option.

**`LocalSandboxOptions`:**

- `cwd` — working directory. Defaults to `process.cwd()`.
- `env` — additional environment variables layered on top of the default shell-essential allowlist. Set a key to `undefined` to remove a default. Per-exec `env` in shell calls layers on top of this.

The environment snapshot is taken once at sandbox construction. Later mutations to `process.env` are not reflected.

### `sqlite(...)`

```ts
import { sqlite } from '@flue/runtime/node';

function sqlite(path?: string): PersistenceAdapter;
```

Creates the built-in Node SQLite persistence adapter. Omit `path` for in-memory storage, or pass a file path for persistence across process restarts.
