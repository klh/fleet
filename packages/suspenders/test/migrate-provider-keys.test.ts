// test/migrate-provider-keys.test.ts — W1124.8.2.2: the explicit one-time
// provider-key migration CLI (dry-run default, masked plan; --apply writes
// inline keys into the machine stack.yaml providers block, atomic 0600 with
// a timestamped 0600 backup, refusing ambiguity without an explicit --map).
// Pure-function suite: plans resolve from injected files/env only.
import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-migrate-keys-"));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

const mpk = await import("../scripts/migrate-provider-keys.ts");

const EMPTY_STACK = "version: 0123456789abcdef0123456789abcdef01234567\n";

/** One fixture area: a conf dir for the stack + an env-home beside it. */
function area(name: string): { conf: string; home: string } {
	const root = join(HOME, name);
	const conf = join(root, "conf");
	const home = join(root, "llm");
	mkdirSync(conf, { recursive: true });
	mkdirSync(home, { recursive: true });
	return { conf, home };
}

describe("parseMapEntries", () => {
	test("splits profile=source pairs; malformed entries throw", () => {
		expect(
			mpk.parseMapEntries(["zai-coding=belt.env:Z_AI_API_KEY", "b=ENV2"]),
		).toEqual({ "zai-coding": "belt.env:Z_AI_API_KEY", b: "ENV2" });
		expect(() => mpk.parseMapEntries(["no-equals"])).toThrow();
		expect(() => mpk.parseMapEntries(["empty-source="])).toThrow();
	});
});

