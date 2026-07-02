---
title: Migration Guide
description: Move a pre-redesign Flue project to the Vite plugin, explicit routing, and conversation-URL clients.
lastReviewedAt: 2026-07-02
---

This release changes how you hold Flue. The framework is now a [Vite plugin](/docs/guide/vite-plugin/), routes are [mounted explicitly in `app.ts`](/docs/guide/routing/), agents join the application through the [`'use agent'` directive](/docs/guide/use-agent/), workflows are removed in favor of agents with actions, and clients address a conversation by URL.

This is a hard break — the removed APIs are deleted, not deprecated, and there are no compatibility shims. This page is the single pointer for all of it.

## A project's diff, at a glance

```diff
  flue.config.ts                            # survives (target stays; root/output/vite-export removed)

+ vite.config.ts                            # flue() [+ cloudflare()] — vite dev/build own the app
+ package.json: "dev": "vite dev", "build": "vite build"   # was flue dev / flue build

  src/agents/triage.ts                      # ONE line added; interface otherwise unchanged
+   'use agent';
    export default defineAgent(...)
    export const route = authMiddleware;    # named exports keep their meanings

+ src/app.ts                                # now the ONLY required file — app.ts IS the route map
+   app.route('/agents/triage', triage.route());
+   app.route('/channels/slack', slack.route());

- src/workflows/daily.ts                    # defineWorkflow({ agent, run })
+ src/agents/daily.ts                       # an agent with the action model-callable
+   'use agent';
+   export default defineAgent(() => ({ model, instructions, actions: [dailyAction] }));

- flue run daily --input '{...}'            # deterministic entry: no v1 replacement (deferred)
+ flue run src/agents/daily.ts --message "Run the daily triage" [--id daily-2026-07-02]
```

SDK and React addressing collapse to the conversation URL:

```diff
- const client = createFlueClient({ baseUrl: 'https://api.example.com' });
- await client.agents.prompt('triage', 'ticket-42', { message: '...' });
+ const convo = createFlueClient({ url: 'https://api.example.com/agents/triage/ticket-42' });
+ await convo.send({ message: { kind: 'user', body: '...' } });

- useFlueAgent({ name: 'triage', id: 'ticket-42' })
+ useFlueAgent({ url: '/api/agents/triage/ticket-42' })
```

Everything else about the agent file — `defineAgent(...)`, actions, tools, skills, sandboxes, subagents, `db.ts`, `cloudflare.ts` — is unchanged.

## Removed API

| Removed                                                                                          | Replacement                                                                                                                    |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `flue dev`                                                                                       | `vite dev` with `flue()` in `vite.config.ts`. See [Vite plugin](/docs/guide/vite-plugin/).                                     |
| `flue build`                                                                                     | `vite build`.                                                                                                                  |
| `vite preview` equivalent (Node)                                                                 | Supported — preview serves the built `dist/app.mjs`. Cloudflare preview comes from `@cloudflare/vite-plugin`.                  |
| `flue run <name> --input '{...}'`                                                                | `flue run <path> --message "..."` — a module path, a message, an optional `--id`. See [flue run](/docs/cli/run/).              |
| `flue run` flags `--server`, `--header`, `--target`, `--root`, `--output`, `--config`, `--input` | Removed. `flue run` is transport-free and Node-local; it reads `flue.config.ts` directly.                                      |
| File-based routing (`src/agents/*`, `src/workflows/*`, `src/channels/*` conventions)             | The `'use agent'` scan registers agents; `app.ts` mounts every route explicitly.                                               |
| The runtime `flue()` router and `createDefaultFlueApp()` (`@flue/runtime/routing`)               | Mount `agent.route()` / `channel.route()` per route in `app.ts`. A missing `app.ts` is now a build error.                      |
| `defineWorkflow()`, `invoke()`, all workflow/run types and errors                                | An agent with the work in `actions[]`. See the recipe below.                                                                   |
| `POST /workflows/:name`, `/runs/:runId` routes, workflow `route`/`runs` exports                  | Removed with workflows. Conversations are the only durable unit.                                                               |
| `listRuns()`, `getRun()`                                                                         | Removed with workflows.                                                                                                        |
| `listAgents()`                                                                                   | Removed with the router. A replacement agent manifest is explicitly out of scope for now.                                      |
| SDK `client.agents` / `client.workflows` / `client.runs` namespaces                              | `createFlueClient({ url })` — one client per conversation with `send`, `wait`, `abort`, `history`, `observe`, `attachmentUrl`. |
| React `FlueProvider`, `useFlueClient()`                                                          | None needed — `useFlueAgent({ url })` creates its own client, or pass a memoized `client` for custom auth.                     |
| React `useFlueWorkflow()`                                                                        | Removed with workflows. Observe an agent conversation instead.                                                                 |
| `defineConfig` from `@flue/cli/config`                                                           | `defineConfig` from `@flue/runtime/config`.                                                                                    |
| `flue.config.ts` fields `root`, `output`; the named `vite` export                                | Removed. Vite owns the project root and output; native Vite config lives in `vite.config.ts`.                                  |

## Adopt the Vite plugin

1. Install the plugin and Vite:

   ```bash
   npm install --save-dev @flue/vite vite
   # Cloudflare target only:
   npm install --save-dev @cloudflare/vite-plugin
   ```

2. Create `vite.config.ts` (`flue()` must precede `cloudflare()`):

   ```ts title="vite.config.ts"
   import { flue } from '@flue/vite';
   import { defineConfig } from 'vite';

   export default defineConfig({
     plugins: [flue()],
   });
   ```

