// test/cli.test.ts — W421: unit coverage for the shared arg/cmd toolkit
// (hooks/lib/cli.ts). Pure function tests — the adopters' CLI surfaces are
// covered by work-cli / consult-kb / smoke suites against the real binaries.
import { describe, expect, test } from "bun:test";
import {
	CliError,
	type CliDef,
	type CommandDef,
	helpOf,
	parseCommand,
	runCli,
	usageOf,
	verbList,
} from "../hooks/lib/cli.ts";

const take: CommandDef = {
	name: "take",
	usage: "usage: take <id> --as <sid>",
	flags: { "--as": { required: true }, "--json": { type: "switch" } },
	minPos: 1,
};

describe("usageOf / helpOf", () => {
	test("explicit usage wins; help adds per-flag lines", () => {
		expect(usageOf(take)).toBe("usage: take <id> --as <sid>");
		const h = helpOf(take);
		expect(h.split("\n")[0]).toBe("usage: take <id> --as <sid>");
		expect(h).toContain("  --as <v> (required)");
		expect(h).toContain("  --json");
	});

	test("generated usage line from flags + posHint", () => {
		const def: CommandDef = {
			name: "coord emit",
			posHint: "<kind>",
			flags: {
				"--scope": {},
				"--json": { type: "switch" },
				"--as": { required: true },
			},
		};
		expect(usageOf(def)).toBe(
			"usage: coord emit [--scope <v>] [--json] --as <v> <kind>",
		);
	});
});

describe("parseCommand", () => {
	test("value flags: first occurrence wins, trailing flag yields null", () => {
		const a = parseCommand(take, ["w1", "--as", "s1", "--as", "s2"]);
		expect(a.flag("--as")).toBe("s1");
		const opt: CommandDef = {
			...take,
			flags: { "--origin": {} },
		};
		const b = parseCommand(opt, ["w1", "--origin"]);
		expect(b.flag("--origin")).toBe(null); // trailing flag → null
		expect(b.pos).toEqual(["w1"]);
	});

	test("switches set has(), never consume a value", () => {
		const a = parseCommand(take, ["w1", "--as", "s", "--json"]);
		expect(a.has("--json")).toBe(true);
		expect(a.flag("--json")).toBe("true"); // switch reads like a flag
		const b = parseCommand(take, ["--json", "w1", "--as", "s"]);
		// --json first does not swallow w1
		expect(b.pos).toEqual(["w1"]);
	});

	test("minPos + required die with the usage line", () => {
		expect(() => parseCommand(take, [])).toThrow(CliError);
		expect(() => parseCommand(take, [])).toThrow("usage: take");
		expect(() => parseCommand(take, ["w1"])).toThrow(CliError); // missing --as
	});

	test("unknown option dies unless lax", () => {
		expect(() =>
			parseCommand(take, ["w1", "--as", "s", "--bogus"]),
		).toThrow("unknown option: --bogus");
		const lax: CommandDef = { ...take, lax: true };
		const a = parseCommand(lax, ["w1", "--as", "s", "--bogus"]);
		expect(a.flag("--as")).toBe("s");
		expect(a.pos).toEqual(["w1"]);
	});

	test("--help short-circuits before validation", () => {
		expect(parseCommand(take, ["--bogus", "--help"]).help).toBe(true);
		expect(() => parseCommand(take, ["--bogus", "--help"])).not.toThrow();
	});

	test("num(): default, parsed, and non-finite dies", () => {
		const def: CommandDef = {
			name: "loop",
			flags: { "--every": {}, "--cycle-timeout": {} },
		};
		const a = parseCommand(def, []);
		expect(a.num("--every", 120)).toBe(120);
		const b = parseCommand(def, ["--every", "30"]);
		expect(b.num("--every", 120)).toBe(30);
		const c = parseCommand(def, ["--every", "abc"]);
		expect(() => c.num("--every", 120)).toThrow(CliError);
	});
});

describe("runCli helpers", () => {
	const cli: CliDef = {
		name: "coord",
		about: "control plane",
		commands: {
			emit: {
				name: "coord emit",
				posHint: "<kind>",
				flags: { "--note": {} },
				lax: true,
			},
			fact: { name: "coord fact", posHint: "<set|get|list> ...", lax: true },
		},
	};

	test("verb list is the single source for overview + unknown die", () => {
		expect(verbList(cli)).toBe("emit | fact");
	});

	test("unknown verb throws with the generated list", () => {
		let thrown: CliError | null = null;
		try {
			runCli(cli, ["bogus"]);
		} catch (e) {
			thrown = e instanceof CliError ? e : null;
		}
		expect(thrown?.message).toBe("unknown command — try emit | fact");
		expect(thrown?.helpText).toContain("coord — control plane");
	});
});
