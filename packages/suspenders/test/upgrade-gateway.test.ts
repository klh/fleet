import { expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchPayloadDigest } from "../scripts/lib/activated-dispatch.ts";
import {
	digestUnit,
	writeActivation,
	readActivation,
	inspectServices,
} from "../scripts/lib/service-drift.ts";
import {
	prepareGatewayUpgrade,
	assertUpgradeSnapshot,
	gatewayReviewToken,
	upgradeGateway,
} from "../scripts/upgrade-gateway.ts";
import { assertBuckleActivation } from "../scripts/assert-service-activation.ts";
import { parseFlags } from "../scripts/install-cli.ts";

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gateway-review-")));
	const generation = join(root, "generation"),
		payload = join(generation, ".harness"),
		home = join(root, "home");
	const put = (path: string, bytes: string) => {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, bytes);
	};
	put(
		join(payload, "packages/suspenders/hooks/bin/fleet-loop.ts"),
		"export const value = 1;",
	);
	put(
		join(payload, "packages/suspenders/scripts/dispatch-next.ts"),
		"export const value = 1;",
	);
	put(
		join(payload, "packages/suspenders/deploy/services.yaml"),
		"approved manifest",
	);
	put(
		join(payload, "packages/buckle/src/server.bundle.js"),
		'throw new Error("gateway must never execute during preparation");',
	);
	mkdirSync(join(generation, "bin"));
	symlinkSync(
		join(payload, "packages/suspenders/hooks/bin/fleet-loop.ts"),
		join(generation, "bin/fleet-loop.ts"),
	);
	put(
		join(generation, "harness-receipt.json"),
		JSON.stringify({
			schema: "fleet.harness.v1",
			revision: "a".repeat(40),
			payloadSha256: dispatchPayloadDigest(payload),
		}),
	);
	put(join(root, "machine/database/existing.db"), "existing database");
	put(join(root, "machine/database/root.key"), "existing key");
	const unit = join(
		home,
		"Library/LaunchAgents/com.suspenders.buckle-spoke.plist",
	);
	put(
		unit,
		'<plist version="1.0"><dict><key>Label</key><string>com.suspenders.buckle-spoke</string><key>WorkingDirectory</key><string>/machine/database</string><key>EnvironmentVariables</key><dict><key>BUCKLE_DB</key><string>/machine/database/existing.db</string></dict><key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>exec &quot;$@&quot;</string><string>gateway</string><string>/bun</string><string>/mutable/src/server.ts</string></array></dict></plist>'.replaceAll(
			"/machine/database",
			join(root, "machine/database"),
		),
	);
	const receipt = join(home, ".config/klh/service-activation.json");
	writeActivation(receipt, {
		schema: "fleet.service-activation.v1",
		platform: "darwin",
		domain: `gui/${process.getuid()}`,
		manifest: "/manifest",
		manifestSha256: digestUnit("approved manifest"),
		services: [
			{
				label: "com.suspenders.buckle-spoke",
				unit,
				unitSha256: digestUnit(readFileSync(unit)),
				arguments: ["old-approved-entry"],
				resident: true,
			},
		],
	});
	return {
		root,
		generation,
		payload,
		home,
		unit,
		receipt,
		clean: () => rmSync(root, { recursive: true, force: true }),
	};
}
test("prepare pins real generation and preserves database cwd and machine environment without writes or execution", () => {
	const f = fixture();
	try {
		const before = readFileSync(f.unit, "utf8"),
			receipt = readFileSync(f.receipt, "utf8");
		const proposed = prepareGatewayUpgrade(
			f.generation,
			f.home,
			() => "stable process",
		);
		expect(
			gatewayReviewToken({
				...proposed,
				processSha256: "healthy replacement PID",
			}),
		).not.toBe(gatewayReviewToken(proposed));
		expect(
			gatewayReviewToken({ ...proposed, beforeReceiptSha256: "b".repeat(64) }),
		).not.toBe(gatewayReviewToken(proposed));
		expect(proposed.arguments.at(-1)).toBe(
			join(f.payload, "packages/buckle/src/server.bundle.js"),
		);
		expect(proposed.candidate).toContain("/machine/database/existing.db");
		expect(proposed.candidate).toContain("/machine/database");
		expect(readFileSync(f.unit, "utf8")).toBe(before);
		expect(readFileSync(f.receipt, "utf8")).toBe(receipt);
		expect(
			readFileSync(join(f.root, "machine/database/existing.db"), "utf8"),
		).toBe("existing database");
		expect(
			readFileSync(join(f.root, "machine/database/root.key"), "utf8"),
		).toBe("existing key");
		expect(existsSync(join(f.payload, "packages/buckle/buckle.db"))).toBe(
			false,
		);
		expect(() =>
			assertUpgradeSnapshot(
				proposed,
				before,
				receipt,
				proposed.generation,
				"stable process",
			),
		).not.toThrow();
		expect(() =>
			assertUpgradeSnapshot(
				proposed,
				before,
				receipt,
				proposed.generation,
				"healthy replacement PID",
			),
		).toThrow();
		for (const [unit, proof, generation] of [
			["changed unit", receipt, proposed.generation],
			[before, "changed receipt", proposed.generation],
			[before, receipt, { ...proposed.generation, revision: "b".repeat(40) }],
		] as const)
			expect(() =>
				assertUpgradeSnapshot(
					proposed,
					unit,
					proof,
					generation,
					"stable process",
				),
			).toThrow();
	} finally {
		f.clean();
	}
});
test("altered generation source refuses instead of reviewing mutable code", () => {
	const f = fixture();
	try {
		writeFileSync(
			join(f.payload, "packages/buckle/src/server.bundle.js"),
			"changed source",
		);
		expect(() =>
			prepareGatewayUpgrade(f.generation, f.home, () => "stable process"),
		).toThrow();
	} finally {
		f.clean();
	}
});
test("approval flag is bounded and only valid for explicit gateway upgrade", () => {
	expect(
		parseFlags({ step: "upgradeGateway", gatewayReview: "a".repeat(64) }, [])
			.error,
	).toBeUndefined();
	expect(
		parseFlags({ step: "registerLaunchd", gatewayReview: "a".repeat(64) }, [])
			.error,
	).toBeDefined();
	expect(
		parseFlags({ step: "upgradeGateway", gatewayReview: "HEAD" }, []).error,
	).toBeDefined();
});

