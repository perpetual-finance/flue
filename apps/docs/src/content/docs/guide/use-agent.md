---
title: "'use agent'"
description: The module directive that marks agent functions for the build scan and gives each its durable identity.
lastReviewedAt: 2026-07-11
---

An agent joins a Flue application with one line — the `'use agent'` directive at the top of its module:

```ts title="src/agents/triage.ts"
'use agent';
import { useModel } from '@flue/runtime';

export function Triage() {
  useModel('anthropic/claude-sonnet-4-6');
  return 'Triage the incoming issue and propose next steps.';
}
```

Like `'use strict'`, it is an ECMAScript module directive: a string literal in the directive prologue, before any imports or statements. The [Vite plugin](/docs/guide/vite-plugin/) detects it by parsing, not by pattern-matching, so comments and string contents elsewhere in the file can never trigger it.

The directive does three jobs.

## 1. Marking agents: the capitalized-function rule

**The agent is the function.** In a marked module, every **exported function with a capitalized name** is an agent — the React convention (capitalized = component, `use`-prefixed = hook), applied to agents. Function declarations and `const` arrow/function expressions both count; classes never do. Lowercase exports are ordinary helpers:

```ts title="src/agents/support.ts"
'use agent';
import { useModel } from '@flue/runtime';

// An agent: exported, capitalized.
export function SupportFollowup() {
  useModel('anthropic/claude-sonnet-4-6');
  return 'Draft the follow-up reply for a resolved case.';
}

// Another agent — multiple agents per file are fine.
export function SupportEscalation() {
  useModel('anthropic/claude-opus-4-6');
  return 'Assess whether this case needs a specialist.';
}

// A helper: lowercase, invisible to the scan.
export function formatCaseLink(id: string) {
  return `https://support.example.com/cases/${id}`;
}
```

Two shapes are build errors, because they can only be mistakes:

- **A marked module with zero agent exports** — a directive with nothing to register.
- **An anonymous default-exported function** — no name means no identity. Name it (`export default function Triage() {}` participates by the same rule).

Re-export statements (`export { X } from './other.ts'`, `export *`) never register an agent: registration happens where the function is defined.

## 2. Identity

Each agent's **identity** is the slug that keys durable storage. It resolves from the function itself:

1. the `agentName` static, when assigned;
2. else the exported function's name.

```ts title="src/agents/triage.ts"
'use agent';

export function IssueTriage() {
  // ...
}

