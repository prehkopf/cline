import { zodToJsonSchema } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { normalizeRunCommandsInput } from "./helpers";
import { RunCommandsInputSchema } from "./schemas";

describe("normalizeRunCommandsInput", () => {
	it("accepts the documented shapes", () => {
		expect(normalizeRunCommandsInput({ commands: ["ls", "pwd"] })).toEqual([
			"ls",
			"pwd",
		]);
		expect(normalizeRunCommandsInput({ commands: "ls" })).toEqual(["ls"]);
		expect(normalizeRunCommandsInput(["ls"])).toEqual(["ls"]);
		expect(normalizeRunCommandsInput("ls")).toEqual(["ls"]);
		expect(normalizeRunCommandsInput({ command: "ls" })).toEqual(["ls"]);
		expect(
			normalizeRunCommandsInput({ command: "git", args: ["status"] }),
		).toEqual([{ command: "git", args: ["status"] }]);
	});

	it("parses a command list sent as a JSON-encoded string", () => {
		expect(normalizeRunCommandsInput({ commands: '["dir"]' })).toEqual(["dir"]);
		expect(
			normalizeRunCommandsInput({ commands: '["echo a", "echo b"]' }),
		).toEqual(["echo a", "echo b"]);
		expect(normalizeRunCommandsInput('  ["dir"]')).toEqual(["dir"]);
		expect(
			normalizeRunCommandsInput({
				commands: '[{"command":"git","args":["status"]}]',
			}),
		).toEqual([{ command: "git", args: ["status"] }]);
	});

	it.each([
		{ label: "a PowerShell type literal", command: '[int]"42" + 1' },
		{ label: "a bracketed word", command: "[test] value" },
		{ label: "a JSON list of numbers", command: "[1, 2]" },
		{ label: "an unterminated list", command: '["dir"' },
	])("leaves $label as a single command", ({ command }) => {
		expect(normalizeRunCommandsInput({ commands: command })).toEqual([command]);
		expect(normalizeRunCommandsInput(command)).toEqual([command]);
	});

	// Strings below are exactly what glm-4.7-flash sent on Windows (2026-11-03).
	// String.raw keeps every backslash as the model wrote it.
	it.each([
		{
			label: "raw Windows path backslashes (\\U is not a JSON escape)",
			input: String.raw`["New-Item -ItemType Directory -Path 'c:\Users\Patrick\cline-qa\app' -Force", "cd 'c:\Users\Patrick\cline-qa\app' && git init"]`,
			expected: [
				String.raw`New-Item -ItemType Directory -Path 'c:\Users\Patrick\cline-qa\app' -Force`,
				String.raw`cd 'c:\Users\Patrick\cline-qa\app' && git init`,
			],
		},
		{
			label: "escaped quotes plus raw path backslashes",
			input: String.raw`["pwsh.exe -NoProfile -Command \"cd C:\Users\Patrick\cline-qa\app; Invoke-Pester -Path . -Output Detailed\""]`,
			expected: [
				String.raw`pwsh.exe -NoProfile -Command "cd C:\Users\Patrick\cline-qa\app; Invoke-Pester -Path . -Output Detailed"`,
			],
		},
		{
			label: "shell-escaped dollar signs and one stray quote at the end",
			input: String.raw`["pwsh.exe -NoProfile -Command \"\$content = 'SERVER=127.0.0.1'; \$matches = \$content | Select-String -Pattern '^Server.*'; Write-Host 'Matches:' \$matches\"""]`,
			expected: [
				`pwsh.exe -NoProfile -Command "$content = 'SERVER=127.0.0.1'; $matches = $content | Select-String -Pattern '^Server.*'; Write-Host 'Matches:' $matches"`,
			],
		},
		{
			label: "a quoted path ending in a backslash-quote and a stray quote",
			input: String.raw`["dir \"c:\Users\Patrick\cline-qa\app\"""]`,
			expected: [String.raw`dir "c:\Users\Patrick\cline-qa\app"`],
		},
		{
			label: "a lowercase \\u that is not a unicode escape",
			input: String.raw`["dir c:\users\patrick"]`,
			expected: [String.raw`dir c:\users\patrick`],
		},
		{
			label: "a here-string with JSON newlines and an escaped $",
			input: String.raw`["pwsh -NoProfile -Command \"\$t = @'\nline\n'@; Write-Output \$t\""]`,
			expected: [
				`pwsh -NoProfile -Command "$t = @'\nline\n'@; Write-Output $t"`,
			],
		},
	])("repairs a malformed JSON command list: $label", ({ input, expected }) => {
		expect(normalizeRunCommandsInput({ commands: input })).toEqual(expected);
		expect(normalizeRunCommandsInput(input)).toEqual(expected);
	});

	it("still parses a valid JSON list with escaped backslashes exactly", () => {
		expect(
			normalizeRunCommandsInput({
				commands: String.raw`["dir C:\\Users\\Patrick", "echo \"hi\""]`,
			}),
		).toEqual([String.raw`dir C:\Users\Patrick`, `echo "hi"`]);
	});

	it.each([
		{ label: "an object with an empty commands list", input: { commands: [] } },
		{ label: "a bare empty list", input: [] },
	])("rejects $label instead of reporting an empty success", ({ input }) => {
		expect(() => normalizeRunCommandsInput(input)).toThrow(
			"run_commands requires at least one command",
		);
	});
});

describe("RunCommandsInputSchema", () => {
	it("advertises the command list as non-empty", () => {
		const schema = zodToJsonSchema(RunCommandsInputSchema) as {
			properties: { commands: { minItems?: number } };
		};
		expect(schema.properties.commands.minItems).toBe(1);
	});
});