test("service observation rejects altered activated bundle even with matching unit and launchd", () => {
	const f = fixture();
	try {
		const proposal = prepareGatewayUpgrade(
			f.generation,
			f.home,
			() => "stable process",
		);
		const receipt = readActivation(f.receipt);
		receipt.services[0].generation = proposal.generation;
		writeFileSync(
			join(f.payload, "packages/buckle/src/server.bundle.js"),
			"altered after activation",
		);
		const verdict = inspectServices(
			receipt,
			receipt.domain,
			receipt.manifest,
			() => ({ code: 0, out: "", error: "" }),
			(path) =>
				path === receipt.manifest
					? "approved manifest"
					: readFileSync(path, "utf8"),
		);
		expect(verdict[0].state).toBe("drift");
	} finally {
		f.clean();
	}
});

test("canonical staging and approved fake lifecycle preserve existing DB/key and refuse changed process before writes", async () => {
	const f = fixture(),
		previousHome = process.env.HOME,
		previousPrefix = process.env.SUSPENDERS_PREFIX;
	process.env.HOME = f.home;
	process.env.SUSPENDERS_PREFIX = f.generation;
	try {
		const ctx = {
			repo: join(f.payload, "packages/suspenders"),
			prefix: f.generation,
			shimBin: "/unused",
			llmHome: "/unused",
			dryRun: false,
			yes: true,
			json: true,
			verbose: true,
		};
		let loads = 0;
		const deps = {
			observe: () => "stable process",
			load: () => {
				assertBuckleActivation(f.unit);
				loads++;
				return { exitCode: 0 };
			},
		};
		const beforeUnit = readFileSync(f.unit, "utf8"),
			beforeReceipt = readFileSync(f.receipt, "utf8");
		const prepared = await upgradeGateway(ctx, deps);
		const token = JSON.parse(prepared.detail ?? "{}").reviewSha256;
		expect(loads).toBe(0);
		expect(readFileSync(f.unit, "utf8")).toBe(beforeUnit);
		expect(readFileSync(f.receipt, "utf8")).toBe(beforeReceipt);
		await expect(
			upgradeGateway(
				{ ...ctx, gatewayReview: token },
				{ ...deps, observe: () => "healthy new PID" },
			),
		).rejects.toThrow("approval differs");
		expect(loads).toBe(0);
		expect(readFileSync(f.unit, "utf8")).toBe(beforeUnit);
		expect(readFileSync(f.receipt, "utf8")).toBe(beforeReceipt);
		const result = await upgradeGateway({ ...ctx, gatewayReview: token }, deps);
		expect(result.status).toBe("ok");
		expect(loads).toBe(1);
		expect(readActivation(f.receipt).services[0].generation?.root).toBe(
			f.generation,
		);
		expect(
			readFileSync(join(f.root, "machine/database/existing.db"), "utf8"),
		).toBe("existing database");
		expect(
			readFileSync(join(f.root, "machine/database/root.key"), "utf8"),
		).toBe("existing key");
		expect(existsSync(join(f.payload, "packages/buckle/buckle.db"))).toBe(
			false,
		);
	} finally {
		process.env.HOME = previousHome;
		if (previousPrefix === undefined) delete process.env.SUSPENDERS_PREFIX;
		else process.env.SUSPENDERS_PREFIX = previousPrefix;
		f.clean();
	}
});