// Optional: decouple the durable identity from the function name.
IssueTriage.agentName = 'issue-triage';
```

The override must be a top-level plain string-literal assignment — build targets derive Durable Object class and binding names from the identity before any code runs, so a computed or conditional `agentName` is a build error. PascalCase function names (`IssueTriage`) and lower-kebab-case overrides (`issue-triage`) are both valid identities, and identities must be **unique among an application's agents** (a duplicate is a build error).

Identity — not the mount path, and not the file path — keys durable storage:

- on **Node**, conversation streams are stored under the identity slug;
- on **Cloudflare**, the identity names the generated Durable Object class (`IssueTriage` → `FlueIssueTriageAgent`) and binding (`FLUE_ISSUE_TRIAGE_AGENT`).

That split gives renames precise semantics:

| Change                          | Effect                                                                                                                                                                                                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Re-mounting at a different URL  | Nothing durable changes. The same conversations are reachable at the new path. Mounting at two URLs serves the same conversations.                                                                                                                                                |
| Renaming or moving the **file** | Nothing durable changes — identity does not derive from the filename.                                                                                                                                                                                                             |
| Renaming the **function**       | A storage-identity change — unless `agentName` pins the identity, in which case the function renames freely. Without the pin: on Cloudflare, express the change with wrangler-native `renamed_classes` to keep existing conversations; on Node, the storage key changes with the identity. |
| Editing an `agentName` pin      | A storage-identity change, same as above.                                                                                                                                                                                                                                          |

Unlike a filename, a function rename is visible in every diff that touches a call site — and it is lintable. Teams that want the identity always explicit can enforce `agentName` on every agent with a lint rule; Flue does not require it.

Because bundlers rename identifiers, the build transform stamps each agent's identity as a **string literal** at build time, so a minified production bundle keeps the durable identity intact. In plugin-less contexts (`flue run`, unit tests, `start()` scripts) the identity is read off the function directly (`agentName`, else `fn.name`), where no minifier runs.

## 3. Registration: the scan is the registry

The set of agent functions found by the build **is** the application's agent set, on both targets — keyed by (file, export). The generated bootstrap imports and registers every scanned agent; Cloudflare additionally emits one Durable Object class per agent (a file with several agents produces several classes). Consequences:

- **Mounting registers nothing.** [`createAgentRouter()`](/docs/guide/routing/) is a pure router factory over an already-registered agent.
- **Dispatch-only agents work unmounted.** Being scanned is enough for `dispatch(...)` to reach them.
- **An unmarked file is invisible.** A module without the directive is ordinary application code — its exported functions register nothing.

### What the scan covers

The scan is a directory glob over the [source root](/docs/guide/project-layout/#source-directory) — every `.ts`, `.mts`, `.js`, and `.mjs` file, recursively, skipping `node_modules`, build output, and Flue's generated directories — filtered to files whose directive prologue contains `'use agent'`. Agent files can live anywhere under the source root; `src/agents/` is a convention, not a rule.

To narrow the scan, set the `agents` glob in [`flue.config.ts`](/docs/reference/configuration/#agents):

```ts title="flue.config.ts"
import { defineConfig } from '@flue/runtime/config';

export default defineConfig({
  agents: 'agents/**/*.ts',
});
```

In development the scan stays live: creating or deleting a marked module, or adding and removing agent exports, updates the registered set (and, on Cloudflare, the generated entry and wrangler config) without a manual restart. Remember that on Cloudflare a _new_ agent still needs its user-authored migration entry — see [the triple](/docs/guide/vite-plugin/#migrations-the-triple-for-adding-an-agent).

## What is not in the module anymore

Everything the agent *does* is composed inside the function with hooks; everything the platform needs *without running the function* rides as a static on it. The old supervisor-facing module exports are gone:

| Old module export    | Now                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `name`               | The `agentName` static (or just the function name).                                                                                      |
| `initialDataSchema`  | The `initialData` static: `Fn.initialData = v.object({...})` — validated at admission, before anything durable exists.                   |
| `route` (middleware) | Plain Hono composition at the mount: `app.use('/agents/triage/*', auth)`. See [Routing](/docs/guide/routing/).                           |
| `durability`         | Binding policy — the runner decides: `createAgentRouter(fn, { durability })`, a `start()` entry, or `flue run --max-attempts/--timeout`. |
| `description`        | Deleted, no replacement.                                                                                                                  |

```ts title="src/agents/triage.ts"
'use agent';
import * as v from 'valibot';
import { useModel } from '@flue/runtime';

export function IssueTriage() {
  useModel('anthropic/claude-opus-4-6');
  return 'Triage the bound issue.';
}
IssueTriage.agentName = 'issue-triage'; // optional — identity defaults to 'IssueTriage'
IssueTriage.initialData = v.object({ issue: v.pipe(v.number(), v.integer()) });
```

## Where the directive is not required

The directive is how an agent joins an _application_. Two consumers work without it:

- **`flue run <path>`** executes one agent module directly, selecting among its exported agents (`--agent <ExportName>` when there are several) and resolving identity from the function itself. See [flue run](/docs/cli/run/).
- **Unit tests and scripts** can pass a plain agent function to `start()` / `init()` without any build step. See [Scripts](/docs/guide/scripts/).

## Next steps

- [Routing](/docs/guide/routing/) — mount registered agents in `app.ts` with `createAgentRouter()`.
- [Vite plugin](/docs/guide/vite-plugin/) — the scan, transform, and generated bootstrap.
- [Agents](/docs/guide/building-agents/) — everything inside the agent function.
