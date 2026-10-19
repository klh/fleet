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
import {
	type PlannedShim,
	planShims,
	restoreShims,
	writeShims,
} from "./ensure-shims.ts";
import type { StepContext, StepResult } from "./install-run.ts";

const SOURCE_PATHS = [
	".githooks",
	"packages/suspenders/hooks",
	"packages/suspenders/scripts",
	"packages/suspenders/deploy",
	"packages/suspenders/package.json",
	"packages/belt/bin",
	"packages/belt/package.json",
	"packages/buckle/upstreams.yaml",
	"packages/buckle/routing-policy.yaml",
	"packages/buckle/repo-policy.yaml",
	"packages/buckle/src",
	"packages/buckle/package.json",
	"packages/local-llm",
	"packages/blam/src",
	"packages/blam/bench/paired",
	"packages/blam/bench/improve",
	"packages/blam/package.json",
];
const ENTRYPOINTS = [
	"hooks/gate.ts",
	"hooks/session-start.ts",
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
	"scripts/dispatch-next.ts",
	"scripts/supervise.ts",
];

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

async function archive(
	repo: string,
	revision: string,
	destination: string,
): Promise<void> {
	const source = Bun.spawn(
		["git", "-C", repo, "archive", revision, ...SOURCE_PATHS],
		{ stdout: "pipe", stderr: "pipe" },
	);
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
	// W780: name the offending files — the bare "working payload is dirty"
	// verdict forced a stash-dance to find them. diff --name-only: one path
	// per line, no porcelain status columns to mis-slice.
	const dirty = git(repo, [
		"diff",
		"--name-only",
		"HEAD",
		"--",
		...SOURCE_PATHS,
	]);
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
		await archive(repo, revision, payload);
		const packageRoot = join(payload, "packages");
		const suspenders = join(packageRoot, "suspenders");
		const manifest = JSON.parse(
			readFileSync(join(suspenders, "package.json"), "utf8"),
		);
		const beltManifest = JSON.parse(
			readFileSync(join(packageRoot, "belt", "package.json"), "utf8"),
		);
		const dependencies: Record<string, string> = {};
		for (const item of [manifest, beltManifest]) {
			for (const [name, version] of Object.entries(item.dependencies ?? {})) {
				if (typeof version !== "string" || version.startsWith("workspace:"))
					continue;
				if (dependencies[name] && dependencies[name] !== version)
					throw new Error(`Conflicting installed dependency ${name}`);
				dependencies[name] = version;
			}
		}
		for (const name of ["suspenders", "belt", "local-llm", "blam"]) {
			const path = join(packageRoot, name, "package.json");
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
				"hooks/lib/auth.ts",
				"hooks/lib/auth-server.ts",
				"hooks/bin/auth.ts",
				"hooks/lib/hub-tokens.ts",
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
		await command(
			[
				process.execPath,
				"install",
				"--offline",
				"--ignore-scripts",
				"--lockfile-only",
				"--save-text-lockfile",
			],
			stage,
		);
		await command(
			[
				process.execPath,
				"install",
				"--production",
				"--offline",
				"--ignore-scripts",
				"--frozen-lockfile",
			],
			stage,
		);
		mkdirSync(join(stage, "node_modules"), { recursive: true });
		// blam's package name is scoped (@klh/blam) — the link must sit at the
		// scoped path or every `@klh/blam/...` import in the staged harness
		// fails to resolve and validate (2026-10-08 install blocker).
		mkdirSync(join(stage, "node_modules/@klh"), { recursive: true });
		// link content is relative to the link's own dir (node_modules/@klh):
		// up two to stage/, then into .harness/packages/blam
		link("../../.harness/packages/blam", join(stage, "node_modules/@klh/blam"));
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
