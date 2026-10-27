import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
	HOOK_ITEMS,
	MANAGED_PREFIX_ENTRIES,
	PRUNE_ALLOWLIST,
	payloadChecksum,
} from "../hooks/lib/harness-manifest.ts";
import { hubCapabilities, spokeCapabilities } from "../hooks/lib/profile.ts";
import { twinDrift } from "./belt-bin-overlay.ts";
import {
	type PlannedShim,
	planShims,
	restoreShims,
	writeShims,
} from "./ensure-shims.ts";
import type { StepContext, StepResult } from "./install-run.ts";
import { payloadClosure } from "./lib/source-closure.ts";

/** Faces the installer bundle-validates in the staged payload (validate()).
 *  Exported for the W1119.2 installer/runtime-parity guard
 *  (test/bypass-gate.test.ts). */
export const ENTRYPOINTS = [
	"hooks/gate.ts",
	"hooks/session-start.ts",
	"hooks/subagent-start.ts",
	"hooks/session-end.ts",
	"hooks/pre-compact.ts", // W253 checkpoint roll — validated with the other faces
	"hooks/bin/coord.ts",
	"hooks/bin/work.ts",
	"hooks/bin/oracle.ts",
	"hooks/bin/fleet-loop.ts",
	"hooks/bin/fleet-tracker.ts",
	"hooks/bin/fleet-watch.ts",
	"hooks/bin/fleet-board.ts", // W630: the board graph is the one that crash-looped unaudited
	"hooks/bin/morph.ts",
	// W1119.2: the gated inference runtime faces ride the same install-time
	// graph validation — what fleet-loop fires is what the installer proves.
	"hooks/bin/llm-keepwarm.ts",
	"hooks/bin/fallback-drill.ts",
	"hooks/bin/soak.ts",
	"hooks/bin/review-reconcile.ts",
	"scripts/dispatch-next.ts",
	"scripts/supervise.ts",
];
// W1256.1: the payload's import-graph faces (repo-relative) — the roots the
// closure walk (lib/source-closure.ts — the beltBinClosure walker) starts
// from; W1466 turned that walk from the hand list's auditor into its source.
export const CLOSURE_ENTRIES = [
	...ENTRYPOINTS.map((entry) => `packages/suspenders/${entry}`),
	"packages/buckle/src/server.ts",
	"packages/belt/bin/router-shim.ts",
	"packages/belt/bin/supervisor.ts",
	"packages/belt/bin/dashboard.ts",
];
// W1466: the payload is computed, never hand-listed — a sync archives the
// fixed-point closure (lib/source-closure.ts payloadClosure) of these faces:
// the import-graph entrypoints plus .githooks (W650: the W236 scrub-gate
// stubs ride the prefix by install contract, not by import). Whatever the
// graph reaches ships — the W1295 role library and the W1081 telemetry seam
// included — so the W661 class has no list left to drift.
export const PAYLOAD_FACES = [...CLOSURE_ENTRIES, ".githooks"];

/** The repo paths a sync archives: the closure of PAYLOAD_FACES over the
 *  files tracked at `revision`. A face missing from the tree refuses. */
export async function sourcePaths(
	repo: string,
	revision = "HEAD",
): Promise<string[]> {
	const root = git(repo, ["rev-parse", "--show-toplevel"]);
	const tracked = git(root, ["ls-tree", "-r", "-z", "--name-only", revision])
		.split("\0")
		.filter(Boolean);
	const closure = await payloadClosure({
		repoRoot: root,
		faces: PAYLOAD_FACES,
		tracked,
	});
	if (closure.missing.length > 0)
		throw new Error(
			`Payload faces vanished from the source tree: ${closure.missing.join(", ")}`,
		);
	return closure.paths;
}

function git(repo: string, args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", repo, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0)
		throw new Error(`Git source verification failed: ${args[0]}`);
	return result.stdout.toString().trim();
}

