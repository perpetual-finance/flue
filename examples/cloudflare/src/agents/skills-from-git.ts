'use agent';
/**
 * Demonstrates hydrating a cf-shell `Workspace` from a git repository via
 * `createGit`, then letting the model explore it with the sandbox's `code`
 * tool. Formerly a workflow whose `run` issued one fixed prompt; as an agent,
 * the prompt is simply the message you send it:
 *
 *   curl -X POST /agents/skills-from-git/<id> \
 *     -H 'Content-Type: application/json' \
 *     -d '{"kind": "user", "body": "List every top-level file and directory in the repo, then describe the project."}'
 *
 * then read the reply from the conversation stream: GET /agents/skills-from-git/<id>
 */
import { WorkspaceFileSystem } from '@cloudflare/shell';
import { createGit } from '@cloudflare/shell/git';
import { defineAgent } from '@flue/runtime';
import { getDefaultWorkspace, getShellSandbox } from '../sandboxes/cloudflare-shell';

const HYDRATION_SENTINEL = '/.hydrated';
const TARGET_REPO = 'https://github.com/FredKSchott/vinext-starter';
const CLONE_DIR = '/repo';

// `env` carries the wrangler.jsonc bindings (here: the LOADER Worker Loader).
export default defineAgent(async ({ env }) => {
	const workspace = getDefaultWorkspace();
	if (!(await workspace.exists(HYDRATION_SENTINEL))) {
		const git = createGit(new WorkspaceFileSystem(workspace));
		await git.clone({ url: TARGET_REPO, dir: CLONE_DIR, singleBranch: true, depth: 1 });
		await workspace.writeFile(HYDRATION_SENTINEL, new Date().toISOString());
	}
	return {
		sandbox: getShellSandbox({ workspace, loader: env.LOADER }),
		model: 'cloudflare/@cf/moonshotai/kimi-k2.6',
		cwd: CLONE_DIR,
		instructions:
			`You operate inside a clone of ${TARGET_REPO} at ${CLONE_DIR}. ` +
			'When asked about the repository, use the code tool to actually inspect the files ' +
			'before answering — never answer from assumption.',
	};
});
