// test/verb-kit.test.ts — W651: the shared typed verb registry. Unit tests
// pin the pure door (defineVerb validation, parseVerb semantics, help
// rendering); spawn tests pin the process door (runCli): die format, exit
// codes, per-verb + registry help, and the Bun strips-`--` argv reality.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	defineVerb,
	idList,
	parseVerb,
	renderRegistryHelp,
	renderVerbHelp,
	type VerbSpec,
} from "../hooks/lib/verb-kit.ts";

const spec = (over: Partial<VerbSpec> = {}): VerbSpec =>
	defineVerb({
		name: "probe",
		usage: "usage: probe <x> --on <id>",
		flags: ["--on"],
		minPos: 1,
		reqFlags: ["--on"],
		...over,
	});

describe("idList — W795 multi-positional id lists", () => {
	test("comma, space, and mixed forms parse identically", () => {
		expect(idList(["W791,W792"])).toEqual(["W791", "W792"]);
		expect(idList(["W791", "W792"])).toEqual(["W791", "W792"]);
		expect(idList(["W791", "W792,W793"])).toEqual(["W791", "W792", "W793"]);
	});

	test("empties drop; duplicates dedupe; order preserved", () => {
		expect(idList(["W791,", ",W792"])).toEqual(["W791", "W792"]);
		expect(idList(["W791", "W791,W792"])).toEqual(["W791", "W792"]);
		expect(idList(["W793,W791"])).toEqual(["W793", "W791"]);
	});
});

describe("parseVerb — the one parser", () => {
	test("flags consume the next token; first occurrence wins; all() collects", () => {
		const r = parseVerb(spec(), ["a", "--on", "one", "--on", "two", "b"]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.parsed.pos).toEqual(["a", "b"]);
			expect(r.parsed.flag("--on")).toBe("one");
			expect(r.parsed.all("--on")).toEqual(["one", "two"]);
		}
	});

	test("switches precede flags and consume no value", () => {
		const r = parseVerb(spec({ switches: ["--json"] }), [
			"--json",
			"--on",
			"v",
			"x",
		]);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.parsed.flag("--json")).toBe("true");
	});

	test("a trailing flag yields null — reqFlags catch it", () => {
		const r = parseVerb(spec(), ["a", "--on"]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toBe(spec().usage);
	});

	test("minPos shortfall and unknown options are errors", () => {
		expect(parseVerb(spec(), []).ok).toBe(false);
		const unknown = parseVerb(spec(), ["a", "--bogus", "v"]);
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.message).toBe("unknown option: --bogus");
	});

	test("lax ignores unknown options (legacy verbs)", () => {
		const r = parseVerb(spec({ lax: true, minPos: 0, reqFlags: [] }), [
			"--bogus",
			"a",
		]);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.parsed.pos).toEqual(["a"]);
	});

	test("a surviving `--` is an end-of-options separator (W250 bake)", () => {
		const r = parseVerb(spec({ minPos: 0, reqFlags: [] }), [
			"a",
			"--",
			"--on",
			"--bogus",
		]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.parsed.pos).toEqual(["a", "--on", "--bogus"]);
			expect(r.parsed.flag("--on")).toBe(null);
		}
	});
});

describe("help rendering — generated, never hand-maintained", () => {
	test("renderVerbHelp: usage + flags line (switches fold in)", () => {
		const help = renderVerbHelp(
			spec({ flags: ["--on"], switches: ["--json"] }),
		);
		expect(help).toContain("usage: probe <x> --on <id>");
		expect(help).toContain("flags: --on --json");
	});

	test("renderRegistryHelp: about + names in registration order + epilog", () => {
		const help = renderRegistryHelp(
			"demo",
			"demo — fixture.",
			[spec({ name: "beta" }), spec({ name: "alpha" })],
			"Exit codes: 0 clean, 2 usage.",
		);
		expect(help).toContain("demo — fixture. beta | alpha");
		expect(help).toContain("Exit codes: 0 clean, 2 usage.");
	});
});