async function command(argv: string[], cwd: string): Promise<void> {
	const child = Bun.spawn(argv, {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 120_000,
	});
	const [code, output, error] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (code !== 0)
		throw new Error(
			`${basename(argv[0])} validation failed: ${(error || output).slice(-1500)}`,
		);
}

// W1050 cold-cache bootstrap: offline resolution needs cached package
// manifests. On a first install against an empty Bun cache every offline
// pass fails; the ladder fetches the locked manifests once (network,
// scripts disabled, lockfile-only — nothing executes, nothing materializes)
// and re-verifies the offline graph before materialization.
export function offlineResolveArgs(): string[] {
	return [
		process.execPath,
		"install",
		"--offline",
		"--ignore-scripts",
		"--lockfile-only",
		"--save-text-lockfile",
	];
}

/** The frozen production materialization: the exact graph the resolved
 *  lock pins, scripts disabled. The same argv minus --offline is the one
 *  bounded cold-cache archive fetch. */
export function productionInstallArgs(): string[] {
	return [
		process.execPath,
		"install",
		"--production",
		"--offline",
		"--ignore-scripts",
		"--frozen-lockfile",
	];
}

export function productionFetchArgs(): string[] {
	return productionInstallArgs().filter((arg) => arg !== "--offline");
}

/** W1124.6 cold-cache archive fallback: the W1050 resolver legs cache
 *  manifests only — the frozen offline production install still needs the
 *  locked package archives. On an offline materialization failure fetch
 *  that exact frozen graph once (network, scripts disabled, no lock
 *  drift) and retry offline; a failed fetch surfaces the ORIGINAL error
 *  so an existing prefix is never replaced by a failed sync. */
export async function materializeProduction(
	stage: string,
	run: (argv: string[], cwd: string) => Promise<void> = command,
): Promise<void> {
	try {
		await run(productionInstallArgs(), stage);
	} catch (offlineMaterializationError) {
		try {
			await run(productionFetchArgs(), stage);
		} catch {
			throw offlineMaterializationError;
		}
		await run(productionInstallArgs(), stage);
	}
}

/** W1050 fail-early verdict: both ladder legs failed — name the remedy. */
export function coldCacheVerdict(offline: unknown, fetch: unknown): Error {
	const text = (error: unknown): string =>
		error instanceof Error ? error.message : String(error);
	return new Error(
		`Dependency manifests are unavailable offline and the fetch failed; warm the cache with "bun install" in the fleet checkout, then retry the install. offline: ${text(offline)}; fetch: ${text(fetch)}`,
	);
}

/** W1050 cold-cache ladder: offline resolve; on failure fetch the locked
 *  manifests once (network, scripts disabled, lockfile-only) and re-verify
 *  offline. Throws the coldCacheVerdict when both legs fail. */
export async function materializeDependencies(
	stage: string,
	run: (argv: string[], cwd: string) => Promise<void> = command,
): Promise<void> {
	const offline = offlineResolveArgs();
	try {
		await run(offline, stage);
		return;
	} catch (offlineError) {
		try {
			await run(
				[
					process.execPath,
					"install",
					"--ignore-scripts",
					"--lockfile-only",
					"--save-text-lockfile",
				],
				stage,
			);
		} catch (fetchError) {
			throw coldCacheVerdict(offlineError, fetchError);
		}
		await run(offline, stage);
	}
}

