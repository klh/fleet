import { setDefaultTimeout, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	activationDiff,
	confirmFailure,
	parseReblessArgs,
	reblessActivation,
} from "./rebless-activation.ts";
import {
	type ActivationReceipt,
	digestUnit,
	writeActivation,
} from "./lib/service-drift.ts";

setDefaultTimeout(15000);

const MANIFEST = `labelPrefix: com.suspenders\nservices: []\n`;
const PLIST_LOOP = JSON.stringify({
	Label: "com.suspenders.fleet-loop",
	ProgramArguments: ["/new/bun", "fleet-loop.ts", "--watch"],
	KeepAlive: true,
});
const PLIST_SPOKE = JSON.stringify({
	Label: "com.suspenders.buckle-spoke",
	ProgramArguments: ["/new/bun", "spoke.ts"],
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "rebless-test-"));
	const home = join(root, "home");
	mkdirSync(join(home, ".config/klh"), { recursive: true });
	const gen = join(root, "gen");
	const genManifest = join(gen, "packages/suspenders/deploy/services.yaml");
	mkdirSync(join(gen, "packages/suspenders/deploy"), { recursive: true });
	writeFileSync(genManifest, MANIFEST);
	const repo = join(root, "repo");
	mkdirSync(join(repo, "deploy"), { recursive: true });
	writeFileSync(join(repo, "deploy/services.yaml"), MANIFEST);
	const published: ActivationReceipt[] = [];
	const render = (outDir: string) => {
		writeFileSync(join(outDir, "com.suspenders.fleet-loop.plist"), PLIST_LOOP);
		writeFileSync(join(outDir, "com.suspenders.buckle-spoke.plist"), PLIST_SPOKE);
		return [
			{ service: "fleet-loop", files: ["com.suspenders.fleet-loop.plist"] },
			{
				service: "buckle-spoke",
				files: ["com.suspenders.buckle-spoke.plist"],
				port: 4101,
			},
		];
	};
	return {
		root,
		home,
		repo,
		gen,
		genManifest,
		published,
		render,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

function receiptFixture(home: string): ActivationReceipt {
	return {
		schema: "fleet.service-activation.v1",
		platform: "darwin",
		domain: `gui/${process.getuid()}`,
		manifest: "/previous/manifest.yaml",
		manifestSha256: "a".repeat(64),
		services: [
			{
				label: "com.suspenders.fleet-loop",
				unit: join(home, "Library/LaunchAgents/com.suspenders.fleet-loop.plist"),
				unitSha256: "b".repeat(64),
				arguments: ["old-bun", "old-entry.ts"],
				resident: false,
			},
			{
				label: "com.suspenders.retired",
				unit: join(home, "Library/LaunchAgents/com.suspenders.retired.plist"),
				unitSha256: "c".repeat(64),
				arguments: ["old"],
				resident: false,
			},
		],
	};
}

function deps(fixture: ReturnType<typeof fixture>) {
	return {
		inspectGeneration: () => ({ state: "ok", root: fixture.gen }),
		render: fixture.render,
		parseUnit: (bytes: string) => JSON.parse(bytes),
		publish: (receipt: ActivationReceipt) => {
			fixture.published.push(receipt);
		},
		uid: process.getuid(),
	};
}

function options(
	fixture: ReturnType<typeof fixture>,
	overrides: Partial<Parameters<typeof reblessActivation>[0]> = {},
): Parameters<typeof reblessActivation>[0] {
	return {
		home: fixture.home,
		prefix: join(fixture.root, "prefix"),
		repo: fixture.repo,
		intent: true,
		confirm: digestUnit(readFileSync(fixture.genManifest)).slice(0, 12),
		drop: [],
		...overrides,
	};
}

test("confirm gate: missing, short, mismatched and matching prefixes", () => {
	const sha = "d".repeat(64);
	expect(confirmFailure(undefined, sha)).toContain(sha.slice(0, 12));
	expect(confirmFailure("a".repeat(12), sha)).toContain("does not prefix-match");
	expect(confirmFailure("d".repeat(11), sha)).toContain("does not prefix-match");
	expect(confirmFailure("d".repeat(12), sha)).toBeNull();
	expect(confirmFailure("D".repeat(12), sha)).toBeNull();
	expect(confirmFailure("d".repeat(64), sha)).toBeNull();
	expect(confirmFailure("zz".repeat(12), sha)).toContain("does not prefix-match");
});

test("parse: defaults, intent, values, refusals", () => {
	const bare = parseReblessArgs([]);
	expect(bare.ok).toBe(true);
	if (bare.ok) {
		expect(bare.options.intent).toBe(false);
		expect(bare.options.confirm).toBeUndefined();
		expect(bare.options.repo).toBe(join(import.meta.dir, ".."));
	}
	const full = parseReblessArgs([
		"--re-bless-activation",
		"--confirm",
		"d".repeat(64),
		"--home",
		"/tmp/h",
		"--prefix",
		"/tmp/p",
		"--repo",
		"/tmp/r",
	]);
	expect(full.ok).toBe(true);
	if (full.ok) {
		expect(full.options.intent).toBe(true);
		expect(full.options.confirm).toBe("d".repeat(64));
		expect(full.options.home).toBe("/tmp/h");
		expect(full.options.prefix).toBe("/tmp/p");
		expect(full.options.repo).toBe("/tmp/r");
	}
	const inline = parseReblessArgs([`--confirm=${"d".repeat(64)}`]);
	expect(inline.ok).toBe(true);
	if (inline.ok) expect(inline.options.confirm).toBe("d".repeat(64));
	const withDrops = parseReblessArgs([
		"--re-bless-activation",
		"--drop",
		"com.suspenders.fleet-loop",
		"--drop=com.suspenders.local-llm",
	]);
	expect(withDrops.ok).toBe(true);
	if (withDrops.ok)
		expect(withDrops.options.drop).toEqual([
			"com.suspenders.fleet-loop",
			"com.suspenders.local-llm",
		]);
	expect(parseReblessArgs(["--drop"]).ok).toBe(false);
	expect(parseReblessArgs(["--confirm"]).ok).toBe(false);
	expect(parseReblessArgs(["--bogus"]).ok).toBe(false);
	expect(parseReblessArgs(["--confirm", "--re-bless-activation"]).ok).toBe(false);
});

test("re-bless writes candidate intent with byte-exact shas and retention", () => {
	const f = fixture();
	try {
		writeActivation(join(f.home, ".config/klh/service-activation.json"), receiptFixture(f.home));
		const outcome = reblessActivation(options(f), deps(f));
		expect(outcome.wrote).toBe(true);
		if (!outcome.wrote) return;
		expect(f.published).toHaveLength(1);
		const receipt = f.published[0];
		// manifestSha256 comes from the ACTIVE GENERATION's manifest bytes
		expect(receipt.manifestSha256).toBe(digestUnit(readFileSync(f.genManifest)));
		expect(receipt.manifest).toBe(join(f.repo, "deploy/services.yaml"));
		expect(receipt.domain).toBe(`gui/${process.getuid()}`);
		const loop = receipt.services.find((s) => s.label === "com.suspenders.fleet-loop");
		const spoke = receipt.services.find((s) => s.label === "com.suspenders.buckle-spoke");
		expect(loop).toBeDefined();
		expect(spoke).toBeDefined();
		// unitSha256 hashes the EXACT bytes the --out render wrote — never a stdout banner variant
		expect(loop?.unitSha256).toBe(digestUnit(PLIST_LOOP));
		expect(loop?.unit).toBe(join(f.home, "Library/LaunchAgents/com.suspenders.fleet-loop.plist"));
		expect(loop?.arguments).toEqual(["/new/bun", "fleet-loop.ts", "--watch"]);
		expect(loop?.resident).toBe(true);
		expect(spoke?.port).toBe(4101);
		// labels absent from the candidate render keep prior validated intent
		expect(receipt.services.some((s) => s.label === "com.suspenders.retired")).toBe(true);
		expect(outcome.diff.join("\n")).toContain("+ com.suspenders.buckle-spoke");
		expect(outcome.diff.join("\n")).toContain("~ com.suspenders.fleet-loop");
	} finally {
		f.cleanup();
	}
});

test("--drop removes retired labels from prior intent pre-merge", () => {
	const f = fixture();
	try {
		writeActivation(
			join(f.home, ".config/klh/service-activation.json"),
			receiptFixture(f.home),
		);
		const outcome = reblessActivation(
			options(f, { drop: ["com.suspenders.retired", "com.suspenders.absent"] }),
			deps(f),
		);
		expect(outcome.wrote).toBe(true);
		if (!outcome.wrote) return;
		const labels = f.published[0].services.map((service) => service.label);
		expect(labels).not.toContain("com.suspenders.retired");
		// the render is authoritative: a dropped label still rendered survives
		expect(labels).toContain("com.suspenders.fleet-loop");
		const joined = outcome.diff.join("\n");
		expect(joined).toContain("- com.suspenders.retired (dropped from prior intent)");
		expect(joined).not.toContain("(retained from prior intent");
		expect(joined).not.toContain("com.suspenders.absent");
	} finally {
		f.cleanup();
	}
});

test("gating: no intent, no/bad confirm, pinned generation, dead generation, no receipt, render failure", () => {
	const f = fixture();
	try {
		writeActivation(join(f.home, ".config/klh/service-activation.json"), receiptFixture(f.home));
		const noIntent = reblessActivation(options(f, { intent: false }), deps(f));
		expect(noIntent.wrote).toBe(false);
		if (!noIntent.wrote) expect(noIntent.refusal).toContain("--re-bless-activation");
		const noConfirm = reblessActivation(options(f, { confirm: undefined }), deps(f));
		expect(noConfirm.wrote).toBe(false);
		if (!noConfirm.wrote) {
			// the operator-review pass: diff prints, candidate sha named, nothing written
			expect(noConfirm.diff.length).toBeGreaterThan(0);
			expect(noConfirm.refusal).toContain("the candidate manifest sha is");
		}
		const badConfirm = reblessActivation(options(f, { confirm: "a".repeat(12) }), deps(f));
		expect(badConfirm.wrote).toBe(false);
		if (!badConfirm.wrote) expect(badConfirm.refusal).toContain("does not prefix-match");
		expect(f.published).toHaveLength(0);
	} finally {
		f.cleanup();
	}
});

test("refusals: no receipt and render failure", () => {
	const f = fixture();
	try {
		const noReceipt = reblessActivation(options(f), deps(f));
		expect(noReceipt.wrote).toBe(false);
		if (!noReceipt.wrote)
			expect(noReceipt.refusal).toContain("no readable activation receipt");
		writeActivation(
			join(f.home, ".config/klh/service-activation.json"),
			receiptFixture(f.home),
		);
		const renderFails = reblessActivation(options(f), {
			...deps(f),
			render: () => {
				throw new Error("boom");
			},
		});
		expect(renderFails.wrote).toBe(false);
		if (!renderFails.wrote)
			expect(renderFails.refusal).toContain("dry-render failed");
		expect(f.published).toHaveLength(0);
	} finally {
		f.cleanup();
	}
});

test("refusals: generation-pinned receipt and dead generation", () => {
	const f = fixture();
	try {
		const receiptPath = join(f.home, ".config/klh/service-activation.json");
		const pinned = receiptFixture(f.home);
		pinned.services[0].generation = {
			root: f.gen,
			revision: "f".repeat(40),
			payloadSha256: "e".repeat(64),
		};
		writeActivation(receiptPath, pinned);
		const pinnedOutcome = reblessActivation(options(f), deps(f));
		expect(pinnedOutcome.wrote).toBe(false);
		if (!pinnedOutcome.wrote)
			expect(pinnedOutcome.refusal).toContain("generation-pinned");
		writeActivation(receiptPath, receiptFixture(f.home));
		const dead = reblessActivation(options(f), {
			...deps(f),
			inspectGeneration: () => ({ state: "unknown", root: null }),
		});
		expect(dead.wrote).toBe(false);
		if (!dead.wrote)
			expect(dead.refusal).toContain("active generation integrity unavailable");
		expect(f.published).toHaveLength(0);
	} finally {
		f.cleanup();
	}
});

test("refusal: active-generation manifest must hash-equal the repo copy", () => {
	const f = fixture();
	try {
		writeActivation(
			join(f.home, ".config/klh/service-activation.json"),
			receiptFixture(f.home),
		);
		writeFileSync(join(f.repo, "deploy/services.yaml"), `${MANIFEST}# drifted\n`);
		const outcome = reblessActivation(options(f), deps(f));
		expect(outcome.wrote).toBe(false);
		if (!outcome.wrote)
			expect(outcome.refusal).toContain("hash-equal only right after a sync");
		expect(f.published).toHaveLength(0);
	} finally {
		f.cleanup();
	}
});

test("port overrides: machine mapping wins over declared, invalid values throw", () => {
	const f = fixture();
	try {
		writeActivation(
			join(f.home, ".config/klh/service-activation.json"),
			receiptFixture(f.home),
		);
		const overridden = reblessActivation(
			options(f, { portOverrides: { "com.suspenders.buckle-spoke": 5000 } }),
			deps(f),
		);
		expect(overridden.wrote).toBe(true);
		if (overridden.wrote) {
			const spoke = f.published[0].services.find(
				(s) => s.label === "com.suspenders.buckle-spoke",
			);
			expect(spoke?.port).toBe(5000);
		}
		f.published.length = 0;
		expect(() =>
			reblessActivation(
				options(f, { portOverrides: { "com.suspenders.buckle-spoke": 0 } }),
				deps(f),
			),
		).toThrow("Invalid machine service port mapping");
		expect(f.published).toHaveLength(0);
	} finally {
		f.cleanup();
	}
});

test("activationDiff renders sha arrows, changed units and retained labels", () => {
	const f = fixture();
	try {
		writeActivation(
			join(f.home, ".config/klh/service-activation.json"),
			receiptFixture(f.home),
		);
		const outcome = reblessActivation(options(f, { confirm: undefined }), deps(f));
		expect(outcome.wrote).toBe(false);
		const lines = outcome.diff;
		expect(lines[0]).toContain("manifest: /previous/manifest.yaml");
		expect(lines[1]).toContain(`-> ${digestUnit(readFileSync(f.genManifest))}`);
		expect(lines.join("\n")).toContain(
			"- com.suspenders.retired (retained from prior intent, absent from candidate render)",
		);
		expect(lines.join("\n")).toContain("args [");
	} finally {
		f.cleanup();
	}
});

test("CLI: verb refuses without explicit intent and without a receipt", () => {
	const script = join(import.meta.dir, "rebless-activation.ts");
	const bare = Bun.spawnSync(
		[process.execPath, script],
		{ stdout: "pipe", stderr: "pipe" },
	);
	expect(bare.exitCode).toBe(2);
	expect(bare.stderr.toString()).toContain("--re-bless-activation");
	const fakeHome = mkdtempSync(join(tmpdir(), "rebless-cli-"));
	try {
		const noReceipt = Bun.spawnSync(
			[process.execPath, script, "--re-bless-activation"],
			{
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, HOME: fakeHome },
			},
		);
		expect(noReceipt.exitCode).toBe(2);
		expect(noReceipt.stderr.toString()).toContain(
			"no readable activation receipt",
		);
	} finally {
		rmSync(fakeHome, { recursive: true, force: true });
	}
});
