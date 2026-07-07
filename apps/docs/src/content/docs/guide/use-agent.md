---
title: "'use agent'"
description: The module directive that gives an agent its identity and registers it with the application.
lastReviewedAt: 2026-07-02
---

An agent joins a Flue application with one line — the `'use agent'` directive at the top of its module:

```ts title="src/agents/triage.ts"
'use agent';
import { defineAgent } from '@flue/runtime';

function Triage() {
  return 'Triage the incoming issue and propose next steps.';
}

export default defineAgent(Triage, { model: 'anthropic/claude-sonnet-4-6' });
```

Like `'use strict'`, it is an ECMAScript module directive: a string literal in the directive prologue, before any imports or statements. The [Vite plugin](/docs/guide/vite-plugin/) detects it by parsing, not by pattern-matching, so comments and string contents elsewhere in the file can never trigger it.

The directive does three jobs.

## 1. Identity

The directive assigns the module an **identity**: its file basename. `src/agents/triage.ts` is the agent `triage`, wherever it lives under the source root and whatever URL it is mounted at.

Identity — not the mount path — keys durable storage:

- on **Node**, conversation streams are stored under the identity slug;
- on **Cloudflare**, the identity names the generated Durable Object class (`triage` → `FlueTriageAgent`) and binding (`FLUE_TRIAGE_AGENT`).

That split gives renames precise semantics:

| Change                         | Effect                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Re-mounting at a different URL | Nothing durable changes. The same conversations are reachable at the new path. Mounting at two URLs serves the same conversations.                                              |
| Renaming the **file**          | A storage-identity change. On Cloudflare, express it with wrangler-native `renamed_classes` to keep existing conversations; on Node, the storage key changes with the identity. |

Because the identity is the file basename, basenames must be **unique among an application's agents** (a duplicate is a build error) and **lower-kebab-case** (`support-assistant.ts`), so generated durable identifiers stay predictable.

## 2. Module metadata

The build transform binds the module's optional named exports onto the definition, so [`agent.route()`](/docs/guide/routing/) in `app.ts` is fully configured by the agent file alone:

```ts title="src/agents/triage.ts"
'use agent';
import { defineAgent, type AgentRouteHandler } from '@flue/runtime';
import { requireUser, gateAttachments } from '../auth.ts';

export const route: AgentRouteHandler = requireUser; // middleware on all agent routes
export const attachments: AgentRouteHandler = gateAttachments; // opt-in attachment downloads
export const description = 'Triages incoming issues.'; // static metadata

function Triage() {
  return 'Triage the incoming issue and propose next steps.';
}

export default defineAgent(Triage, { model: 'anthropic/claude-sonnet-4-6' });
```

These exports keep exactly the meanings described in [Routing](/docs/guide/routing/#per-agent-middleware-the-route-export). The module is the single source of per-agent configuration — `.route()` takes no options.

## 3. Registration: the scan is the registry

The set of `'use agent'` modules found by the build **is** the application's agent set, on both targets. The generated bootstrap imports and registers every marked file; Cloudflare additionally emits one Durable Object class per marked file. Consequences:

- **Mounting registers nothing.** `.route()` is a pure router factory over an already-registered agent; see [Routing](/docs/guide/routing/#registration-comes-from-the-scan-not-the-mount).
- **Dispatch-only agents work unmounted.** Being scanned is enough for `dispatch(...)` to reach them.
- **An unmarked file is invisible.** A module without the directive is ordinary application code — mounting it errors with a pointer to add `'use agent'`.

### What the scan covers

The scan is a directory glob over the [source root](/docs/guide/project-layout/#source-directory) — every `.ts`, `.mts`, `.js`, and `.mjs` file, recursively, skipping `node_modules`, build output, and Flue's generated directories — filtered to files whose directive prologue contains `'use agent'`. Agent files can live anywhere under the source root; `src/agents/` is a convention, not a rule.

To narrow the scan, set the `agents` glob in [`flue.config.ts`](/docs/reference/configuration/#agents):

```ts title="flue.config.ts"
import { defineConfig } from '@flue/runtime/config';

export default defineConfig({
  agents: 'agents/**/*.ts',
});
```

In development the scan stays live: creating, deleting, or renaming a marked module updates the registered set (and, on Cloudflare, the generated entry and wrangler config) without a manual restart. Remember that on Cloudflare a _new_ agent still needs its user-authored migration entry — see [the triple](/docs/guide/vite-plugin/#migrations-the-triple-for-adding-an-agent).

## Where the directive is not required

The directive is how an agent joins an _application_. Two consumers work without it:

- **`flue run <path>`** executes one agent module directly and derives the identity from the loaded path. See [flue run](/docs/cli/run/).
- **Unit tests** can exercise a raw `defineAgent(...)` value without any build step.

## Next steps

- [Routing](/docs/guide/routing/) — mount registered agents in `app.ts`.
- [Vite plugin](/docs/guide/vite-plugin/) — the scan, transform, and generated bootstrap.
- [Agents](/docs/guide/building-agents/) — everything inside `defineAgent(...)`.
