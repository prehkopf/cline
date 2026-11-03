import { validateWithZod } from "@cline/shared";
import type { z } from "zod";
import {
	type EditFileInput,
	INPUT_ARG_CHAR_LIMIT,
	type ReadFileRequest,
	RunCommandsInputUnionSchema,
	type StructuredCommandInput,
} from "./schemas";

/**
 * Format an error into a string message
 */
export function formatError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

const ANSI_ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
const ANSI_REGEX = new RegExp(
	[
		`[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?${ANSI_ST})`,
		"(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))",
	].join("|"),
	"g",
);

export function stripAnsi(value: string): string {
	return value.replace(ANSI_REGEX, "");
}

export function getEditorSizeError(input: EditFileInput): string | null {
	if (
		typeof input.old_text === "string" &&
		input.old_text.length > INPUT_ARG_CHAR_LIMIT
	) {
		return `Editor input too large: old_text was ${input.old_text.length} characters, exceeding the recommended limit of ${INPUT_ARG_CHAR_LIMIT}. Split the edit into smaller tool calls so later tool calls are less likely to be truncated or time out.`;
	}

	if (input.new_text.length > INPUT_ARG_CHAR_LIMIT) {
		return `Editor input too large: new_text was ${input.new_text.length} characters, exceeding the recommended limit of ${INPUT_ARG_CHAR_LIMIT}. Split the edit into smaller tool calls so later tool calls are less likely to be truncated or time out.`;
	}

	return null;
}

/**
 * Create a timeout-wrapped promise
 */
export class TimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(message: string, timeoutMs: number) {
		super(message);
		this.name = "TimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

export function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	message: string,
): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new TimeoutError(message, ms)), ms);
		}),
	]);
}

export function formatReadFileQuery(request: ReadFileRequest): string {
	const { path, start_line, end_line } = request;
	if (start_line == null && end_line == null) {
		return path;
	}
	const start = start_line ?? 1;
	const end = end_line ?? "EOF";
	return `${path}:${start}-${end}`;
}

export function getReadFileRangeError(request: ReadFileRequest): string | null {
	const { start_line, end_line } = request;
	if (start_line == null || end_line == null || start_line <= end_line) {
		return null;
	}

	return `start_line must be less than or equal to end_line (received start_line: ${start_line}, end_line: ${end_line})`;
}

const READ_RANGE_KEYS = new Set(["start_line", "end_line"]);

function isOrphanReadRangeEntry(
	value: unknown,
): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const keys = Object.keys(value);
	return keys.length > 0 && keys.every((key) => READ_RANGE_KEYS.has(key));
}

function coalesceOrphanReadRangeEntries(entries: unknown[]): unknown[] {
	const coalesced: unknown[] = [];
	for (const entry of entries) {
		if (isOrphanReadRangeEntry(entry)) {
			const previous = coalesced[coalesced.length - 1];
			if (typeof previous === "string") {
				coalesced[coalesced.length - 1] = { path: previous, ...entry };
				continue;
			}
			if (
				previous !== null &&
				typeof previous === "object" &&
				!Array.isArray(previous) &&
				"path" in previous &&
				Object.keys(entry).every((key) => !(key in previous))
			) {
				coalesced[coalesced.length - 1] = { ...previous, ...entry };
				continue;
			}
		}
		coalesced.push(entry);
	}
	return coalesced;
}

/**
 * Some models emit a file's line range as a separate array element instead of
 * placing start_line/end_line on the same object as its path. Fold such
 * orphan range entries into the preceding file entry before validation.
 */
export function coalesceOrphanReadRanges(input: unknown): unknown {
	if (Array.isArray(input)) {
		return coalesceOrphanReadRangeEntries(input);
	}
	if (input !== null && typeof input === "object") {
		for (const key of ["files", "paths"] as const) {
			const value = (input as Record<string, unknown>)[key];
			if (Array.isArray(value)) {
				return { ...input, [key]: coalesceOrphanReadRangeEntries(value) };
			}
		}
	}
	return input;
}

const READ_REQUEST_PATH_KEYS = ["path", "file_path", "filePath"] as const;

function isReadRequestObject(value: unknown): boolean {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		READ_REQUEST_PATH_KEYS.some(
			(key) => typeof (value as Record<string, unknown>)[key] === "string",
		)
	);
}

function tryJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting decoded \t, \n, \b etc.
const CONTROL_CHARS = /[\u0000-\u001f]/;

function containsControlChars(value: unknown): boolean {
	if (typeof value === "string") {
		return CONTROL_CHARS.test(value);
	}
	if (value !== null && typeof value === "object") {
		return Object.values(value).some(containsControlChars);
	}
	return false;
}

/**
 * Parse JSON that may hold unescaped Windows paths. A model often writes
 * `{"path":"C:\Users\a.txt"}` inside the string: `\U` is not a JSON escape,
 * so the parse fails, and `C:\temp\new.txt` parses but decodes `\t`/`\n` into
 * a tab and a newline. In either case retry with every backslash taken
 * literally. Returns undefined when neither reading is valid JSON.
 */
function parseJsonWithWindowsPaths(text: string): unknown {
	const parsed = tryJsonParse(text);
	if (parsed !== undefined && !containsControlChars(parsed)) {
		return parsed;
	}
	if (text.includes("\\")) {
		const literal = tryJsonParse(text.replace(/\\/g, "\\\\"));
		if (literal !== undefined) {
			return literal;
		}
	}
	return parsed;
}

/**
 * Some models send the read list as a JSON-encoded string, e.g.
 * `{"files": "[{\"path\":\"C:/a.txt\"}]"}`. Without this the whole string is
 * taken as one relative path and resolved against the workspace root. Only a
 * string that parses to a list of paths/read requests, or to one read request,
 * is replaced, so a real file named `[draft].txt` is left alone. The parsed
 * value is still validated by the schema afterwards.
 */
