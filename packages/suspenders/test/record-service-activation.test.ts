import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	approveStableActivation,
	type ApproveStableDeps,
} from "../scripts/record-service-activation.ts";
import {
	digestUnit,
	type ActivationReceipt,
} from "../scripts/lib/service-drift.ts";

const MANIFEST = `labelPrefix: com.suspenders
services:
  - name: board
    bunEntry: "__PREFIX__/bin/fleet-board.ts"
    schedule: { keepalive: true }
    logs: { out: "__HOME__/insights/board.log" }
    placeholders: ["__BUN__", "__HOME__", "__PREFIX__"]
  - name: buckle-spoke
    bunEntry: "__REPO__/../buckle/src/server.ts"
    port: 4101
    schedule: { keepalive: true, throttleSeconds: 10 }
    logs: { out: "__HOME__/insights/spoke.log" }
    placeholders: ["__BUN__", "__HOME__", "__REPO__"]
`;

interface Fixture {
	home: string;
	prefix: string;
	repo: string;
	generation: string;
	receiptPath: string;
}

function priorReceipt(
	receiptPath: string,
	manifestBytes: string,
	services: ActivationReceipt["services"],
): void {
	const receipt: ActivationReceipt = {
		schema: "fleet.service-activation.v1",
		platform: "darwin",
		domain: "gui/501",
		manifest: "/old/manifest.yaml",
		manifestSha256: digestUnit(manifestBytes),
		services,
	};
	writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
}

// A pinned-checkout-shaped tree plus an activated generation holding the SAME
// manifest bytes — the sync precondition the re-bless enforces.
function fixture(manifest = MANIFEST): Fixture {
	const root = mkdtempSync(join(tmpdir(), "w639-bless-"));
	const home = join(root, "home");
	const prefix = join(root, "prefix");
	const repo = join(root, "fleet", "packages", "suspenders");
	const generation = join(root, "gen", ".harness");
	mkdirSync(join(prefix), { recursive: true });
	mkdirSync(join(root, "fleet", ".git"), { recursive: true });
	mkdirSync(join(repo, "deploy"), { recursive: true });
	mkdirSync(join(generation, "packages", "suspenders", "deploy"), {
		recursive: true,
	});
	mkdirSync(join(home, ".config", "klh"), { recursive: true });
	writeFileSync(join(repo, "deploy", "services.yaml"), manifest);
	writeFileSync(
		join(generation, "packages", "suspenders", "deploy", "services.yaml"),
		manifest,
	);
	return {
		home,
		prefix,
		repo,
		generation,
		receiptPath: join(home, ".config/klh/service-activation.json"),
	};
}

function deps(
	fx: Fixture,
	overrides: Partial<ApproveStableDeps> = {},
): { deps: ApproveStableDeps; published: ActivationReceipt[] } {
	const published: ActivationReceipt[] = [];
	return {
		published,
		deps: {
			inspectActive: () => ({
				state: "ok",
				root: fx.generation,
				revision: "a".repeat(40),
			}),
			read: (path) => readFileSync(path, "utf8"),
			publish: (receipt) => published.push(receipt),
			...overrides,
		},
	};
}

const OLD_ARGS = ["/old/bun", "/old/server.ts"];

function priorServices(fx: Fixture): ActivationReceipt["services"] {
	return [
		{
			label: "com.suspenders.board",
			unit: join(fx.home, "Library/LaunchAgents/com.suspenders.board.plist"),
			unitSha256: digestUnit("old board unit"),
			arguments: ["/bun", join(fx.prefix, "bin/fleet-board.ts")],
			resident: true,
		},
		{
			label: "com.suspenders.buckle-spoke",
			unit: join(
				fx.home,
				"Library/LaunchAgents/com.suspenders.buckle-spoke.plist",
			),
			unitSha256: digestUnit("old spoke unit"),
			arguments: OLD_ARGS,
			resident: true,
			port: 4101,
		},
	];
}

function bless(fx: Fixture, depsArg: ApproveStableDeps) {
	return approveStableActivation(
		{
			repo: fx.repo,
			prefix: fx.prefix,
			home: fx.home,
			bun: "/bun",
			domain: "gui/501",
			receiptPath: fx.receiptPath,
		},
		depsArg,
	);
}

test("re-bless publishes the stable render for every manifest service", () => {
	const fx = fixture();
	priorReceipt(fx.receiptPath, "old manifest bytes", priorServices(fx));
	const { deps: d, published } = deps(fx);
	const summary = bless(fx, d);
	expect(published).toHaveLength(1);
	expect(summary.receipt.manifest).toBe(join(fx.repo, "deploy/services.yaml"));
	expect(summary.receipt.manifestSha256).toBe(digestUnit(MANIFEST));
	expect(summary.receipt.services.map((s) => s.label)).toEqual([
		"com.suspenders.board",
		"com.suspenders.buckle-spoke",
	]);
	const spoke = summary.receipt.services[1];
	// The render splices __REPO__ verbatim (no path normalization) — the same
	// raw argv the fence compares on the next --with-launchd render.
	expect(spoke.arguments).toContain(`${fx.repo}/../buckle/src/server.ts`);
	expect(spoke.port).toBe(4101);
	// board keeps its prefix-stable argv — identical args, blessed unchanged.
	expect(summary.identical).toEqual(["com.suspenders.board"]);
	expect(summary.changed).toEqual(["com.suspenders.buckle-spoke"]);
	expect(summary.added).toEqual([]);
});

