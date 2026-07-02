import {
	type FlueConversationMessage,
	type FlueConversationPart,
	FlueProvider,
	useFlueAgent,
} from '@flue/react';
import { createFlueClient } from '@flue/sdk';
import { type FormEvent, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const client = createFlueClient({ baseUrl: '/api' });

function App() {
	const [input, setInput] = useState('');
	const [instanceId] = useState(() => crypto.randomUUID());
	const [demoId] = useState(() => crypto.randomUUID());
	const [actionError, setActionError] = useState<string>();
	const agent = useFlueAgent({ name: 'assistant', id: instanceId });
	const demo = useFlueAgent({ name: 'demo', id: demoId });

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const message = input.trim();
		if (!message) return;
		setInput('');
		setActionError(undefined);
		try {
			await agent.sendMessage(message);
		} catch (error) {
			setInput(message);
			setActionError(error instanceof Error ? error.message : String(error));
		}
	}

	// The old "trigger demo workflow" button. Workflows are gone: the demo is
	// an agent whose deterministic job is a model-callable action, so a run is
	// just a message into the demo conversation — its tool call, action logs,
	// and final reply stream back like any other agent turn.
	async function triggerDemo() {
		setActionError(undefined);
		try {
			await demo.sendMessage(`Run the demo action. requestedAt: ${new Date().toISOString()}`);
		} catch (error) {
			setActionError(error instanceof Error ? error.message : String(error));
		}
	}

	return (
		<main>
			<header>
				<p className="eyebrow">Flue React hooks</p>
				<h1>Chat and background-action test bed</h1>
			</header>
			<section>
				<div className="section-heading">
					<h2>Agent chat</h2>
					<span className={`status ${agent.status}`}>{agent.status}</span>
				</div>
				<div className="messages" aria-live="polite">
					{agent.messages.length === 0 && <p className="empty">Send a message to begin.</p>}
					{agent.messages.map((message) => (
						<Message key={message.id} message={message} />
					))}
				</div>
				<form onSubmit={submit}>
					<input
						aria-label="Message"
						autoComplete="off"
						onChange={(event) => setInput(event.target.value)}
						placeholder="Say hello"
						value={input}
					/>
					<button disabled={!input.trim()} type="submit">
						Send
					</button>
				</form>
			</section>
			<section>
				<div className="section-heading">
					<h2>Demo agent (background action)</h2>
					<span className={`status ${demo.status}`}>{demo.status}</span>
				</div>
				<button onClick={triggerDemo} type="button">
					Run demo action
				</button>
				<div className="messages" aria-live="polite">
					{demo.messages.length === 0 && (
						<p className="empty">The demo conversation appears here.</p>
					)}
					{demo.messages.map((message) => (
						<Message key={message.id} message={message} />
					))}
				</div>
			</section>
			{(actionError || agent.error || demo.error) && (
				<p className="error">{actionError ?? (agent.error ?? demo.error)?.message}</p>
			)}
		</main>
	);
}

function Message({ message }: { message: FlueConversationMessage }) {
	return (
		<article className={`message ${message.role}`}>
			<strong>{message.role}</strong>
			{message.parts.map((part) => (
				<MessagePart key={partKey(part)} part={part} />
			))}
		</article>
	);
}

function MessagePart({ part }: { part: FlueConversationPart }) {
	if (part.type === 'text') return <p>{part.text}</p>;
	if (part.type === 'reasoning')
		return (
			<details>
				<summary>Reasoning</summary>
				{part.text}
			</details>
		);
	if (part.type === 'file') {
		if (!part.url) return <span>Attachment ({part.mediaType})</span>;
		return part.mediaType.startsWith('image/') ? (
			<img src={part.url} alt={part.filename ?? 'attachment'} style={{ maxWidth: 240 }} />
		) : (
			<a href={part.url}>{part.filename ?? 'Attachment'}</a>
		);
	}
	return (
		<pre>
			{part.toolName}: {part.state}
		</pre>
	);
}

function partKey(part: FlueConversationPart): string {
	if (part.type === 'dynamic-tool') return `tool:${part.toolCallId}`;
	if (part.type === 'file') return `file:${part.id ?? part.url ?? part.mediaType}`;
	return `${part.type}:${part.text}`;
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing React root element');

createRoot(root).render(
	<FlueProvider client={client}>
		<App />
	</FlueProvider>,
);