describe("planMigration", () => {
	test("stack without a providers section plans empty; apply refuses", () => {
		const { conf } = area("no-providers");
		const stack = join(conf, "stack.yaml");
		writeFileSync(stack, EMPTY_STACK);
		const opts = { stackPath: stack, localLlmHome: conf, apply: true, map: {} };
		const plan = mpk.planMigration(opts);
		expect(plan.ok).toBe(false);
		if (!plan.ok) expect(plan.reason).toContain("no providers section");
	});

	test("inline-key profiles are an idempotent skip", () => {
		const { conf } = area("existing");
		const stack = join(conf, "stack.yaml");
		writeFileSync(
			stack,
			`${EMPTY_STACK}providers:\n  zai-coding:\n    key: inline-example\n`,
		);
		const plan = mpk.planMigration({
			stackPath: stack,
			localLlmHome: conf,
			apply: false,
			map: {},
			files: [],
			processEnv: {},
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.profiles).toHaveLength(1);
		expect(plan.profiles[0].existing).toBe(true);
		expect(plan.profiles[0].value).toBeNull();
	});

	test("one distinct sighting resolves; disagreeing files are ambiguous", () => {
		const { conf, home } = area("sightings");
		writeFileSync(join(home, "belt.env"), "T1_API_KEY=sk-value-12345678\n"); // scrub:allow
		writeFileSync(
			join(home, "buckle-spoke.env"),
			"T1_API_KEY=sk-other-87654321\n",
		); // scrub:allow
		const stack = join(conf, "stack.yaml");
		writeFileSync(
			stack,
			`${EMPTY_STACK}providers:\n  anthropic:\n    env: T1_API_KEY\n`,
		);
		const opts = {
			stackPath: stack,
			localLlmHome: home,
			apply: false,
			map: {},
			files: ["belt.env", "buckle-spoke.env"],
			processEnv: {},
		};
		const ok = mpk.planMigration({ ...opts, files: ["belt.env"] });
		expect(ok.ok).toBe(true);
		if (!ok.ok) return;
		expect(ok.profiles[0].value).toBe("sk-value-12345678"); // scrub:allow
		expect(ok.profiles[0].ambiguous).toBe(false);

		const amb = mpk.planMigration(opts);
		expect(amb.ok).toBe(true);
		if (!amb.ok) return;
		expect(amb.profiles[0].ambiguous).toBe(true);
		expect(amb.profiles[0].value).toBeNull();
	});

	test("--map pins the source; an absent pin marks ambiguous", () => {
		const { conf, home } = area("mapped");
		writeFileSync(join(home, "belt.env"), "T1_API_KEY=sk-map-pin-value1\n"); // scrub:allow
		const stack = join(conf, "stack.yaml");
		writeFileSync(
			stack,
			`${EMPTY_STACK}providers:\n  anthropic:\n    env: T1_API_KEY\n`,
		);
		const opts = {
			stackPath: stack,
			localLlmHome: home,
			apply: false,
			map: {},
			files: ["belt.env"],
			processEnv: {},
		};
		const pinned = mpk.planMigration({
			...opts,
			map: { anthropic: "belt.env:T1_API_KEY" },
		});
		expect(pinned.ok).toBe(true);
		if (!pinned.ok) return;
		expect(pinned.profiles[0].value).toBe("sk-map-pin-value1"); // scrub:allow
		expect(pinned.profiles[0].mappedFrom).toBe("belt.env:T1_API_KEY");

		const absent = mpk.planMigration({
			...opts,
			map: { anthropic: "elsewhere.env:K1" },
		});
		expect(absent.ok).toBe(true);
		if (!absent.ok) return;
		const ap = absent.profiles[0];
		expect(ap.ambiguous).toBe(true);
		expect(ap.value).toBeNull();
	});

	test("env binding is carried through unchanged", () => {
		const { conf } = area("envbinding");
		const stack = join(conf, "stack.yaml");
		writeFileSync(
			stack,
			`${EMPTY_STACK}providers:\n  zai-general:\n    env: Z_AI_API_KEY\n`,
		);
		const plan = mpk.planMigration({
			stackPath: stack,
			localLlmHome: conf,
			apply: false,
			map: {},
			files: [],
			processEnv: {},
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.profiles[0].envBinding).toBe("Z_AI_API_KEY");
	});
});

describe("applyMigration", () => {
	test("writes key inline, preserves siblings, 0600, backs up pre state", () => {
		const { conf, home } = area("apply");
		writeFileSync(join(home, "belt.env"), "T2_API_KEY=sk-apply-value-99999\n"); // scrub:allow
		const stack = join(conf, "stack.yaml");
		writeFileSync(
			stack,
			`${EMPTY_STACK}hubs:\n  nas:\n    host: nas.example\nproviders:\n  zai-coding:\n    env: T2_API_KEY\n`,
		);
		const opts = {
			stackPath: stack,
			localLlmHome: home,
			apply: true,
			map: {},
			files: ["belt.env"],
			processEnv: {},
		};
		const plan = mpk.planMigration(opts);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		const out = mpk.applyMigration(opts, plan.profiles);
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		expect(out.written).toEqual(["zai-coding"]);
		expect(out.backup).toBeDefined();
		const migrated = readFileSync(stack, "utf8");
		expect(migrated).toContain("key: sk-apply-value-99999"); // scrub:allow
		expect(migrated).toContain("host: nas.example");
		expect(migrated).toContain("env: T2_API_KEY");
		expect(statSync(stack).mode & 0o777).toBe(0o600);
		if (out.backup !== undefined)
			expect(statSync(out.backup).mode & 0o777).toBe(0o600);
	});

	test("re-run on a migrated stack is a no-op without a new backup", () => {
		const { conf, home } = area("idempotent");
		writeFileSync(join(home, "belt.env"), "T3_API_KEY=sk-idem-value-8888\n"); // scrub:allow
		const stack = join(conf, "stack.yaml");
		writeFileSync(
			stack,
			`${EMPTY_STACK}providers:\n  zai-coding:\n    env: T3_API_KEY\n`,
		);
		const opts = {
			stackPath: stack,
			localLlmHome: home,
			apply: true,
			map: {},
			files: ["belt.env"],
			processEnv: {},
		};
		const first = mpk.planMigration(opts);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const once = mpk.applyMigration(opts, first.profiles);
		expect(once.ok).toBe(true);
		const again = mpk.planMigration(opts);
		expect(again.ok).toBe(true);
		if (!again.ok) return;
		const twice = mpk.applyMigration(opts, again.profiles);
		expect(twice.ok).toBe(true);
		if (!twice.ok) return;
		expect(twice.written).toEqual([]);
		expect(twice.backup).toBeUndefined();
	});

	test("ambiguous plan refuses the apply, stack untouched", () => {
		const { conf, home } = area("refusal");
		writeFileSync(join(home, "belt.env"), "T4_API_KEY=sk-first-11111111\n"); // scrub:allow
		writeFileSync(
			join(home, "buckle-spoke.env"),
			"T4_API_KEY=sk-second-22222222\n",
		); // scrub:allow
		const stack = join(conf, "stack.yaml");
		writeFileSync(
			stack,
			`${EMPTY_STACK}providers:\n  zai-coding:\n    env: T4_API_KEY\n`,
		);
		const opts = {
			stackPath: stack,
			localLlmHome: home,
			apply: true,
			map: {},
			files: ["belt.env", "buckle-spoke.env"],
			processEnv: {},
		};
		const plan = mpk.planMigration(opts);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		const before = readFileSync(stack, "utf8");
		const out = mpk.applyMigration(opts, plan.profiles);
		expect(out.ok).toBe(false);
		expect(out.written).toEqual([]);
		expect(readFileSync(stack, "utf8")).toBe(before);
	});
});

describe("renderPlan", () => {
	test("masks every sighting; prefixes mark skip/migrate/ambiguous", () => {
		const plans = [
			{
				profile: "skip",
				value: null,
				sources: [],
				existing: true,
				ambiguous: false,
			},
			{
				profile: "go",
				value: "sk-raw-12345678",
				sources: [{ label: "belt.env:T5_API_KEY", masked: "••••5678" }],
				existing: false,
				ambiguous: false,
			},
			{
				profile: "uns",
				value: null,
				sources: [{ label: "env:T5_API_KEY", masked: "••••abcd" }],
				existing: false,
				ambiguous: true,
			},
		] as const;
		const lines = mpk.renderPlan(plans);
		const flat = lines.join("\n");
		expect(flat).not.toContain("sk-raw-12345678"); // scrub:allow
		expect(flat).toContain("••••5678");
		expect(flat).toContain("= skip");
		expect(flat).toContain("+ go");
		expect(flat).toContain("! uns");
	});
});

describe("runMigration (CLI door)", () => {
	test("--help exits 0; malformed --map exits 2", () => {
		expect(mpk.runMigration(["--help"])).toBe(0);
		expect(mpk.runMigration(["--map", "broken"])).toBe(2);
	});

	test("apply without a providers section exits 2 (nothing written)", () => {
		const { conf } = area("cli-no-prov");
		const stack = join(conf, "stack.yaml");
		writeFileSync(stack, EMPTY_STACK);
		expect(
			mpk.runMigration(["--apply", "--stack", stack, "--home", conf]),
		).toBe(2);
	});
});
