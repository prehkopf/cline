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
