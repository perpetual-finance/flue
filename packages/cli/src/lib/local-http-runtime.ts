import { cloudflareViteConfigPath, createCloudflareViteConfig } from './build.ts';

export interface LocalHttpRuntimeOutput {
	stream: 'stdout' | 'stderr';
	line: string;
}

export interface LocalHttpRuntime {
	readonly target: 'node' | 'cloudflare';
	readonly port: number;
	readonly url: string;
	reload(): Promise<void>;
	stop(): Promise<void>;
	killSync(): void;
}

export interface StartCloudflareLocalRuntimeOptions {
	root: string;
	port: number;
	stopTimeoutMs?: number;
	watch?: boolean;
	viteConfig?: import('vite').UserConfig;
	onWatchChange?: (filePath: string) => void;
	cloudflareLogLevel?: 'silent' | 'info';
}

interface StartedRuntime {
	port: number;
	url: string;
	reload(): Promise<void>;
	stop(): Promise<void>;
	killSync(): void;
}

export async function startCloudflareLocalRuntime(
	options: StartCloudflareLocalRuntimeOptions,
): Promise<StartedRuntime> {
	const restoreWarnings = suppressPunycodeDeprecation();
	const originalNoDeprecation = process.noDeprecation;
	process.noDeprecation = true;
	const originalNodeOptions = process.env.NODE_OPTIONS;
	process.env.NODE_OPTIONS = [originalNodeOptions, '--disable-warning=DEP0040']
		.filter(Boolean)
		.join(' ');
	try {
		const [{ cloudflare }, { createServer, mergeConfig }] = await Promise.all([
			import('@cloudflare/vite-plugin'),
			import('vite'),
		]);
		const baseConfig = createCloudflareViteConfig(
			cloudflare,
			options.root,
			cloudflareViteConfigPath(options.root),
		);
		const merged = mergeConfig(baseConfig, options.viteConfig ?? {});
		const watchPlugin = options.onWatchChange
			? {
					name: 'flue-dev-watch',
					configureServer(server: Awaited<ReturnType<typeof createServer>>) {
						server.watcher.on('all', (_event, filePath) => options.onWatchChange?.(filePath));
					},
				}
			: undefined;
		const server = await createServer({
			...merged,
			configFile: false,
			root: options.root,
			plugins: [...(merged.plugins ?? []), ...(watchPlugin ? [watchPlugin] : [])],
			logLevel: options.cloudflareLogLevel ?? 'silent',
			server: {
				...merged.server,
				host: '127.0.0.1',
				port: options.port,
				strictPort: true,
				...(options.watch ? {} : { hmr: false, watch: { ignored: ['**/*'] } }),
			},
		});
		try {
			await server.listen();
		} catch (error) {
			await closeViteServer(server, options.stopTimeoutMs ?? 5_000).catch(() => {});
			throw error;
		}
		const url =
			server.resolvedUrls?.local[0]?.replace(/\/$/, '') ?? `http://127.0.0.1:${options.port}`;
		let restored = false;
		const restore = () => {
			if (restored) return;
			restored = true;
			process.noDeprecation = originalNoDeprecation;
			if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
			else process.env.NODE_OPTIONS = originalNodeOptions;
			restoreWarnings();
		};
		return {
			port: options.port,
			url,
			reload: () => server.restart(),
			stop: async () => {
				try {
					await closeViteServer(server, options.stopTimeoutMs ?? 5_000);
				} finally {
					restore();
				}
			},
			killSync: restore,
		};
	} catch (error) {
		process.noDeprecation = originalNoDeprecation;
		if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
		else process.env.NODE_OPTIONS = originalNodeOptions;
		restoreWarnings();
		throw error;
	}
}

async function closeViteServer(
	server: Awaited<ReturnType<(typeof import('vite'))['createServer']>>,
	timeoutMs: number,
): Promise<void> {
	const close = server.close();
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			close,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					const httpServer = server.httpServer;
					if (httpServer && 'closeAllConnections' in httpServer) httpServer.closeAllConnections();
					reject(new Error(`Timed out closing Cloudflare Vite server after ${timeoutMs}ms.`));
				}, timeoutMs);
				timer.unref();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function suppressPunycodeDeprecation(): () => void {
	const original = process.emitWarning;
	process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
		const message = warning instanceof Error ? warning.message : String(warning);
		const code =
			warning instanceof Error
				? (warning as Error & { code?: string }).code
				: typeof args[1] === 'string'
					? args[1]
					: undefined;
		if (code === 'DEP0040' || message.includes('`punycode` module is deprecated')) return;
		return Reflect.apply(original, process, [warning, ...args]);
	}) as typeof process.emitWarning;
	return () => {
		if (process.emitWarning !== original) process.emitWarning = original;
	};
}

