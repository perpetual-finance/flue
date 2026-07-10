---
title: Skills
description: Add Agent Skills to Flue agents and invoke them from application code.
lastReviewedAt: 2026-07-07
---

Flue supports [Agent Skills](https://agentskills.io/specification): reusable instructions and supporting resources that agents can load for specialized, repeatable work, such as applying a review process, following an operational workflow, or using shared project guidance. Skills can be bundled with your application or supplied by the runtime workspace where an agent operates.

Skills guide agent work; they do not add executable capabilities. Use [tools](/docs/guide/tools/) or [sandboxes](/docs/guide/sandboxes/) when an agent needs to act or needs workspace access.

## Add a skill

Flue lets you import an Agent Skill from your project or an installed package. Flue packages its instructions and supporting files with your application so an initialized harness can use it without depending on files in its runtime workspace.

To keep an application-owned skill next to the agents that use it, add its directory to your project. This guide uses `src/skills/`:

```text title="Application-owned skill"
src/
├─ agents/
│  └─ assistant.ts
└─ skills/
   └─ review/
      ├─ SKILL.md
      └─ references/
         └─ checklist.md
```

The example stores the skill in `src/skills/` alongside other authored source, but its location does not make it available on its own. Import its `SKILL.md` to include it in the application and make it available to an agent. See [Project Layout](/docs/guide/project-layout/) for how Flue organizes authored source.

## Import a skill

Import your skills directly — any import that resolves to a file named `SKILL.md` is packaged automatically by the build (bundle, metadata, reference). Pass the imported reference to `useSkill(...)` inside the agent function:

```ts title="src/agents/assistant.ts"
'use agent';
import { defineAgent, useModel, useSkill } from '@flue/runtime';
import review from '../skills/review/SKILL.md';
import triage from '../skills/triage/SKILL.md';
import investigate from '../skills/investigate/SKILL.md';

function Assistant() {
  useModel('anthropic/claude-sonnet-4-6');
  useSkill(review);
  useSkill(triage);
  useSkill(investigate);
  return 'Use the skills below as needed to complete the request.';
}

export default defineAgent(Assistant);
```

Each import produces a skill reference and includes that skill directory in the application build. Mounting a reference with `useSkill(...)` makes the skill available to this agent by its declared name. A skill mounted on every render is cataloged in the system prompt; a skill may also be mounted conditionally (`if (pro) useSkill(refundsSkill)`) — when it appears or disappears, the runtime announces the change to the model in the conversation while the prompt's catalog stays frozen (see [Dynamic resources](/docs/api/agent-api/#dynamic-resources)).

Skills can also be imported from installed packages:

```ts
import review from '@acme/review-skills/review/SKILL.md';
```

The package must publish `SKILL.md` and its supporting files. If it defines package exports, it must export the imported `SKILL.md` subpath.

Imported skill directories are deployed application content: ordinary supporting files beside `SKILL.md` are included without additional imports. Do not store credentials, private keys, or runtime secrets in a skill directory that your application imports. Flue rejects common sensitive files and symbolic links inside imported skill directories when packaging them.

Flue also loads skills from the sandbox where a harness runs, with no import required. At context initialization, it discovers [Agent Skills](https://agentskills.io/specification)-compatible directories under `<cwd>/.agents/skills/`:

```text title="Workspace-provided skill"
<cwd>/
└─ .agents/
   └─ skills/
      └─ review/
         ├─ SKILL.md
         └─ references/
            └─ checklist.md
```

Each discovered skill is available by its declared name without a TypeScript import or a `useSkill(...)` call, and its supporting files remain in that sandbox workspace. This lets a repository checkout, CI environment, or prepared runtime workspace provide its own skills to a harness. See [Sandboxes](/docs/guide/sandboxes/) for controlling the filesystem and working directory visible at runtime.

If an imported skill registered on an agent and a discovered workspace skill declare the same name, initialization fails rather than choosing one implicitly.

## Frontmatter support

Flue validates every `SKILL.md` against the [Agent Skills specification](https://agentskills.io/specification), whether the skill is imported or discovered in a workspace. The table below lists Flue's support level for each frontmatter field:

| Field           | Spec     | Flue support                                                                                                                                                  |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`          | Required | Validated: lowercase letters, numbers, and hyphens; no leading, trailing, or consecutive hyphens; at most 64 characters; must match the skill directory name. |
| `description`   | Required | Validated: non-empty, at most 1024 characters. Tells the agent what the skill does and when to use it.                                                        |
| `license`       | Optional | Accepted; informational only.                                                                                                                                 |
| `compatibility` | Optional | Accepted; at most 500 characters; informational only.                                                                                                         |
| `metadata`      | Optional | Accepted; string-to-string mapping; not interpreted by Flue.                                                                                                  |
| `allowed-tools` | Optional | Accepted, not enforced. The field is experimental in the spec and support may vary between implementations; Flue does not restrict the session's toolset.     |

Unknown frontmatter fields are ignored, so skills that carry extra host-specific fields still load. The spec's [`skills-ref` validator](https://github.com/agentskills/agentskills/tree/main/skills-ref) flags unknown fields if you want stricter authoring checks.

## Invoke a skill

Normally you can trust the agent to use the skills you provide it, as needed, to complete its work.

In application-controlled code such as a [harness tool](/docs/guide/tools/#harness-tools), you can direct a skill through `harness.prompt(...)`: it runs in the same conversation context as the agent's own turns — same system prompt, skill catalog, and tools — so naming the skill in the instruction is enough for the model to activate it. This works with both registered imported skills and workspace-discovered skills.

```ts title="src/shared/review-tools.ts"
import { defineTool, useModel } from '@flue/runtime';
import * as v from 'valibot';

export const reviewChange = defineTool({
  name: 'review_change',
  description: 'Apply the review skill to one proposed change.',
  input: v.object({ change: v.string() }),
  harness: true,

  async run({ harness, data }) {
    const response = await harness.prompt(`Apply the review skill to this change:\n\n${data.change}`, {
      result: v.object({
        approved: v.boolean(),
        summary: v.string(),
      }),
    });
    return response.data;
  },
});
```

The `result` schema makes `response.data` a validated structured result; omit it when you want text output from `response.text`. `review` here is the declared skill name, not a path to `SKILL.md` — the agent that mounts this tool also mounts the `review` skill with `useSkill(...)`, so it's already in this conversation's catalog for the model to activate.

See the [Agent API](/docs/api/agent-api/) for operation options and response types.

## When to use a skill

Skills are most useful when:

- an agent needs a repeatable process, checklist, or set of conventions;
- specialized guidance should be shared across agents;
- instructions need supporting templates, examples, or reference files;
- a workspace should provide its own guidance without changing application code.

For executable application capabilities, use a [tool](/docs/guide/tools/).

## Next steps

- [Agent Skills specification](https://agentskills.io/specification) — create and structure compatible skills.
- [Agents](/docs/guide/building-agents/) — configure an agent's model and capabilities.
- [Tools](/docs/guide/tools/) — add executable capabilities that a skill may direct an agent to use.
- [Sandboxes](/docs/guide/sandboxes/) — control the runtime workspace where discovered skills and their files are available.
- [Agent API](/docs/api/agent-api/) — look up harness operation options and result types.