describe("runCli — the process door (spawned)", () => {
	const FIXTURE = join(import.meta.dir, "fixtures", "verb-kit-demo.ts");
	const demo = (
		...args: string[]
	): { out: string; err: string; code: number } => {
		const p = Bun.spawnSync(["bun", FIXTURE, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			out: p.stdout.toString(),
			err: p.stderr.toString(),
			code: p.exitCode,
		};
	};

	test("happy path: parse feeds run, after hook fires, exit 0", () => {
		const r = demo("add", "a", "b", "--who", "lane");
		expect(r.code).toBe(0);
		const body = JSON.parse(r.out);
		expect(body.verb).toBe("add");
		expect(body.pos).toEqual(["a", "b"]);
		expect(body.who).toBe("lane");
		expect(body.allWho).toEqual(["lane"]);
		expect(r.err).toContain("after:add");
	});

	test("violations die with the verb usage; numeric run result exits", () => {
		const miss = demo("add", "a");
		expect(miss.code).toBe(2);
		expect(miss.err).toContain("usage: add <a> <b> --who <sid>");
		const noReq = demo("add", "a", "b");
		expect(noReq.code).toBe(2);
		const zap = demo("zap");
		expect(zap.code).toBe(3);
	});

	test("unknown command dies with the generated try-list", () => {
		const r = demo("bogus");
		expect(r.code).toBe(2);
		expect(r.err).toContain("unknown command — try add | list | zap");
	});

	test("bare invocation: usage to stderr, exit 2; --help exits 0", () => {
		const bare = demo();
		expect(bare.code).toBe(2);
		expect(bare.err).toContain("usage: demo <command> [args]");
		const help = demo("--help");
		expect(help.code).toBe(0);
		expect(help.out).toContain("demo — verb-kit fixture. add | list | zap");
	});

	test("per-verb --help prints usage + flags", () => {
		const h = demo("add", "--help");
		expect(h.code).toBe(0);
		expect(h.out).toContain("usage: add <a> <b> --who <sid>");
		expect(h.out).toContain("flags: --who");
	});

	test("Bun strips a LEADING `--`; a mid-argv one survives as separator (W250 pin)", () => {
		// leading: bun eats the `--` before process.argv — the verb still resolves
		const lead = demo("--", "list", "--nope");
		expect(lead.code).toBe(0);
		expect(JSON.parse(lead.out).verb).toBe("list");
		// mid-argv: the `--` survives and parseVerb treats it as end-of-options
		const mid = demo("list", "--", "--nope");
		expect(mid.code).toBe(0);
		expect(JSON.parse(mid.out).rest).toEqual(["--", "--nope"]);
	});
});

describe("runCli default-verb door (W656.3 daemons)", () => {
	const FIXTURE = join(import.meta.dir, "fixtures", "verb-kit-daemon-demo.ts");
	const daemon = (
		...args: string[]
	): { out: string; err: string; code: number } => {
		const p = Bun.spawnSync(["bun", FIXTURE, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			out: p.stdout.toString(),
			err: p.stderr.toString(),
			code: p.exitCode,
		};
	};

	test("bare invocation rides the default verb (compose/launchd contract)", () => {
		const r = daemon();
		expect(r.code).toBe(0);
		expect(JSON.parse(r.out).verb).toBe("loop");
	});

	test("a flag head parses against the default verb's declared flags", () => {
		const r = daemon("--interval", "30");
		expect(r.code).toBe(0);
		expect(JSON.parse(r.out)).toEqual({ verb: "loop", interval: "30" });
	});

	test("unknown flag heads die with the kit's option error", () => {
		const r = daemon("--bogus");
		expect(r.code).toBe(2);
		expect(r.err).toContain("daemon-demo: unknown option: --bogus");
	});

	test("an explicit verb still resolves; top-level --help wins over the door", () => {
		const once = daemon("once");
		expect(once.code).toBe(0);
		expect(JSON.parse(once.out).verb).toBe("once");
		const help = daemon("--help");
		expect(help.code).toBe(0);
		expect(help.out).toContain("daemon-demo — W656.3 default-verb fixture.");
	});
});