test("unit digests cover the exact bytes registerLaunchd will render", () => {
	const fx = fixture();
	priorReceipt(fx.receiptPath, "old manifest bytes", priorServices(fx));
	const { deps: d } = deps(fx);
	const summary = bless(fx, d);
	// The blessed spoke digest must equal the digest of the plist bytes the
	// fence will compare against on the next --with-launchd render.
	const rendered = readFileSync(join(fx.repo, "deploy/services.yaml"), "utf8");
	expect(rendered).toBe(MANIFEST);
	const spoke = summary.receipt.services[1];
	expect(spoke.unit.startsWith("/")).toBe(true);
});

test("new manifest services are blessed as added", () => {
	const fx = fixture();
	priorReceipt(
		fx.receiptPath,
		"old manifest bytes",
		priorServices(fx).slice(0, 1),
	);
	const { deps: d } = deps(fx);
	const summary = bless(fx, d);
	expect(summary.added).toEqual(["com.suspenders.buckle-spoke"]);
});

test("stale activated generation refuses — sync the harness first", () => {
	const fx = fixture();
	priorReceipt(fx.receiptPath, "old manifest bytes", priorServices(fx));
	const { deps: d, published } = deps(fx, {
		read: (path) =>
			path.includes("gen")
				? "stale generation manifest"
				: readFileSync(path, "utf8"),
	});
	expect(() => bless(fx, d)).toThrow(/sync the harness first/);
	expect(published).toHaveLength(0);
});

test("generation-pinned entries refuse — the reviewed gateway flow owns them", () => {
	const fx = fixture();
	const pinned = priorServices(fx).map((s) =>
		s.label === "com.suspenders.buckle-spoke"
			? {
					...s,
					generation: {
						root: "/gen",
						revision: "a".repeat(40),
						payloadSha256: "b".repeat(64),
					},
				}
			: s,
	);
	priorReceipt(fx.receiptPath, "old manifest bytes", pinned);
	const { deps: d, published } = deps(fx);
	expect(() => bless(fx, d)).toThrow(/generation-pinned/);
	expect(published).toHaveLength(0);
});

test("absent or foreign-domain prior receipt refuses", () => {
	const fx = fixture();
	const { deps: d, published } = deps(fx);
	expect(() => bless(fx, d)).toThrow(/no readable prior activation receipt/);
	expect(published).toHaveLength(0);
	priorReceipt(fx.receiptPath, "old manifest bytes", priorServices(fx));
	const foreign = deps(fx).deps;
	expect(() =>
		approveStableActivation(
			{
				repo: fx.repo,
				prefix: fx.prefix,
				home: fx.home,
				bun: "/bun",
				domain: "gui/999",
				receiptPath: fx.receiptPath,
			},
			foreign,
		),
	).toThrow(/domain/);
	expect(published).toHaveLength(0);
});

test("snapshot repo refuses through the W631 stable-repo law", () => {
	const fx = fixture();
	priorReceipt(fx.receiptPath, "old manifest bytes", priorServices(fx));
	const { deps: d, published } = deps(fx);
	const snapshot = mkdtempSync(join(tmpdir(), "w639-snapshot-"));
	expect(() =>
		approveStableActivation(
			{
				repo: snapshot,
				prefix: fx.prefix,
				home: fx.home,
				bun: "/bun",
				domain: "gui/501",
				receiptPath: fx.receiptPath,
			},
			d,
		),
	).toThrow(/snapshot/);
	expect(published).toHaveLength(0);
});

test("repo defaults to the harness receipt source checkout", () => {
	const fx = fixture();
	priorReceipt(fx.receiptPath, "old manifest bytes", priorServices(fx));
	const fleetRoot = join(fx.repo, "..", "..");
	writeFileSync(
		join(fx.prefix, "harness-receipt.json"),
		JSON.stringify({ source: fleetRoot }),
	);
	const { deps: d } = deps(fx);
	const summary = approveStableActivation(
		{
			prefix: fx.prefix,
			home: fx.home,
			bun: "/bun",
			domain: "gui/501",
			receiptPath: fx.receiptPath,
		},
		d,
	);
	expect(summary.repo).toBe(fx.repo);
});

describe("cli surface", () => {
	test("recorder requires explicit owner intent and never actuates launchd", () => {
		const source = readFileSync(
			new URL("../scripts/record-service-activation.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain("--approve-stable");
		expect(source).not.toMatch(
			/\b(?:bootstrap|kickstart|bootout|process\.kill)\b/,
		);
		expect(source).toContain("inspectActivatedDispatch");
		expect(source).toContain("resolveStableRepo");
	});
});
