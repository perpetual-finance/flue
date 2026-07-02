---
title: Build Agents for GitHub Actions
description: Build and run Flue agents in GitHub Actions.
lastReviewedAt: 2026-07-02
---

Build and run Flue agents in GitHub Actions. This guide walks you through creating your first agent, running it locally with the CLI, and wiring it into a CI workflow.

By the end, you will have a Flue agent running inside GitHub Actions, and you will know how to use local sandbox context, external CLIs, subagents, skills, and typed results to build CI automations.

CI is `flue run`'s home turf: one agent module, one message, no server, no port. The command executes the agent transport-free and prints the reply to stdout, so a workflow step can pipe it anywhere.

## Hello World

A minimal agent that runs in CI whenever an issue is opened.

### 1. Set up your project

```bash
mkdir my-flue-project && cd my-flue-project
npm init -y
npm install @flue/runtime valibot
npm install -D @flue/cli
```

### 2. Create your first agent

```typescript title="src/agents/hello.ts"
import { defineAgent } from '@flue/runtime';
import { local } from '@flue/runtime/node';

export default defineAgent(() => ({
  sandbox: local(),
  model: 'anthropic/claude-sonnet-4-6',
  instructions: 'Greet the person the user names and share an interesting fact.',
}));
```

A few things to note:

- This agent is never mounted over HTTP — it exists to be run from the CLI, which is perfect for CI. (The `'use agent'` directive matters only for building a deployable app with Vite; `flue run` takes the module path directly.)
- **`local()`** — The `local()` sandbox runs the agent directly against the host filesystem and shell. In CI, that's the checked-out repo plus whatever binaries are on `$PATH` (`gh`, `git`, `npm`, etc.). Skills and `AGENTS.md` are discovered automatically from the project root. By default only shell-essential env vars (`PATH`, `HOME`, locale, etc.) are inherited from `process.env` — pass `local({ env: { GH_TOKEN: process.env.GH_TOKEN } })` to expose more. Use `local()` only when the runner itself provides the isolation boundary.

### 3. Test it locally

```bash
npx flue run src/agents/hello.ts --message "Say hello to World"
```

`flue run` executes the agent module in-process — no HTTP listener, no build — streams progress to stderr, and prints the final reply to stdout. Pass `--json` for a machine-readable envelope instead.

### 4. Wire it into GitHub Actions

`.github/workflows/hello.yml`:

```yaml
name: Hello Flue

on:
  issues:
    types: [opened]

jobs:
  hello:
    runs-on: ubuntu-latest
    permissions:
      issues: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - name: Run agent
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          npx flue run src/agents/hello.ts \
            --message 'Say hello to ${{ github.event.issue.user.login }}'
```

Add `ANTHROPIC_API_KEY` as a repository secret (**Settings > Secrets and variables > Actions**). Open an issue and you'll see the agent's greeting in the job logs.

## Building a real agent

Now let's build something useful — an issue triage agent that analyzes an issue and reports back. This is where Flue's agent features start to shine.

### Structured work with skills and actions

An agent's deterministic orchestration lives in [Actions](/docs/guide/actions/) — finite, schema-validated jobs the model calls — and [skills](/docs/guide/skills/), reusable instruction files. Inside either, a session gives you three core methods:

- **`session.shell(cmd)`** — Run a shell command in the sandbox. Returns `{ stdout, stderr, exitCode }`.
- **`session.prompt(text, opts)`** — Send a prompt to the agent and get back a result.
- **`session.skill(name, opts)`** — Run a named skill — a reusable agent task defined by a markdown instruction file.

