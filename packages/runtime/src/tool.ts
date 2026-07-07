import {
	ToolInputValidationError,
	ToolLegacyDefinitionError,
	ToolOutputSerializationError,
	ToolOutputValidationError,
} from './errors.ts';
import { cloneJsonSerializable } from './json-snapshot.ts';
import { isTopLevelObjectSchema, isValibotSchema, parseValibot } from './schema.ts';
import type {
	ToolContext,
	ToolDefinition,
	ToolInputSchema,
	ToolOutput,
	ToolOutputSchema,
} from './tool-types.ts';
import type { FlueHarness, FlueLogger } from './types.ts';

export function defineTool<
	const TInput extends ToolInputSchema | undefined = undefined,
	const TOutput extends ToolOutputSchema | undefined = undefined,
	const THarness extends boolean = false,
>(options: {
	name: string;
	description: string;
	input?: TInput;
	output?: TOutput;
	harness?: THarness;
	run: ToolDefinition<TInput, TOutput, THarness>['run'];
}): ToolDefinition<TInput, TOutput, THarness> {
	assertToolDefinition(options, 'defineTool()');
	return Object.freeze({
		name: options.name,
		description: options.description,
		input: options.input as TInput,
		output: options.output as TOutput,
		harness: options.harness as THarness,
		run: options.run,
	});
}

export function assertToolDefinition(
	value: unknown,
	label: string,
): asserts value is ToolDefinition {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`[flue] ${label} requires a tool definition object.`);
	}
	const legacyFields = ['parameters', 'execute'].filter((field) => Object.hasOwn(value, field));
	if (legacyFields.length > 0) throw new ToolLegacyDefinitionError({ fields: legacyFields });
	const tool = value as Partial<ToolDefinition>;
	assertNonEmptyString(tool.name, `${label} name`);
	assertNonEmptyString(tool.description, `${label} description`);
	if (tool.input !== undefined) {
		if (!isValibotSchema(tool.input)) {
			throw new Error(`[flue] ${label} input must be a Valibot schema.`);
		}
		if (!isTopLevelObjectSchema(tool.input)) {
			throw new Error(`[flue] ${label} input must be a top-level object schema.`);
		}
	}
	if (tool.output !== undefined && !isValibotSchema(tool.output)) {
		throw new Error(`[flue] ${label} output must be a Valibot schema.`);
	}
	if (tool.harness !== undefined && typeof tool.harness !== 'boolean') {
		throw new Error(`[flue] ${label} harness must be a boolean.`);
	}
	if (typeof tool.run !== 'function') {
		throw new Error(`[flue] ${label} run must be a function.`);
	}
}

/** Runtime facilities the executing session injects into {@link ToolContext}. */
export interface ToolRunFacilities {
	log: FlueLogger;
	/** Present only for `harness: true` tools, created per invocation. */
	harness?: FlueHarness;
}

export function parseToolInput<TTool extends ToolDefinition>(
	tool: TTool,
	data?: unknown,
	signal?: AbortSignal,
	facilities?: ToolRunFacilities,
): { context: Parameters<TTool['run']>[0]; data: unknown } {
	const base: Record<string, unknown> = {
		signal,
		log: facilities?.log ?? NOOP_LOGGER,
		...(facilities?.harness ? { harness: facilities.harness } : {}),
	};
	if (!tool.input) return { context: base as Parameters<TTool['run']>[0], data: undefined };
	const parsed = parseValibot(tool.input, data === undefined ? {} : data);
	if (!parsed.success) {
		throw new ToolInputValidationError({ tool: tool.name, issues: parsed.issues });
	}
	return {
		context: { ...base, data: parsed.output } as Parameters<TTool['run']>[0],
		data: parsed.output,
	};
}

/** Standalone runs have no conversation stream to log into. */
const NOOP_LOGGER: FlueLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};

export function validateToolOutput<TTool extends ToolDefinition>(
	tool: TTool,
	result: unknown,
): ToolOutput<TTool> {
	let output: unknown = result;
	if (tool.output) {
		const parsedOutput = parseValibot(tool.output, result);
		if (!parsedOutput.success) {
			throw new ToolOutputValidationError({ tool: tool.name, issues: parsedOutput.issues });
		}
		output = parsedOutput.output;
	}
	if (output === undefined && !tool.output) return undefined as ToolOutput<TTool>;
	if (output === undefined) throw new ToolOutputSerializationError({ tool: tool.name });
	try {
		return cloneJsonSerializable(output, `Tool "${tool.name}" output`) as ToolOutput<TTool>;
	} catch (cause) {
		throw new ToolOutputSerializationError({ tool: tool.name, cause });
	}
}

export async function validateAndRunTool<TTool extends ToolDefinition>(
	tool: TTool,
	data?: unknown,
	signal?: AbortSignal,
): Promise<ToolOutput<TTool>> {
	if (tool.harness) {
		throw new Error(
			`[flue] Tool "${tool.name}" declares \`harness: true\` and can only run inside an agent session — a standalone run has no harness.`,
		);
	}
	const parsed = parseToolInput(tool, data, signal);
	return validateToolOutput(tool, await tool.run(parsed.context));
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`[flue] ${label} must be a non-empty string.`);
	}
}