3. Update `package.json` scripts: `"dev": "vite dev"`, `"build": "vite build"`.

4. Update `flue.config.ts`: change the `defineConfig` import to `@flue/runtime/config`, and delete `root`, `output`, and any named `vite` export. `target` may stay or go — the plugin auto-detects Cloudflare from the plugin array.

## Mark and mount your agents

Add `'use agent'` as the first line of every agent module, then mount each one in `app.ts` (create it if the project didn't have one):

```ts title="src/app.ts"
import { Hono } from 'hono';
import triage from './agents/triage.ts';
import { channel as slack } from './channels/slack.ts';

const app = new Hono();

app.route('/agents/triage', triage.route());
app.route('/channels/slack', slack.route());

export default app;
```

Mounting at `/agents/<file-basename>` and `/channels/<file-basename>` preserves your deployment's previous URLs exactly. If the old app mounted `flue()` beneath a prefix, put the prefix in the mount paths (`/api/agents/triage`). Agents used only via `dispatch(...)` need the directive but no mount. Middleware moves from the old router paths to plain Hono `app.use(...)` plus the unchanged per-module `route` export; see [Routing](/docs/guide/routing/).

## Convert each workflow to an agent with an action

A workflow was already an agent plus a finite operation. Move the operation into a `defineAction(...)` on the agent, and make the file an agent module:

```ts title="Before: src/workflows/daily.ts"
import { defineAgent, defineWorkflow } from '@flue/runtime';
import { dailyReport } from '../actions/daily-report.ts';

export default defineWorkflow({
  agent: defineAgent(() => ({ model: 'anthropic/claude-haiku-4-5' })),
  action: dailyReport,
});
```

```ts title="After: src/agents/daily.ts"
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

The action machinery is unchanged — the model calls it as a framework-managed tool with validated input and output. Drive it through any agent entry point:

- `flue run src/agents/daily.ts --message "Run the daily report" --id daily-2026-07-02` for CLI and CI jobs (a caller-chosen `--id` gives each occurrence — or each day — its own conversation);
- `dispatch(daily, { id, message })` from schedules, webhooks, and application code (this replaces ambient `invoke()`);
- the mounted route or SDK client, when it should be HTTP-invocable.

A run's record is now its conversation: read it with the conversation URL client (`history()`, `observe()`) instead of `/runs/:runId`.

**No code-first deterministic entry in v1.** `defineWorkflow` with a `run(...)` function was also a way to execute authored TypeScript steps without a model turn. That capability has **no v1 replacement** — it is deferred, not relocated. `flue run --message` and `dispatch(...)` both deliver a message to the model, which then calls your action. If you need application code to drive a harness with no model in the loop, keep that logic in ordinary application code for now.

## Cloudflare storage migration

Two wrangler changes for previously deployed Workers:

1. **Delete the workflow-era classes.** Per-run workflow Durable Objects and Flue's `FlueRegistry` run-index Durable Object no longer exist. Append a migration deleting every generated `Flue<Name>Workflow` class and `FlueRegistry`:

   ```jsonc title="wrangler.jsonc"
   {
     "migrations": [
       // ...existing history...
       {
         "tag": "v3-remove-workflows",
         "deleted_classes": ["FlueRegistry", "FlueTranslateWorkflow"],
       },
     ],
   }
   ```

   Deleting a class deletes its stored data — for workflows that is run history, which has no equivalent in the new model.

2. **Check agent class names.** Agent Durable Object class names now derive from `'use agent'` file basenames. If a converted module keeps its basename (`support-chat.ts` → `FlueSupportChatAgent`), the class name — and every existing conversation — is unchanged. If you renamed files during the migration (for example `workflows/daily.ts` → `agents/daily.ts` is a _new_ agent class, while renaming `agents/support.ts` → `agents/support-chat.ts` is a rename), express renames with `renamed_classes` and new classes with `new_sqlite_classes`.

Also add the generated files to `.gitignore`: `.flue-vite/` and `.flue-vite.wrangler.jsonc`. Your authored `wrangler.jsonc` stays the single source of migration history. See [Vite plugin](/docs/guide/vite-plugin/#migrations-the-triple-for-adding-an-agent).

## Update SDK and React clients

One client per conversation, addressed by URL — the mount URL from your `app.ts` plus the caller-chosen conversation id:

```ts
import { createFlueClient } from '@flue/sdk';

const convo = createFlueClient({ url: 'https://api.example.com/agents/triage/ticket-42' });

const admission = await convo.send({ message: { kind: 'user', body: 'Summarize this ticket.' } });
await convo.wait(admission); // completion (throws on failed/aborted)
const snapshot = await convo.history(); // the reply, from the conversation
convo.observe(); // history catch-up + live updates
await convo.abort();
```

Starting a new conversation is constructing a client with a fresh id appended to the mount URL. `headers`, `token`, and `fetch` options carry over unchanged. In React, replace `FlueProvider` + `useFlueAgent({ name, id })` with `useFlueAgent({ url })`; see [React](/docs/guide/react/).

## Verify the migration

- `vite dev` serves the app and streams a conversation; `vite build && node dist/server.mjs` serves the built artifact (Node).
- `flue run src/agents/<name>.ts --message "..."` streams activity and prints the reply without binding a port.
- On Cloudflare, `vite build` produces a deployable Worker and `wrangler` accepts the migration history.
- Any remaining `defineWorkflow` / `invoke` / `client.workflows` reference fails at build or type-check time — that is the deletion working as intended.