Both `prompt()` and `skill()` accept a `result` option — a [Valibot](https://valibot.dev) schema that defines the expected output shape. Flue parses the agent's response and returns it on `response.data`, fully typed:

```typescript
import * as v from 'valibot';

// summary: string
const { data: summary } = await session.prompt(`Summarize this diff:\n${diff}`, {
  result: v.string(),
});

// diagnosis: { reproducible: boolean, skipped: boolean }
const { data: diagnosis } = await session.skill('triage', {
  args: { issueNumber, issue },
  result: v.object({
    reproducible: v.boolean(),
    skipped: v.boolean(),
  }),
});
```

### Connecting external CLIs

Your agent often needs to interact with tools like `gh`, `npm`, or `git`. With `local()`, the agent's bash tool runs against the host shell directly — anything on `$PATH` is reachable. Host env vars are opt-in: only shell essentials (`PATH`, `HOME`, locale, etc.) are inherited by default, so you pass the specific vars your CLIs need via `local({ env: { ... } })`.

In GitHub Actions, this means you set the secrets you want the agent's CLIs to see in the workflow `env:` block, then forward them explicitly into the sandbox. The runner is your isolation boundary; flue makes the inner boundary (host → spawned shell) explicit.

```typescript title="src/agents/triage.ts"
import { defineAgent } from '@flue/runtime';
import { local } from '@flue/runtime/node';

export default defineAgent(() => ({
  sandbox: local({
    env: {
      GH_TOKEN: process.env.GH_TOKEN,
      NPM_TOKEN: process.env.NPM_TOKEN,
    },
  }),
  model: 'anthropic/claude-opus-4-7',
  instructions:
    'When given an issue number, run the `triage` skill on it and report severity, reproducibility, and a summary.',
}));
```

If you want a tighter boundary — the agent can call a specific operation but never see the underlying token — return the custom tool from `defineAgent(...)` with `tools: [...]`. The tool implementation reads the secret from `process.env`; the agent only sees the tool's parameters and result.

### Subagents

Named subagents can run focused detached tasks:

```typescript
import { defineAgent, defineAgentProfile } from '@flue/runtime';

const reviewer = defineAgentProfile({
  name: 'reviewer',
  instructions: 'Focus on correctness, security, and project standards.',
});

export default defineAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  instructions: "Delegate PR reviews to the 'reviewer' subagent via a task.",
  subagents: [reviewer],
}));
```

### Sandbox context

The agent reads `AGENTS.md` and skills from its sandbox at runtime. CI agents typically use `local()`, which gives direct access to the runner's checkout — so any files in your repo are visible automatically.

**Skills** are reusable agent tasks defined as markdown files in `.agents/skills/`. They give the agent a focused instruction set for a specific job:

`.agents/skills/triage/SKILL.md`:

```markdown
---
name: triage
description: Triage a GitHub issue — reproduce, assess severity, and optionally fix.
---

Given the issue number in the arguments:

1. Use `gh issue view` to fetch the issue details
2. Read the codebase to understand the relevant area
3. Attempt to reproduce the issue
4. Assess severity and write a summary
5. If the fix is straightforward, apply it and open a PR
```

**`AGENTS.md`** at your project root is the agent's system prompt — it provides global context about the project:

```markdown
You are a helpful assistant working on the my-project codebase.

## Project structure

- `src/` — Application source code
- `tests/` — Test suite

## Guidelines

- Always run tests before suggesting a fix is complete
- Use the project's existing patterns and conventions
```

### Wiring it into GitHub Actions

`.github/workflows/issue-triage.yml`:

```yaml
name: Issue Triage

on:
  issues:
    types: [opened]

jobs:
  triage:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
      issues: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - name: Run triage agent
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          npx flue run src/agents/triage.ts \
            --message 'Triage issue #${{ github.event.issue.number }}'
```

`GITHUB_TOKEN` is provided automatically by GitHub Actions.

## Typed results and orchestration

Result schemas aren't just for type safety — they're how you orchestrate multi-step work. Wrap the orchestration in an [Action](/docs/guide/actions/): you get typed data back from `prompt()` and `skill()` and can branch on it in plain code, all inside one durable conversation:

```typescript title="src/agents/auto-triage.ts"
import { defineAction, defineAgent } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import * as v from 'valibot';

const triage = defineAction({
  name: 'triage-issue',
  description: 'Triage one GitHub issue and auto-fix critical reproducible ones.',
  input: v.object({ issueNumber: v.number() }),
  async run({ harness, input }) {
    const session = await harness.session();
    const { data } = await session.skill('triage', {
      args: { issueNumber: input.issueNumber },
      result: v.object({
        severity: v.picklist(['low', 'medium', 'high', 'critical']),
        reproducible: v.boolean(),
        summary: v.string(),
      }),
    });

    if (data.severity === 'critical' && data.reproducible) {
      await session.skill('auto-fix', {
        args: { issueNumber: input.issueNumber },
        result: v.object({ fix_applied: v.boolean(), pr_url: v.optional(v.string()) }),
      });
    }
    return data;
  },
});

export default defineAgent(() => ({
  sandbox: local(),
  model: 'anthropic/claude-sonnet-4-6',
  instructions: 'When given an issue number, call the `triage-issue` action and report its result.',
  actions: [triage],
}));
```

This pattern — prompt or skill call, check the result, decide what to do next — is how you build sophisticated agents that go beyond single-shot prompts.

## Running agents locally

During development, `flue run` executes the same module the CI step will run:

```bash
# One-shot run
npx flue run src/agents/auto-triage.ts --message "Triage issue #42"

# Machine-readable output for scripting
npx flue run src/agents/auto-triage.ts --message "Triage issue #42" --json | jq -r '.message'

# Continue the same conversation across invocations
npx flue run src/agents/auto-triage.ts --message "What did you conclude?" --id issue-42
```

Progress streams to stderr; only the final reply (or the `--json` envelope) lands on stdout. See [`flue run`](/docs/cli/run/) for the full contract.
