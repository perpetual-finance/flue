export type DocsNavItem =
	| {
			title: string;
			slug: string;
			anchor?: string;
			icon?: 'home';
			items?: DocsNavItem[];
	  }
	| {
			title: string;
			href: string;
	  };

export interface DocsNavGroup {
	title?: string;
	items: DocsNavItem[];
}

export interface DocsSection {
	key: 'guide' | 'api' | 'cli' | 'sdk' | 'ecosystem';
	title: string;
	landingSlug: string;
	groups: DocsNavGroup[];
}

export const docsSections: DocsSection[] = [
	{
		key: 'guide',
		title: 'Guide',
		landingSlug: 'getting-started/quickstart',
		groups: [
			{
				title: 'Introduction',
				items: [
					{ title: 'Getting Started', slug: 'getting-started/quickstart' },
					{ title: 'Why Flue?', slug: 'introduction/why-flue' },
					{ title: 'What is an agent?', slug: 'concepts/agents' },
					{ title: 'Durable Agents', slug: 'concepts/durable-execution' },
					{ title: 'Migrating from 1.0 Beta', slug: 'guide/migrate-from-beta' },
					{ title: 'Changelog', href: 'https://github.com/withastro/flue/blob/main/CHANGELOG.md' },
				],
			},
			{
				title: 'Guides',
				items: [
					{ title: 'Project Layout', slug: 'guide/project-layout' },
					{ title: 'Vite Plugin', slug: 'guide/vite-plugin' },
					{ title: 'Routing', slug: 'guide/routing' },
					{ title: "'use agent'", slug: 'guide/use-agent' },
					{ title: 'Database', slug: 'guide/database' },
					{ title: 'Agents', slug: 'guide/building-agents' },
					{ title: 'LLM', slug: 'guide/models' },
					{ title: 'Tools', slug: 'guide/tools' },
					{ title: 'Skills', slug: 'guide/skills' },
					{ title: 'Subagents', slug: 'guide/subagents' },
					{ title: 'Sandboxes', slug: 'guide/sandboxes' },
					{ title: 'Schedules', slug: 'guide/schedules' },
					{ title: 'Channels', slug: 'guide/channels' },
					{ title: 'Evals', slug: 'guide/evals' },
					{ title: 'Observability', slug: 'guide/observability' },
				],
			},
			{
				title: 'Frontend',
				items: [{ title: 'React', slug: 'guide/react' }],
			},
			{
				title: 'Targets',
				items: [
					{ title: 'Cloudflare', slug: 'guide/targets/cloudflare' },
					{ title: 'Node.js', slug: 'guide/targets/node' },
				],
			},
		],
	},
	{
		key: 'api',
		title: 'Reference',
		landingSlug: 'api/agent-api',
		groups: [
			{
				title: 'Runtime',
				items: [
					{ title: 'Configuration', slug: 'reference/configuration' },
					{ title: 'Errors Reference', slug: 'api/errors-reference' },
					{ title: 'Agent API', slug: 'api/agent-api' },
					{ title: 'Provider API', slug: 'api/provider-api' },
					{ title: 'Routing API', slug: 'api/routing-api' },
					{ title: 'Streaming Protocol', slug: 'api/streaming-protocol' },
					{ title: 'Events Reference', slug: 'api/events-reference' },
				],
			},
			{
				title: 'Advanced',
				items: [
					{ title: 'Sandbox Adapter API', slug: 'api/sandbox-api' },
					{ title: 'Data Persistence API', slug: 'api/data-persistence-api' },
				],
			},
		],
	},
	{
		key: 'cli',
		title: 'CLI',
		landingSlug: 'cli/overview',
		groups: [
			{
				title: 'CLI',
				items: [
					{ title: 'Overview', slug: 'cli/overview' },
					{ title: 'init', slug: 'cli/init' },
					{ title: 'run', slug: 'cli/run' },
					{ title: 'add', slug: 'cli/add' },
					{ title: 'update', slug: 'cli/update' },
					{ title: 'docs', slug: 'cli/docs' },
				],
			},
		],
	},
	{
		key: 'sdk',
		title: 'SDK',
		landingSlug: 'sdk/overview',
		groups: [
			{
				title: 'SDK',
				items: [
					{ title: 'Overview', slug: 'sdk/overview' },
					{
						title: 'createFlueClient(...)',
						slug: 'sdk/client',
						items: [
							{
								title: 'CreateFlueClientOptions',
								slug: 'sdk/client',
								anchor: 'createflueclientoptions',
							},
							{ title: 'RequestHeaders', slug: 'sdk/client', anchor: 'requestheaders' },
						],
					},
					{
						title: 'Conversation methods',
						slug: 'sdk/client',
						items: [
							{ title: 'send(...)', slug: 'sdk/client', anchor: 'conversationsend' },
							{ title: 'wait(...)', slug: 'sdk/client', anchor: 'conversationwait' },
							{ title: 'observe(...)', slug: 'sdk/client', anchor: 'conversationobserve' },
							{ title: 'history(...)', slug: 'sdk/client', anchor: 'conversationhistory' },
							{ title: 'abort(...)', slug: 'sdk/client', anchor: 'conversationabort' },
							{
								title: 'attachmentUrl(...)',
								slug: 'sdk/client',
								anchor: 'conversationattachmenturl',
							},
						],
					},
					{ title: 'Events and records', slug: 'sdk/events' },
					{ title: 'Errors', slug: 'sdk/errors' },
				],
			},
		],
	},
	{
		key: 'ecosystem',
		title: 'Ecosystem',
		landingSlug: 'ecosystem',
		groups: [
			{
				items: [{ title: 'Overview', slug: 'ecosystem', icon: 'home' }],
			},
			{
				title: 'Channels',
				items: [
					{ title: 'Discord', slug: 'ecosystem/channels/discord' },
					{ title: 'Facebook', slug: 'ecosystem/channels/messenger' },
					{ title: 'GitHub', slug: 'ecosystem/channels/github' },
					{ title: 'Google Chat', slug: 'ecosystem/channels/google-chat' },
					{ title: 'Intercom', slug: 'ecosystem/channels/intercom' },
					{ title: 'Linear', slug: 'ecosystem/channels/linear' },
					{ title: 'Microsoft Teams', slug: 'ecosystem/channels/teams' },
					{ title: 'Notion', slug: 'ecosystem/channels/notion' },
					{ title: 'Resend', slug: 'ecosystem/channels/resend' },
					{ title: 'Salesforce', slug: 'ecosystem/channels/salesforce-marketing-cloud' },
					{ title: 'Shopify', slug: 'ecosystem/channels/shopify' },
					{ title: 'Slack', slug: 'ecosystem/channels/slack' },
					{ title: 'Stripe', slug: 'ecosystem/channels/stripe' },
					{ title: 'Telegram', slug: 'ecosystem/channels/telegram' },
					{ title: 'Twilio', slug: 'ecosystem/channels/twilio' },
					{ title: 'WhatsApp', slug: 'ecosystem/channels/whatsapp' },
					{ title: 'Zendesk', slug: 'ecosystem/channels/zendesk' },
				],
			},
			{
				title: 'Sandboxes',
				items: [
					{ title: 'boxd', slug: 'ecosystem/sandboxes/boxd' },
					{ title: 'Cloudflare Shell', slug: 'ecosystem/sandboxes/cloudflare-shell' },
					{ title: 'Cloudflare Sandbox', slug: 'ecosystem/sandboxes/cloudflare' },
					{ title: 'Daytona', slug: 'ecosystem/sandboxes/daytona' },
					{ title: 'E2B', slug: 'ecosystem/sandboxes/e2b' },
					{ title: 'exe.dev', slug: 'ecosystem/sandboxes/exedev' },
					{ title: 'islo', slug: 'ecosystem/sandboxes/islo' },
					{ title: 'Mirage', slug: 'ecosystem/sandboxes/mirage' },
					{ title: 'Modal', slug: 'ecosystem/sandboxes/modal' },
					{ title: 'Vercel Sandbox', slug: 'ecosystem/sandboxes/vercel' },
				],
			},
			{
				title: 'Deploy',
				items: [
					{ title: 'AWS', slug: 'ecosystem/deploy/aws' },
					{ title: 'Cloudflare', slug: 'ecosystem/deploy/cloudflare' },
					{ title: 'Docker', slug: 'ecosystem/deploy/docker' },
					{ title: 'Fly.io', slug: 'ecosystem/deploy/fly' },
					{ title: 'GitHub Actions', slug: 'ecosystem/deploy/github-actions' },
					{ title: 'GitLab CI/CD', slug: 'ecosystem/deploy/gitlab-ci' },
					{ title: 'Node.js', slug: 'ecosystem/deploy/node' },
					{ title: 'Railway', slug: 'ecosystem/deploy/railway' },
					{ title: 'Render', slug: 'ecosystem/deploy/render' },
					{ title: 'SST', slug: 'ecosystem/deploy/sst' },
				],
			},
			{
				title: 'Databases',
				items: [
					{ title: 'libSQL', slug: 'ecosystem/databases/libsql' },
					{ title: 'MongoDB', slug: 'ecosystem/databases/mongodb' },
					{ title: 'MySQL', slug: 'ecosystem/databases/mysql' },
					{ title: 'Postgres', slug: 'ecosystem/databases/postgres' },
					{ title: 'Redis', slug: 'ecosystem/databases/redis' },
					{ title: 'Supabase', slug: 'ecosystem/databases/supabase' },
					{ title: 'Turso', slug: 'ecosystem/databases/turso' },
					{ title: 'Valkey', slug: 'ecosystem/databases/valkey' },
				],
			},
			{
				title: 'Tooling',
				items: [
					{ title: 'Braintrust', slug: 'ecosystem/tooling/braintrust' },
					{ title: 'OpenTelemetry', slug: 'ecosystem/tooling/opentelemetry' },
					{ title: 'Sentry', slug: 'ecosystem/tooling/sentry' },
					{ title: 'Vitest Evals', slug: 'ecosystem/tooling/vitest-evals' },
				],
			},
		],
	},
];

export function docsHref(slug: string, anchor?: string) {
	return `${import.meta.env.BASE_URL}${slug}/${anchor ? `#${anchor}` : ''}`;
}

function includesSlug(items: DocsNavItem[], slug: string): boolean {
	return items.some(
		(item) =>
			'slug' in item &&
			(item.slug === slug || (item.items !== undefined && includesSlug(item.items, slug))),
	);
}

export function getDocsSection(slug: string) {
	return (
		docsSections.find((section) =>
			section.groups.some((group) => includesSlug(group.items, slug)),
		) ?? docsSections[0]
	);
}