async function archive(
	repo: string,
	revision: string,
	destination: string,
	paths: string[],
): Promise<void> {
	const source = Bun.spawn(["git", "-C", repo, "archive", revision, ...paths], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const unpack = Bun.spawn(["tar", "-x", "-C", destination], {
		stdin: source.stdout,
		stdout: "ignore",
		stderr: "pipe",
	});
	const [sourceCode, unpackCode] = await Promise.all([
		source.exited,
		unpack.exited,
		new Response(source.stderr).text(),
		new Response(unpack.stderr).text(),
	]);
	if (sourceCode !== 0 || unpackCode !== 0)
		throw new Error("Committed harness archive failed");
}

function link(target: string, destination: string): void {
	rmSync(destination, { recursive: true, force: true });
	symlinkSync(target, destination);
}

async function validate(stage: string): Promise<string> {
	const payload = join(stage, ".harness");
	// W1468: kit twins publish only as the full re-export of their pinned
	// belt/bin artifact — the runtime home and the harness share one face.
	const drift = twinDrift(payload);
	if (drift.length > 0)
		throw new Error(
			`Runtime twins diverge from the pinned artifact: ${drift.join("; ")}`,
		);
	const suspenders = join(payload, "packages/suspenders");
	const transpiler = new Bun.Transpiler({ loader: "ts" });
	for (const file of [
		...new Bun.Glob("**/*").scanSync({ cwd: payload, onlyFiles: true }),
	]) {
		if (file.endsWith(".ts") && !file.endsWith(".d.ts"))
			transpiler.transformSync(
				readFileSync(join(payload, file)).toString("utf8"),
			);
	}
	for (const relative of ENTRYPOINTS) {
		const result = await Bun.build({
			entrypoints: [join(suspenders, relative)],
			target: "bun",
			write: false,
			throw: false, // W630: surface WHICH entrypoint failed and why, not a bare "Bundle failed"
		});
		if (!result.success)
			throw new Error(
				`Staged import graph failed (${relative}): ${result.logs.map(String).join("; ").slice(0, 1500)}`,
			);
	}
	// This import is side-effect-free; CLI entrypoints are built, never executed.
	for (const module of [
		"hooks/board/prompt-transform.ts",
		"hooks/lib/morph.ts",
	])
		await command(
			[
				process.execPath,
				"-e",
				"await import(process.argv[1])",
				join(suspenders, module),
			],
			stage,
		);
	// Bundle the gateway's complete dependency graph (including vendored blam).
	// Never execute the server while validating or publishing code.
	const gateway = await Bun.build({
		entrypoints: [join(payload, "packages/buckle/src/server.ts")],
		target: "bun",
		write: false,
		throw: false,
	});
	if (!gateway.success || gateway.outputs.length !== 1)
		throw new Error("Staged gateway import graph failed");
	writeFileSync(
		join(payload, "packages/buckle/src/server.bundle.js"),
		await gateway.outputs[0].text(),
		{ mode: 0o444 },
	);
	return payloadChecksum(payload);
}

/** Code-only publication. No runtime home, service manager, model or Caddy operations. */
export async function syncHarness(
	ctx: StepContext & { expectedRevision?: string; prune?: boolean },
	publish: (source: string, destination: string) => void = renameSync,
): Promise<StepResult> {
	const repo = git(ctx.repo, ["rev-parse", "--show-toplevel"]);
	const revision = git(repo, ["rev-parse", "HEAD"]);
	if (ctx.expectedRevision && ctx.expectedRevision !== revision)
		throw new Error(
			"Source revision changed during dashboard refresh; rerun from a consistent capture",
		);
	// W1243: the prefix is a shared runtime — only main (or a descendant of
	// it) may be published. 2026-10-23 outage: a lane ran install.sh from its
	// pre-W1236 worktree branch and the shared harness regressed, silently
	// reverting the review-runner fixes fleet-wide. Behind and diverged
	// sources both refuse; SUSPENDERS_SYNC_ALLOW_BRANCH=1 is the explicit
	// lane-testing escape.
	if (process.env.SUSPENDERS_SYNC_ALLOW_BRANCH !== "1") {
		const probe = (args: string[]): number =>
			Bun.spawnSync(["git", "-C", repo, ...args], {
				stdout: "pipe",
				stderr: "pipe",
			}).exitCode ?? 1;
		const mainSha = (() => {
			const r = Bun.spawnSync(
				["git", "-C", repo, "rev-parse", "--verify", "main"],
				{ stdout: "pipe", stderr: "pipe" },
			);
			return r.exitCode === 0 ? r.stdout.toString().trim() : null;
		})();
		if (
			mainSha &&
			mainSha !== revision &&
			probe(["merge-base", "--is-ancestor", mainSha, revision]) !== 0
		)
			throw new Error(
				`Refusing to sync a source behind or diverged from main (${revision.slice(0, 12)} vs main ${mainSha.slice(0, 12)}); install from the pinned checkout or set SUSPENDERS_SYNC_ALLOW_BRANCH=1`,
			);
	}
	// W1466: the ship list is computed at the published revision — the walk
	// that once audited a hand list (W1256.1) produces it, and a vanished
	// face refuses the sync inside sourcePaths.
	const shipped = await sourcePaths(repo, revision);
	// W780: name the offending files — the bare "working payload is dirty"
	// verdict forced a stash-dance to find them. diff --name-only: one path
	// per line, no porcelain status columns to mis-slice.
	const dirty = git(repo, ["diff", "--name-only", "HEAD", "--", ...shipped]);
	if (dirty)
		throw new Error(
			`Commit reviewed harness changes before code-only sync; working payload is dirty: ${dirty.split("\n").join(", ")}`,
		);
	const prefix = resolve(ctx.prefix),
		parent = dirname(prefix);
	if (
		lstatSync(prefix, { throwIfNoEntry: false })?.isSymbolicLink() &&
		!existsSync(prefix)
	)
		throw new Error("Installed prefix symlink is broken; repair before sync");
	if (prefix === repo || prefix.startsWith(`${repo}/`))
		throw new Error("Harness prefix must be outside the source repository");
	mkdirSync(parent, { recursive: true });
	const lock = `${prefix}.sync-lock`;
	let stage: string | undefined;
	const backup = `${prefix}.before-sync-${Date.now()}-${crypto.randomUUID()}`;
	const generation = `${prefix}.generation-${revision.slice(0, 12)}-${crypto.randomUUID()}`;
	let oldLink: string | null = null;
	let backedUp = false,
		published = false;
	// declared outside the try: the catch's rollback leg restores these
	let shims: PlannedShim[] = [];
	const pruned = new Set<string>(); // W420: unmanaged entries prune drops
	const pointer = `${prefix}.next-${crypto.randomUUID()}`;
	mkdirSync(lock); // Exclusive directory lock; all subsequent setup is covered by finally.
	try {
		stage = mkdtempSync(join(parent, `.${basename(prefix)}-stage-`));
		oldLink =
			existsSync(prefix) && lstatSync(prefix).isSymbolicLink()
				? readlinkSync(prefix)
				: null;
		if (existsSync(prefix)) {
			const installed = realpathSync(prefix);
			// W420 mirror mode: unmanaged entries ride along only when the
			// generated-files allowlist covers them; anything else is the cp -R
			// fork this flag exists to prune. Default keeps today's behavior —
			// every unmanaged entry is preserved (receipt.pruned = null).
			const keepUnmanaged = (top: string): boolean =>
				ctx.prune ? PRUNE_ALLOWLIST.has(top) : true;
			cpSync(installed, stage, {
				recursive: true,
				dereference: false,
				filter: (source) => {
					const top = relative(installed, source).split(/[\\/]/)[0];
					if (!top || MANAGED_PREFIX_ENTRIES.has(top)) return true;
					if (!keepUnmanaged(top)) {
						pruned.add(top);
						return false;
					}
					return true;
				},
			});
		}
		const payload = join(stage, ".harness");
		rmSync(payload, { recursive: true, force: true });
		mkdirSync(payload);
		await archive(repo, revision, payload, shipped);
		const packageRoot = join(payload, "packages");
		const suspenders = join(packageRoot, "suspenders");
		const manifest = JSON.parse(
			readFileSync(join(suspenders, "package.json"), "utf8"),
		);
		const beltManifest = JSON.parse(
			readFileSync(join(packageRoot, "belt", "package.json"), "utf8"),
		);
		// A25 (W1281.9): a dependency whose name matches a package shipped in
		// this payload is private — it resolves from the staged link below,
		// never from npm. Derived from the manifests, so a new @klh package
		// needs no list edit here to avoid an npm 404.
		const stagedNames = new Set(
			shipped
				.filter((rel) => rel.endsWith("/package.json"))
				.map((rel) => {
					const item = JSON.parse(readFileSync(join(payload, rel), "utf8"));
					return typeof item.name === "string" ? item.name : null;
				})
				.filter((name): name is string => name !== null),
		);
		const dependencies: Record<string, string> = {};
		for (const item of [manifest, beltManifest]) {
			for (const [name, version] of Object.entries(item.dependencies ?? {})) {
				if (
					typeof version !== "string" ||
					version.startsWith("workspace:") ||
					stagedNames.has(name)
				)
					continue;
				if (dependencies[name] && dependencies[name] !== version)
					throw new Error(`Conflicting installed dependency ${name}`);
				dependencies[name] = version;
			}
		}
		// every shipped manifest (the closure ships each touched package's)
		// sheds its dev-only fields
		for (const rel of shipped.filter((p) => p.endsWith("/package.json"))) {
			const path = join(payload, rel);
			const item = JSON.parse(readFileSync(path, "utf8"));
			delete item.devDependencies;
			delete item.workspaces;
			writeFileSync(path, JSON.stringify(item));
		}
		// W165: the spoke profile ships no hub-only code — the modules are
		// removed from the payload and capabilities.json records the variant
		// (grammar: hooks/lib/profile.ts; absent file = hub = dev exemption).
		if (ctx.profile === "spoke") {
			for (const rel of [
				"hooks/lib/auth/auth.ts",
				"hooks/lib/auth/auth-server.ts",
				"hooks/bin/auth.ts",
				"hooks/lib/auth/hub-tokens.ts",
				"hooks/board/routes-hub-admin.ts",
			]) {
				rmSync(join(payload, "packages/suspenders", rel), { force: true });
			}
		}
		writeFileSync(
			join(stage, "capabilities.json"),
			JSON.stringify(
				ctx.profile === "spoke" ? spokeCapabilities() : hubCapabilities(),
				null,
				"\t",
			),
		);
		writeFileSync(
			join(stage, "package.json"),
			JSON.stringify({
				name: "fleet-installed-harness",
				private: true,
				type: "module",
				dependencies,
			}),
		);
		rmSync(join(stage, "node_modules"), { recursive: true, force: true });
		rmSync(join(stage, "bun.lock"), { force: true });
		// Bun offline install does not save a lock by default: resolve one first,
		// then require that exact dependency graph for materialization. The root
		// manifest contains production dependencies only; Bun's production +
		// lockfile-only combination can incorrectly return without writing a lock.
		// W1050: the resolver is a cold-cache ladder — on an empty Bun cache the
		// offline leg fetches once via the network and re-verifies offline; both
		// legs failing fails the sync early with the remedy.
		// A25 ordering (W1281.9): the scoped @klh links are staged BEFORE
		// dependency materialization — a private name can never depend on the
		// registry (offline resolver or the network fallback both see the link
		// already in place; the manifest filter above keeps them out of the
		// resolved graph entirely).
		mkdirSync(join(stage, "node_modules"), { recursive: true });
		// blam's package name is scoped (@klh/blam) — the link must sit at the
		// scoped path or every `@klh/blam/...` import in the staged harness
		// fails to resolve and validate (2026-10-08 install blocker).
		mkdirSync(join(stage, "node_modules/@klh"), { recursive: true });
		// link content is relative to the link's own dir (node_modules/@klh):
		// up two to stage/, then into .harness/packages/blam
		link("../../.harness/packages/blam", join(stage, "node_modules/@klh/blam"));
		// W1303.2: the board's http-kit import rides the package name —
		// @klh/buckle needs the same scoped link (buckle/src is already a
		// staged payload for the gateway bundle).
		link(
			"../../.harness/packages/buckle",
			join(stage, "node_modules/@klh/buckle"),
		);
		// W1238.3: named @klh/telemetry imports (servicemon, buckle) resolve
		// through the same scoped link in the staged harness.
		link(
			"../../.harness/packages/telemetry",
			join(stage, "node_modules/@klh/telemetry"),
		);
		await materializeDependencies(stage);
		await materializeProduction(stage);
		mkdirSync(join(stage, "node_modules"), { recursive: true });
		for (const item of HOOK_ITEMS) {
			if (!existsSync(join(suspenders, "hooks", item)))
				throw new Error(`Missing harness payload: ${item}`);
			link(join(".harness/packages/suspenders/hooks", item), join(stage, item));
		}
		link(".harness/packages/suspenders/scripts", join(stage, "scripts"));
		link(".harness/packages/local-llm", join(stage, "local-llm"));
		link(".harness/packages/blam", join(stage, "blam"));
		// W650: the W236 scrub-gate stubs ride the prefix so other checkouts
		// can point core.hooksPath at the installed copy directly.
		link(".harness/.githooks", join(stage, ".githooks"));
		const digest = await validate(stage);
		const dependencyLock = ["bun.lock", "bun.lockb"]
			.map((file) => join(stage, file))
			.find((file) => existsSync(file));
		if (!dependencyLock && Object.keys(dependencies).length > 0)
			throw new Error(
				"Dependency installation did not produce a verifiable lockfile",
			);
		const receipt = {
			schema: "fleet.harness.v1",
			revision,
			source: repo,
			pruned: ctx.prune ? [...pruned].sort() : null,
			payloadSha256: digest,
			dependencyLockSha256: dependencyLock
				? new Bun.CryptoHasher("sha256")
						.update(readFileSync(dependencyLock))
						.digest("hex")
				: null,
			installedAt: new Date().toISOString(),
			backup: oldLink ?? (existsSync(prefix) ? backup : null),
		};
		writeFileSync(
			join(stage, "harness-receipt.json"),
			JSON.stringify(receipt, null, 2),
			{ mode: 0o600 },
		);
		shims = planShims(ctx.shimBin);
		renameSync(stage, generation);
		// Existing symlink replacement is atomic. First directory migration has a
		// short rename gap; every publication error restores the original directory.
		if (existsSync(prefix) && !oldLink) {
			renameSync(prefix, backup);
			backedUp = true;
		}
		symlinkSync(generation, pointer);
		publish(pointer, prefix);
		published = true;
		writeShims(prefix, shims, publish);
		const pruneNote = !ctx.prune
			? ""
			: pruned.size
				? `; pruned ${pruned.size} unmanaged entries: ${[...pruned].sort().join(", ")}`
				: "; mirror clean";
		return {
			status: "ok",
			note: `harness code synced at ${revision.slice(0, 12)}${pruneNote}; no services restarted`,
			detail: JSON.stringify(receipt),
		};
	} catch (error) {
		if (published) {
			rmSync(prefix, { force: true });
			if (oldLink) symlinkSync(oldLink, prefix);
			else if (backedUp) renameSync(backup, prefix);
			restoreShims(shims);
		} else if (backedUp) renameSync(backup, prefix);
		if (stage) rmSync(stage, { recursive: true, force: true });
		rmSync(generation, { recursive: true, force: true });
		throw error;
	} finally {
		rmSync(pointer, { force: true });
		rmSync(lock, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const argument = (name: string) => {
		const index = process.argv.indexOf(name);
		return index < 0 ? undefined : process.argv[index + 1];
	};
	const repo = argument("--repo"),
		prefix = argument("--prefix"),
		shimBin = argument("--shim-bin");
	const prune = process.argv.includes("--prune"); // W420 mirror mode
	if (!repo || !prefix || !shimBin)
		throw new Error("sync-harness requires --repo, --prefix and --shim-bin");
	console.log(
		(
			await syncHarness({
				repo,
				prefix,
				shimBin,
				llmHome: "",
				dryRun: false,
				yes: true,
				json: false,
				verbose: false,
				prune,
			})
		).note,
	);
}
