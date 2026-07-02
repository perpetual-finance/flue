import type { APIRoute } from 'astro';

const DEPLOY_GUIDES = [
	['Deploy on Node.js', 'https://flueframework.com/docs/ecosystem/deploy/node/index.md'],
	['Deploy on Cloudflare', 'https://flueframework.com/docs/ecosystem/deploy/cloudflare/index.md'],
	[
		'Deploy on GitHub Actions',
		'https://flueframework.com/docs/ecosystem/deploy/github-actions/index.md',
	],
	['Deploy on GitLab CI/CD', 'https://flueframework.com/docs/ecosystem/deploy/gitlab-ci/index.md'],
	['Deploy on Render', 'https://flueframework.com/docs/ecosystem/deploy/render/index.md'],
] as const;

const DEPLOY_GUIDE_LIST = DEPLOY_GUIDES.map(([title, url]) => `   - ${title}: ${url}`).join('\n');

const START_INSTRUCTIONS = `# Skill: Create a New Flue Agent

You are helping the user create their first Flue agent. Start with one agent module plus the small application shell around it (\`app.ts\` and \`vite.config.ts\`).

## Step 1: Gather Context

First, fetch and read the Flue homepage and quickstart:

https://flueframework.com/
https://flueframework.com/docs/getting-started/quickstart/index.md

## Step 2: Discover Requirements

Determine the following. Ask the user only for information you do not already know from the conversation. If the user has already made a choice, treat that choice as binding.

1. What would they like to build?
   - Let their answer determine the smallest useful starter shape.
   - If they do not answer, or are not sure yet, create a minimal \`hello-world\` agent module only.
   - The primitive is always an **agent**: a continuing assistant or event-driven agent with an identity and durable conversations. Examples: a chat assistant, support agent, coding agent, or message-driven triage agent.
   - When they also need a bounded, deterministic job (summarize a ticket, generate a report, run a scheduled task), model it as an **action** on the agent: a \`defineAction({ name, description, run({ harness }) { ... } })\` listed in the agent's \`actions: [...]\`, with instructions telling the model when to call it. Do not add an action merely to test an agent — use \`flue run <path-to-agent-module> --message "..."\` for one local prompt.
2. Where should the project live on disk?
   - Use filesystem tools to inspect the current working directory first, then confirm the target directory with the user.
   - Flue resolves the project's source root by picking the first existing directory: \`.flue/\`, then \`src/\`, then the project root. \`app.ts\` lives at the source root; agent modules conventionally live in the source root's \`agents/\` directory.
   - Prefer the \`src\` layout for new projects. Use \`.flue\` when adding a self-contained Flue source area to a larger application. Preserve the root layout for an existing compact project.
3. Where should it deploy? For example: Cloudflare Workers, Node.js, GitHub Actions, GitLab CI/CD, Vercel, Fly.io.
   - Available deploy guides:
${DEPLOY_GUIDE_LIST}
   - If they choose a host without a deploy guide, use the Node.js guide as the baseline unless they ask for something else.
4. Do they have an LLM provider/model in mind?
   - Optional, but recommended. Setup is easier if you know which provider they plan to use, because you can scaffold the right model specifier and environment variable names.
   - We suggest these exact model specifiers:
     - \`anthropic/claude-sonnet-4-6\` - latest Sonnet
     - \`anthropic/claude-opus-4-7\` - latest Opus
     - \`openai/gpt-5.5\` - GPT-5.5
     - \`openrouter/moonshotai/kimi-k2.6\` - latest Kimi
   - If the user wants a different provider or model, use this list to get the best model specifier: \`https://flueframework.com/models.json\`
   - If their requested model is unavailable, ask before substituting another model. Don't continue until you have a model specifier.

Before implementing, restate the chosen requirements to yourself as an implementation contract:

- Agent purpose: \`<purpose>\`
- Starter shape: \`agent only\` or \`agent + action\`
- Project directory: \`<absolute or relative path>\`
- Source layout: \`.flue\`, \`src\`, or \`root\`
- Agent module path: \`./.flue/agents/<name>.ts\`, \`./src/agents/<name>.ts\`, or \`./agents/<name>.ts\`
- Deploy target: \`<target>\`
- Model specifier: \`<exact model specifier>\`

## Step 3: Build the Smallest Useful Starter Project

1. Pick the deploy guide that best matches the user's target, fetch it, and follow its package, target, configuration, secrets, and deployment guidance.
2. Create or update the project in the requested directory using the selected source layout.
3. Always create one minimal **agent module** matching the user's idea, keeping it closer to "hello world" than a production app.
   - Put it in the selected layout's immediate \`agents/\` directory, using a lower-kebab-case filename such as \`src/agents/hello-world.ts\`.
   - Its first statement must be the \`'use agent';\` directive — that is how the module joins the application (the build scans for marked modules; the file basename becomes the agent's durable identity).
   - It must default-export \`defineAgent(() => ({ model: '<exact model specifier>', instructions: '<short purpose-specific instruction>' }))\`.
   - For an \`agent + action\` starter, add one \`defineAction\` to the agent's \`actions: [...]\` and mention it in the instructions.
4. Create \`app.ts\` at the source root — the application's route map and the only required entry file. Mount the agent explicitly:
   \`\`\`ts
   import { Hono } from 'hono';
   import helloWorld from './agents/hello-world.ts';

   const app = new Hono();
   app.route('/agents/hello-world', helloWorld.route());

   export default app;
   \`\`\`
   An agent that is only reached via \`flue run\` or \`dispatch(...)\` needs no mount — the \`'use agent'\` directive already registered it — but mounting the starter agent gives the user an HTTP surface to try.
5. Create \`vite.config.ts\` with the Flue plugin, and add \`dev\`/\`build\` package scripts (\`vite dev\` / \`vite build\`):
   \`\`\`ts
   import { flue } from '@flue/vite';
   import { defineConfig } from 'vite';

   export default defineConfig({ plugins: [flue()] });
   \`\`\`
   On Cloudflare, add \`cloudflare()\` from \`@cloudflare/vite-plugin\` after \`flue()\` and follow the Cloudflare deploy guide for \`wrangler.jsonc\` (each agent file needs a user-authored Durable Object migration entry for its generated \`Flue<PascalName>Agent\` class).
6. Optionally add \`flue.config.ts\` (default-export \`defineConfig({ ... })\` from \`@flue/runtime/config\`) when the project needs an explicit \`target\` or non-default \`app\`/\`db\` paths; the defaults above need none.
7. Add \`tsconfig.json\` for TypeScript editor/typechecking support.
   - If no \`tsconfig.json\` exists, create this minimal one:
     \`\`\`json
     {
       "compilerOptions": {
         "target": "ES2024",
         "module": "ESNext",
         "moduleResolution": "Bundler",
         "allowImportingTsExtensions": true,
         "noEmit": true,
         "strict": true,
         "skipLibCheck": true
       },
       "include": ["src/**/*.ts", "agents/**/*.ts", "*.ts", ".flue/**/*.ts"],
       "exclude": ["dist"]
     }
     \`\`\`
   - If \`tsconfig.json\` already exists, do not replace it. Make the smallest safe change needed to include the generated authored-source files.
   - TypeScript may ignore hidden directories by default, so projects using the \`.flue\` layout usually need \`.flue/**/*.ts\` included explicitly.
8. Add only the dependencies required by the selected deploy guide and chosen starter shape (typically \`@flue/runtime\`, \`hono\`, and dev-dependencies \`@flue/cli\`, \`@flue/vite\`, \`vite\`, \`typescript\`).
9. Run the most relevant validation command you can, such as the typecheck, \`vite build\`, or \`flue run <path-to-agent-module> --message "..."\` once the user's model credentials are available. If you cannot run it, explain why.
10. Finish with the exact next commands the user should run, including how to set any required secrets, \`vite dev\` for the local server, and one \`flue run\` example prompt.

## Step 4: Verify Implementation

Before finishing, verify that the implementation matches the user's explicit choices:

- **Project location**: Files were created in the requested directory.
- **Source layout**: Files use only the selected \`.flue\`, \`src\`, or root layout; \`app.ts\` sits at the selected source root.
- **Agent module**: One agent module exists in the selected layout's \`agents/<name>.ts\`, starts with \`'use agent';\`, and default-exports \`defineAgent(...)\`.
- **Routing**: \`app.ts\` mounts the agent via \`app.route('/agents/<name>', <agent>.route())\`; no route relies on file placement.
- **Build surface**: \`vite.config.ts\` includes \`flue()\` (plus \`cloudflare()\` only for the Cloudflare target), and \`dev\`/\`build\` scripts call \`vite dev\` / \`vite build\`.
- **Deploy target**: Config and commands match the user's selected deploy target.
- **LLM provider/model**: Model specifier is one of the suggested values, or an exact value from \`https://flueframework.com/models.json\` if the user requested another model.
- **Secrets**: No fake API keys, tokens, or secrets were invented.
- **Dependencies**: Only dependencies required by the selected deploy guide and starter shape were added.

If any item does not match the user's choices, fix it before you finish.

In your final response, include a short checklist with the project directory, source layout, agent module path, deploy target, model specifier, and validation result.

## Important Instructions and Constraints to be Successful

- Important: Never invent API keys or secrets.
  - Instead: You can scaffold out obvious placeholders, but always ask the user to provide the API secrets/keys/tokens themselves. You can still help the user by showing them the command to run to set the secret, based on their local dev setup and chosen host.
- Important: Flue has no separate "workflow" primitive. A bounded job is an agent action; a durable conversation is the only durable unit. Do not import or reference \`defineWorkflow\` — it does not exist.
- Important: Once \`@flue/cli\` is installed in the project, the full Flue documentation is available offline through the CLI and always matches the installed version. Prefer it over fetching website URLs for follow-up questions:
  - \`npx flue docs search <query>\` — search the documentation (JSON results)
  - \`npx flue docs read <path>\` — print one documentation page as Markdown
  - \`npx flue docs\` — list all documentation pages
- Important: For local development, use \`vite dev\` (the \`flue()\` plugin serves the application, watches for file changes, and hot-reloads on edits). Production builds use \`vite build\`; the Node target emits \`dist/server.mjs\` to run with \`node dist/server.mjs\`. There are no \`flue dev\` or \`flue build\` commands.
- Important: \`flue run\` executes one agent module locally under Node with no HTTP server: \`npx flue run src/agents/<name>.ts --message "Hello"\` streams the agent's activity, prints the reply, and prints the conversation id. Pass \`--id <conversation-id>\` to continue the same conversation across invocations. It loads the project's \`.env\` by default (\`--env <path>\` selects another file); \`vite dev\` reads the shell environment instead.
`;

export const GET: APIRoute = () => {
	return new Response(START_INSTRUCTIONS, {
		headers: {
			'Content-Type': 'text/markdown; charset=utf-8',
		},
	});
};
