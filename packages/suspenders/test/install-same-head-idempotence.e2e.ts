// test/install-same-head-idempotence.e2e.ts — W2546.3 regression: a repeat
// ordinary install at the SAME head must preserve a healthy gateway. The
// 2026-11-02 incident (root evidence work/install-normal-{,repeat-}*.json):
// two identical installs published two generation UUIDs because the
// in-process gateway build embedded the random stage path in its generated
// comments (payload digests differed), so the generation carry could never
// settle and the PID bounced 36491 → 50850. These specs run the REAL
// syncHarness publication over kit scratch worlds (no live services, no
// launchd) and drive activation through the injected lifecycle seams.
import { expect, test } from "@playwright/test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import { syncHarness } from "../scripts/sync-harness.ts";
import type { StepContext } from "../scripts/install/install-run.ts";
import {
	activateGateway,
	type ActivateDeps,
} from "../scripts/install/install-activate-gateway.ts";
import type { CarryDeps } from "../scripts/lib/post-merge-carry.ts";
import type { GatewayUpgrade } from "../scripts/upgrade-gateway.ts";

const LABEL = "com.suspenders.buckle-spoke";

test.describe("@unit W2546.3 same-HEAD reinstall idempotence", () => {
	// #102875: every fixture world registers AT CREATION — a fixture that
	// throws mid-build still cleans in afterEach, and the env pins restore
	// BEFORE the world tears down. Never a trailing clean() inside a test.
	type Registered = { restore: () => void; clean: () => void };
	const registered: Registered[] = [];
	test.afterEach(() => {
		// LIFO: a second fixture overwrote the first's pins — unwind in reverse
		for (const entry of registered.splice(0).reverse()) {
			entry.restore();
			entry.clean();
		}
	});

	/** The committed fixture payload (same face set the sync-harness suite
	 *  pins: every CLOSURE_ENTRIES face exists, so sourcePaths' walk ships). */
	function syncFixture(prefixTag: string) {
		const world = scratchWorld({ prefix: `w2546-3-${prefixTag}-` });
		// #102875: ScratchWorld.env is NOT auto-applied — pin the process env
		// (restored before cleanup) so EVERY spawned child — fixture git,
		// syncHarness's bun install/build children — sees the fixture HOME,
		// an inert governor store and a dead Kev bus, never the lane's real
		// config; a fixture that throws mid-build still cleans in afterEach.
		const saved = {
			home: process.env.HOME,
			governor: process.env.GOVERNOR_STORE_URL,
			kev: process.env.SUSPENDERS_KEV_URL,
			gitGlobal: process.env.GIT_CONFIG_GLOBAL,
			gitSystem: process.env.GIT_CONFIG_SYSTEM,
			bunInstall: process.env.BUN_INSTALL,
		};
		// the real bun package cache must survive the HOME pin (W1050: an
		// empty cache sends the ladder to its network leg) — capture the
		// machine's location BEFORE the pin and hand it to every child.
		const realBun =
			saved.bunInstall ?? (saved.home ? join(saved.home, ".bun") : undefined);
		process.env.HOME = world.home;
		process.env.GOVERNOR_STORE_URL = "local";
		process.env.SUSPENDERS_KEV_URL = "http://127.0.0.1:1";
		process.env.GIT_CONFIG_GLOBAL = join(world.home, ".gitconfig");
		process.env.GIT_CONFIG_SYSTEM = join(world.home, ".gitconfig-system");
		if (realBun) process.env.BUN_INSTALL = realBun;
		registered.push({
			// #102900: assigning a saved undefined stringifies ("present:
			// true, value 'undefined'") — delete the key when it was absent.
			restore: () => {
				if (saved.home === undefined) delete process.env.HOME;
				else process.env.HOME = saved.home;
				if (saved.governor === undefined) delete process.env.GOVERNOR_STORE_URL;
				else process.env.GOVERNOR_STORE_URL = saved.governor;
				if (saved.kev === undefined) delete process.env.SUSPENDERS_KEV_URL;
				else process.env.SUSPENDERS_KEV_URL = saved.kev;
				if (saved.gitGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
				else process.env.GIT_CONFIG_GLOBAL = saved.gitGlobal;
				if (saved.gitSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
				else process.env.GIT_CONFIG_SYSTEM = saved.gitSystem;
				if (saved.bunInstall === undefined) delete process.env.BUN_INSTALL;
				else process.env.BUN_INSTALL = saved.bunInstall;
			},
			clean: () => world.clean(),
		});
		const source = join(world.home, "source");
		mkdirSync(source, { recursive: true });
		const git = (...args: string[]) => {
			const result = Bun.spawnSync(["git", "-C", source, ...args], {
				stdout: "pipe",
				stderr: "pipe",
			});
			if (result.exitCode !== 0)
				throw new Error(
					`fixture git ${args[0]}: ${result.stderr.toString().slice(0, 200)}`,
				);
			return result.stdout.toString().trim();
		};
		const put = (relative: string, value: string) => {
			const file = join(source, relative);
			mkdirSync(join(file, ".."), { recursive: true });
			writeFileSync(file, value);
		};
		for (const [dir, name] of [
			["suspenders", "@klh/suspenders"],
			["belt", "@klh/belt"],
			["local-llm", "@klh/local-llm"],
			["blam", "@klh/blam"],
			["buckle", "@klh/buckle"],
			["telemetry", "@klh/telemetry"],
		] as const)
			put(
				`packages/${dir}/package.json`,
				JSON.stringify({
					name,
					version: "1.0.0",
					type: "module",
					dependencies: dir === "suspenders" ? { blam: "workspace:*" } : {},
				}),
			);
		for (const name of [
			"bin",
			"lib",
			"board-html",
			"coord",
			"board",
			"gates",
			"launchd",
			"rules",
		])
			put(
				`packages/suspenders/hooks/${name}/fixture.ts`,
				"export const value = 1;",
			);
		for (const file of [
			"gate.ts",
			"session-start.ts",
			"subagent-start.ts",
			"session-end.ts",
			"pre-compact.ts",
			"statusline.ts",
			"subagent-statusline.ts",
			"bin/coord.ts",
			"bin/work.ts",
			"bin/oracle.ts",
			"bin/fleet-loop.ts",
			"bin/fleet-tracker.ts",
			"bin/fleet-watch.ts",
			"bin/fleet-board.ts",
			"bin/morph.ts",
			"bin/llm-keepwarm.ts",
			"bin/fallback-drill.ts",
			"bin/soak.ts",
			"bin/review-reconcile.ts",
			"lib/morph.ts",
			"board/prompt-transform.ts",
			"knowledgeworker.md",
		])
			put(`packages/suspenders/hooks/${file}`, "export const value = 1;");
		for (const file of ["dispatch-next.ts", "supervise.ts", "lib/shared.ts"])
			put(`packages/suspenders/scripts/${file}`, "export const value = 1;");
		put("packages/telemetry/src/http-trace.ts", "export const trace = 1;");
		put(
			"packages/buckle/src/server.ts",
			'export { trace } from "../../telemetry/src/http-trace.ts";',
		);
		put("packages/buckle/routing-policy.json", "{}");
		put("packages/buckle/repo-policy.json", "{}");
		put("packages/buckle/upstreams.json", '{"groups":{"reviewed-default":[]}}');
		put(
			"packages/buckle/src/policy.ts",
			[
				'export const upstreams = new URL("../upstreams.json", import.meta.url);',
				'export const routing = new URL("../routing-policy.json", import.meta.url);',
				'export const repoPolicy = new URL("../repo-policy.json", import.meta.url);',
				'export { value } from "@klh/blam/src/fixture.ts";',
			].join("\n"),
		);
		put("packages/local-llm/fixture.ts", "export const value = 1;");
		put("packages/blam/src/fixture.ts", "export const value = 1;");
		for (const file of ["router-shim.ts", "supervisor.ts", "dashboard.ts"])
			put(`packages/belt/bin/${file}`, "export const value = 1;");
		put(
			"packages/belt/bin/fixture.ts",
			'export { value } from "../../local-llm/fixture.ts";',
		);
		put(
			"packages/suspenders/scripts/lib/agent-rules.ts",
			'import { resolve } from "node:path";\nexport const dir = resolve(import.meta.dir, "../../agent-rules");',
		);
		put(
			"packages/suspenders/agent-rules/fixture.ts",
			"export const value = 1;",
		);
		put("packages/suspenders/deploy/services.yaml", "services: []");
		put(
			".githooks/pre-commit",
			'#!/bin/sh\nexec bun "$P/hooks/bin/scrub-gate.ts" hook commit\n',
		);
		put(
			".githooks/pre-push",
			'#!/bin/sh\nexec bun "$P/hooks/bin/scrub-gate.ts" hook push\n',
		);
		git("init");
		git("add", ".");
		git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"-qm",
			"reviewed fixture",
		);
		const ctx: StepContext = {
			repo: join(source, "packages/suspenders"),
			prefix: join(world.home, "state/harness"),
			shimBin: join(world.home, "shims"),
			llmHome: join(world.home, "models"),
			home: world.home,
			dryRun: false,
			yes: true,
			json: true,
			verbose: false,
		};
		return { world, source, ctx, git, put };
	}

	/** The gateway proposal over the REALLY published fixture generation. */
	function proposalOver(
		prefix: string,
		unit: string,
		revision: string,
		payloadSha256: string,
	): GatewayUpgrade {
		const root = realpathSync(prefix);
		const bundle = join(root, ".harness/packages/buckle/src/server.bundle.js");
		const candidate = JSON.stringify({
			Label: LABEL,
			ProgramArguments: [process.execPath, bundle],
		});
		return {
			unit,
			beforeUnitSha256: "0".repeat(64),
			beforeReceiptSha256: "0".repeat(64),
			processSha256: "0".repeat(64),
			candidate,
			candidateSha256: "1".repeat(64),
			arguments: [process.execPath, bundle],
			generation: { root, revision, payloadSha256 },
			manifest: join(root, ".harness/packages/suspenders/deploy/services.yaml"),
		};
	}

	/** Instrumented adapter/readiness seams (install-activate-step.e2e.ts shape):
	 *  every process boundary observable, nothing live. */
	function activateDeps(
		proposal: GatewayUpgrade,
		liveUnit: () => string,
		loaded: () => string | null,
	): { deps: ActivateDeps; applied: string[]; readinessCalls: number[] } {
		const applied: string[] = [];
		const readinessCalls: number[] = [];
		const adapter: CarryDeps = {
			prepare: () => proposal,
			readUnit: liveUnit,
			unitToJson: (bytes) => bytes,
			publishedRevision: () => proposal.generation.revision,
			loadedRevision: loaded,
			daemonState: () => "loaded",
			applyReviewed: (sha) => {
				applied.push(sha);
				return { status: "ok", note: "fixture applied" };
			},
			log: () => {},
		};
		return {
			applied,
			readinessCalls,
			deps: {
				adapter: () => adapter,
				readiness: () => {
					readinessCalls.push(1);
					return { ready: true, reason: "probe ok (fixture seam)" };
				},
			},
		};
	}

	const receiptAt = (prefix: string): Record<string, unknown> =>
		JSON.parse(readFileSync(join(prefix, "harness-receipt.json"), "utf8"));

	/** Commit an external zod dependency into the fixture (the sync-harness
	 *  suite's materialization control shape): suspenders depends on zod, a
	 *  shipped face imports it, the resolver materializes it. */
	const commitZodDependency = (
		f: ReturnType<typeof syncFixture>,
		tag: string,
	) => {
		f.put(
			"packages/suspenders/package.json",
			JSON.stringify({
				name: "@klh/suspenders",
				version: "1.0.0",
				type: "module",
				dependencies: { blam: "workspace:*", zod: "^4.0.0" },
			}),
		);
		f.put(
			"packages/suspenders/hooks/board/prompt-transform.ts",
			'import { z } from "zod"; export const value = z.number().parse(1);',
		);
		f.git("add", ".");
		f.git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"-qm",
			`reviewed production dependency ${tag}`,
		);
	};

	test("same-HEAD reinstall retains the verified publication and activation settles without apply", async () => {
		const f = syncFixture("same-head");
		const first = await syncHarness(f.ctx);
		expect(first.status).toBe("ok");
		const generation = readlinkSync(f.ctx.prefix);
		const receipt = receiptAt(f.ctx.prefix);
		const receiptBytes = readFileSync(
			join(f.ctx.prefix, "harness-receipt.json"),
		);

		const second = await syncHarness(f.ctx);
		expect(second.status).toBe("ok");
		expect(second.note).toContain("publication retained");
		// one generation: the pointer never moved, no new UUID was minted
		expect(readlinkSync(f.ctx.prefix)).toBe(generation);
		expect(
			readFileSync(join(f.ctx.prefix, "harness-receipt.json")).equals(
				receiptBytes,
			),
		).toBe(true);
		expect(existsSync(join(f.ctx.prefix, "bin/fleet-loop.ts"))).toBe(true);

		// the default-plan activation over the retained publication: the carry
		// settles (loaded daemon already executes this generation's bundle) —
		// NO fenced apply, readiness still proven through the seam.
		const unit = join(f.world.home, "Library/LaunchAgents", `${LABEL}.plist`);
		const proposal = proposalOver(
			f.ctx.prefix,
			unit,
			receipt.revision as string,
			receipt.payloadSha256 as string,
		);
		const { deps, applied, readinessCalls } = activateDeps(
			proposal,
			() => proposal.candidate,
			() => receipt.revision as string,
		);
		const result = await activateGateway({ ...f.ctx, wireRepo: null }, deps);
		expect(result.status).toBe("ok");
		expect(applied).toHaveLength(0);
		expect(readinessCalls).toHaveLength(1);
	});

	test("same HEAD from two different source roots publishes the identical payload digest", async () => {
		const a = syncFixture("two-roots-a");
		// second root: a clone of the SAME committed tree — identical sources,
		// independent working root (the stage name differs every run by design)
		const clone = join(a.world.home, "source-clone");
		const cloned = Bun.spawnSync(["git", "clone", "-q", a.source, clone], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(cloned.exitCode).toBe(0);
		const b = {
			world: a.world,
			source: clone,
			ctx: { ...a.ctx, repo: join(clone, "packages/suspenders") },
		};
		const first = await syncHarness(a.ctx);
		const second = await syncHarness({
			...b.ctx,
			prefix: join(a.world.home, "state/harness-b"),
		});
		expect(first.status).toBe("ok");
		expect(second.status).toBe("ok");
		const receiptA = receiptAt(a.ctx.prefix);
		const receiptB = receiptAt(join(a.world.home, "state/harness-b"));
		// the deterministic child build (cwd=stage, relative entrypoint) makes
		// the payload digest a function of the committed tree alone — before
		// W2546.3 the random stage path leaked into the bundle comments and
		// these digests differed at the same HEAD.
		expect(receiptB.payloadSha256).toBe(receiptA.payloadSha256);
		const bundleA = readFileSync(
			join(a.ctx.prefix, ".harness/packages/buckle/src/server.bundle.js"),
		);
		const bundleB = readFileSync(
			join(
				a.world.home,
				"state/harness-b/.harness/packages/buckle/src/server.bundle.js",
			),
		);
		expect(bundleB.equals(bundleA)).toBe(true);
	});

	test("a tampered installed payload refuses reuse and republishes the repair", async () => {
		const f = syncFixture("tamper");
		await syncHarness(f.ctx);
		const generation = readlinkSync(f.ctx.prefix);
		const victim = join(
			f.ctx.prefix,
			".harness/packages/telemetry/src/http-trace.ts",
		);
		writeFileSync(victim, "export const trace = 2; // tampered");
		const repair = await syncHarness(f.ctx);
		expect(repair.status).toBe("ok");
		expect(repair.note).not.toContain("publication retained");
		expect(readlinkSync(f.ctx.prefix)).not.toBe(generation);
		expect(readFileSync(victim, "utf8")).toBe("export const trace = 1;");
	});

	test("changed options republish: --prune never reuses a default publication", async () => {
		const f = syncFixture("prune");
		await syncHarness(f.ctx);
		const generation = readlinkSync(f.ctx.prefix);
		const pruned = await syncHarness({ ...f.ctx, prune: true });
		expect(pruned.status).toBe("ok");
		expect(pruned.note).not.toContain("publication retained");
		expect(readlinkSync(f.ctx.prefix)).not.toBe(generation);
		expect(receiptAt(f.ctx.prefix).pruned).toEqual([]);
	});

	test("a lock appearing under a null-lock publication refuses reuse", async () => {
		const f = syncFixture("lock");
		await syncHarness(f.ctx);
		const receipt = receiptAt(f.ctx.prefix);
		// forge the legacy null-lock publication shape (dependencyLockSha256
		// null, no lock on disk) when the fixture already resolved deps —
		// the refused-reuse leg is what matters, not how the null pin arose
		const root = realpathSync(f.ctx.prefix);
		for (const lockName of ["bun.lock", "bun.lockb"])
			rmSync(join(root, lockName), { force: true });
		writeFileSync(
			join(root, "harness-receipt.json"),
			JSON.stringify({ ...receipt, dependencyLockSha256: null }),
		);
		const generation = readlinkSync(f.ctx.prefix);
		// a foreign lock appears under the null-pin publication
		writeFileSync(join(f.ctx.prefix, "bun.lock"), "unpinned foreign lock");
		const repair = await syncHarness(f.ctx);
		expect(repair.status).toBe("ok");
		expect(repair.note).not.toContain("publication retained");
		expect(readlinkSync(f.ctx.prefix)).not.toBe(generation);
	});

	test("a member-local-only dependency is healthy: reuse retains (#102924)", async () => {
		const f = syncFixture("member-local");
		commitZodDependency(f, "member-local");
		await syncHarness(f.ctx);
		const generation = readlinkSync(f.ctx.prefix);
		// #102924: the healthy real-install shape — members carry deps in
		// their OWN node_modules (bun's workspace resolution), not the
		// generation root; decant's 15 deps ride exactly this leg. Force the
		// member-local-only layout and prove retention: a root-only presence
		// gate would refuse every such reinstall.
		const memberZod = join(
			f.ctx.prefix,
			".harness/packages/suspenders/node_modules/zod",
		);
		const rootZod = join(f.ctx.prefix, "node_modules/zod");
		if (existsSync(rootZod) && !existsSync(memberZod)) {
			mkdirSync(dirname(memberZod), { recursive: true });
			renameSync(rootZod, memberZod);
		}
		expect(existsSync(memberZod)).toBe(true);
		const retained = await syncHarness(f.ctx);
		expect(retained.status).toBe("ok");
		expect(retained.note).toContain("publication retained");
		expect(readlinkSync(f.ctx.prefix)).toBe(generation);
	});

	test("a missing installed dependency refuses reuse and republishes the repair", async () => {
		const f = syncFixture("missing-dep");
		commitZodDependency(f, "missing-dep");
		await syncHarness(f.ctx);
		const generation = readlinkSync(f.ctx.prefix);
		expect(
			existsSync(join(f.ctx.prefix, "node_modules/zod/package.json")),
		).toBe(true);
		// #102876: delete the MATERIALIZED dep from EVERY location inside
		// the generation — the aggregate root manifest installs it at the
		// generation root AND bun's workspace resolution links it
		// member-local — while payload and lock stay intact. Reuse must
		// refuse (the old sync healed this); the repair republishes and
		// rematerializes it.
		const zodCopies = [
			join(f.ctx.prefix, "node_modules/zod"),
			join(f.ctx.prefix, ".harness/packages/suspenders/node_modules/zod"),
		];
		for (const copy of zodCopies)
			rmSync(copy, { recursive: true, force: true });
		for (const copy of zodCopies) expect(existsSync(copy)).toBe(false);
		const repair = await syncHarness(f.ctx);
		expect(repair.status).toBe("ok");
		expect(repair.note).not.toContain("publication retained");
		expect(readlinkSync(f.ctx.prefix)).not.toBe(generation);
		expect(
			existsSync(join(f.ctx.prefix, "node_modules/zod/package.json")),
		).toBe(true);
	});

	test("a new HEAD publishes a new generation and the carry applies it once", async () => {
		const f = syncFixture("new-head");
		await syncHarness(f.ctx);
		const oldBundle = join(
			realpathSync(f.ctx.prefix),
			".harness/packages/buckle/src/server.bundle.js",
		);
		f.put("packages/telemetry/src/http-trace.ts", "export const trace = 2;");
		f.git("add", ".");
		f.git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"-qm",
			"new head",
		);
		const publish = await syncHarness(f.ctx);
		expect(publish.status).toBe("ok");
		const receipt = receiptAt(f.ctx.prefix);
		expect(receipt.revision).toBe(f.git("rev-parse", "HEAD"));

		// live daemon still executes the OLD generation's bundle, loaded
		// revision is the old head: the generation-only candidate must apply
		// exactly once through the fenced seam, then prove readiness.
		const unit = join(f.world.home, "Library/LaunchAgents", `${LABEL}.plist`);
		const proposal = proposalOver(
			f.ctx.prefix,
			unit,
			receipt.revision as string,
			receipt.payloadSha256 as string,
		);
		const liveCandidate = JSON.stringify({
			Label: LABEL,
			ProgramArguments: [process.execPath, oldBundle],
		});
		const { deps, applied, readinessCalls } = activateDeps(
			proposal,
			() => liveCandidate,
			() => null as unknown as string,
		);
		const result = await activateGateway({ ...f.ctx, wireRepo: null }, deps);
		expect(result.status).toBe("ok");
		expect(applied).toHaveLength(1);
		expect(readinessCalls).toHaveLength(1);
	});

	test("a non-symlink prefix never reuses: the plain directory publishes normally", async () => {
		const f = syncFixture("plain-dir");
		// a pre-existing plain directory (first-migration shape) must publish
		// through the normal path — reuse requires a live generation pointer.
		await syncHarness(f.ctx);
		const generation = readlinkSync(f.ctx.prefix);
		rmSync(f.ctx.prefix);
		mkdirSync(f.ctx.prefix, { recursive: true });
		const result = await syncHarness(f.ctx);
		expect(result.status).toBe("ok");
		expect(lstatSync(f.ctx.prefix).isSymbolicLink()).toBe(true);
		expect(readlinkSync(f.ctx.prefix)).not.toBe(generation);
	});
});
