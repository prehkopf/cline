import { describe, expect, it, vi } from "vitest";
import { createReadFilesTool } from "./definitions";
import { parseStringifiedReadFilesInput } from "./helpers";

const context = { agentId: "agent-1", conversationId: "conv-1", iteration: 1 };

async function requestedPaths(input: unknown): Promise<string[]> {
	const execute = vi.fn(async (request: { path: string }) => request.path);
	const tool = createReadFilesTool(execute);
	await tool.execute(input as never, context);
	return execute.mock.calls.map(([request]) => request.path);
}

describe("read_files with a JSON-encoded file list", () => {
	it.each([
		{
			label: "files as object list",
			input: { files: '[{"path":"C:/a.txt"}]' },
		},
		{ label: "files as string list", input: { files: '["C:/a.txt"]' } },
		{ label: "files as one object", input: { files: '{"path":"C:/a.txt"}' } },
		{
			label: "file_path alias",
			input: { files: '[{"file_path":"C:/a.txt"}]' },
		},
		{ label: "paths key", input: { paths: '["C:/a.txt"]' } },
		{ label: "file_paths key", input: { file_paths: '["C:/a.txt"]' } },
		{ label: "whole input as list", input: '[{"path":"C:/a.txt"}]' },
		{
			label: "whole input as object",
			input: '{"files":[{"path":"C:/a.txt"}]}',
		},
		{ label: "nested stringified", input: '{"files":"[\\"C:/a.txt\\"]"}' },
	])("reads the real path for $label", async ({ input }) => {
		expect(await requestedPaths(input)).toEqual(["C:/a.txt"]);
	});

	// String.raw keeps each backslash literal, exactly as the model sent it.
	it.each([
		{
			label: "escaped backslashes",
			input: { files: String.raw`[{"path":"C:\\Users\\Patrick\\a.txt"}]` },
			expected: String.raw`C:\Users\Patrick\a.txt`,
		},
		{
			label: "raw backslashes (invalid JSON escapes)",
			input: { files: String.raw`[{"path":"C:\Users\Patrick\a.txt"}]` },
			expected: String.raw`C:\Users\Patrick\a.txt`,
		},
		{
			label: "raw backslashes that look like tab and newline escapes",
			input: { files: String.raw`["C:\temp\new.txt"]` },
			expected: String.raw`C:\temp\new.txt`,
		},
		{
			label: "raw backslashes in a whole-input object",
			input: String.raw`{"files":[{"path":"C:\Users\b.txt"}]}`,
			expected: String.raw`C:\Users\b.txt`,
		},
		{
			label: "escaped UNC path",
			input: { files: String.raw`["\\\\nas\\share\\c.txt"]` },
			expected: String.raw`\\nas\share\c.txt`,
		},
		{
			label: "raw UNC path",
			input: { files: String.raw`["\\nas\share\c.txt"]` },
			expected: String.raw`\\nas\share\c.txt`,
		},
	])("reads Windows paths with $label", async ({ input, expected }) => {
		expect(await requestedPaths(input)).toEqual([expected]);
	});

	it("keeps line ranges from the parsed entries", async () => {
		const execute = vi.fn(async () => "x");
		const tool = createReadFilesTool(execute);
		await tool.execute(
			{ files: '[{"path":"C:/a.txt","start_line":2,"end_line":4}]' } as never,
			context,
		);
		expect(execute).toHaveBeenCalledWith(
			{ path: "C:/a.txt", start_line: 2, end_line: 4 },
			expect.anything(),
		);
	});

	it.each([
		"[draft].txt",
		"{notes}.md",
		"[1, 2]",
		"[]",
		'["C:/a.txt"',
		'{"other":1}',
	])("leaves %s as a single path", (value) => {
		expect(parseStringifiedReadFilesInput({ files: value })).toEqual({
			files: value,
		});
		expect(parseStringifiedReadFilesInput(value)).toBe(value);
	});
});