function parseStringifiedReadList(value: unknown): unknown {
	if (typeof value !== "string") {
		return value;
	}
	const trimmed = value.trim();
	if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
		return value;
	}
	const parsed = parseJsonWithWindowsPaths(trimmed);
	if (parsed === undefined) {
		return value;
	}
	if (Array.isArray(parsed)) {
		const isReadList =
			parsed.length > 0 &&
			parsed.every(
				(entry) =>
					typeof entry === "string" ||
					(entry !== null && typeof entry === "object"),
			);
		return isReadList ? parsed : value;
	}
	return isReadRequestObject(parsed) ? parsed : value;
}

const READ_LIST_KEYS = ["files", "paths", "file_paths"] as const;

export function parseStringifiedReadFilesInput(input: unknown): unknown {
	if (typeof input === "string") {
		const parsed = parseStringifiedReadList(input);
		// A whole input sent as a JSON object, e.g. '{"files":[...]}'.
		if (parsed === input && input.trim().startsWith("{")) {
			const object = parseJsonWithWindowsPaths(input.trim());
			if (
				object !== null &&
				typeof object === "object" &&
				!Array.isArray(object) &&
				READ_LIST_KEYS.some((key) => key in object)
			) {
				return parseStringifiedReadFilesInput(object);
			}
		}
		return parsed;
	}
	if (input !== null && typeof input === "object" && !Array.isArray(input)) {
		const record = input as Record<string, unknown>;
		for (const key of READ_LIST_KEYS) {
			if (key in record) {
				const parsed = parseStringifiedReadList(record[key]);
				if (parsed !== record[key]) {
					return { ...record, [key]: parsed };
				}
			}
		}
	}
	return input;
}

/**
 * Some models send the command list as a JSON-encoded string, e.g.
 * `{"commands": "[\"dir\"]"}`. Without this the whole string runs as a single
 * command and fails in the shell (PowerShell: "Missing type name after '['").
 * Only a string that parses to a list of strings or objects is replaced, so a
 * real command such as `[int]"42" + 1` is left alone. The parsed entries are
 * still validated by the schema afterwards.
 */
function parseStringifiedCommandList(value: unknown): unknown {
	if (typeof value !== "string" || !value.trimStart().startsWith("[")) {
		return value;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return value;
	}
	const isCommandList =
		Array.isArray(parsed) &&
		parsed.every(
			(entry) =>
				typeof entry === "string" ||
				(entry !== null && typeof entry === "object"),
		);
	return isCommandList ? parsed : value;
}

function parseStringifiedRunCommandsInput(input: unknown): unknown {
	if (typeof input === "string") {
		return parseStringifiedCommandList(input);
	}
	if (input !== null && typeof input === "object" && "commands" in input) {
		const commands = parseStringifiedCommandList(input.commands);
		return commands === input.commands ? input : { ...input, commands };
	}
	return input;
}

export function normalizeRunCommandsInput(
	input: unknown,
): Array<string | StructuredCommandInput> {
	const commands = collectRunCommands(
		validateWithZod(
			RunCommandsInputUnionSchema,
			parseStringifiedRunCommandsInput(input),
		),
	);
	// An empty list is well-formed but never a real request: nothing would
	// run and the call would still report success. Fail it so the model sees
	// that no command was given instead of an empty result it has to read
	// into.
	if (commands.length === 0) {
		throw new Error(
			"run_commands requires at least one command; the commands list was empty.",
		);
	}
	return commands;
}

function collectRunCommands(
	validate: z.infer<typeof RunCommandsInputUnionSchema>,
): Array<string | StructuredCommandInput> {
	if (typeof validate === "string") {
		return [validate];
	}

	if (Array.isArray(validate)) {
		return validate;
	}

	if ("commands" in validate) {
		return Array.isArray(validate.commands)
			? validate.commands
			: [validate.commands];
	}

	if ("command" in validate) {
		return "args" in validate ? [validate] : [validate.command];
	}

	if ("cmd" in validate) {
		return [validate.cmd];
	}

	return [validate];
}

export function formatRunCommandQuery(
	command: string | StructuredCommandInput,
): string {
	if (typeof command === "string") {
		return command;
	}

	const args = command.args ?? [];
	if (args.length === 0) {
		return command.command;
	}

	const renderedArgs = args.map((arg) =>
		/[\s"]/u.test(arg) ? JSON.stringify(arg) : arg,
	);
	return `${command.command} ${renderedArgs.join(" ")}`;
}

/**
 * Max characters of the executed command echoed back in the tool result's
 * `query` field. The full command already exists in the assistant tool-call
 * input, so repeating it in the result only duplicates tokens in the
 * provider request (expensive for large heredoc/file-generation commands).
 */
export const RUN_COMMAND_QUERY_PREVIEW_LIMIT = 200;

/**
 * Bound the command echo placed in a provider-facing tool result.
 * Short commands pass through unchanged; long commands keep a short
 * prefix plus a truncation note so the result is still identifiable.
 */
export function formatRunCommandQueryPreview(
	command: string | StructuredCommandInput,
): string {
	const rendered = formatRunCommandQuery(command);
	if (rendered.length <= RUN_COMMAND_QUERY_PREVIEW_LIMIT) {
		return rendered;
	}
	const truncatedChars = rendered.length - RUN_COMMAND_QUERY_PREVIEW_LIMIT;
	return `${rendered.slice(0, RUN_COMMAND_QUERY_PREVIEW_LIMIT)} ... [command truncated: ${truncatedChars} more chars; full command is in the tool call input]`;
}
