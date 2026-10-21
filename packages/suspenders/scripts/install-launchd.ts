// scripts/install-launchd.ts — the W490.2 registerLaunchd step body: renders
// the fleet service manifest through scripts/install-services.ts (execa — the
// SAME emitters W488 landed) into ~/Library/LaunchAgents with install.sh's
// exact substitution defaults (command -v bun, $HOME, prefix, repo; BELT_URL /
// BELT_TOKEN ride process env exactly as the sed pass reads them), loads each
// unit via scripts/load-launchd.sh, and supersedes the pre-namespacing
// com.klh.* labels. Non-darwin: a no-op ("skipped"), matching install.sh's
// "--with-launchd skipped (not macOS)".
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { execa } from "execa";
import {
	digestUnit,
	parseLoadedArguments,
	readActivation,
	retainActivation,
	writeActivation,
	type ActivationReceipt,
	type ActivationService,
} from "./lib/service-drift.ts";
import type { StepContext, StepResult } from "./install-run.ts";
import { loadLegacyLabels } from "./install-services.ts";

// supersede the pre-namespacing agent labels so old and new never run side by
// side (same jobs, stale script paths, double keepwarm/monitor pings).
// W284/W640/W779 history: the retired set is DATA now — deploy/services.yaml
// `legacyLabels` (loadLegacyLabels below), read at registration time from
// the same manifest the units render from. One source, config-over-code.

// W631: registerLaunchd must render units only from a STABLE tree — the pinned
// checkout. A snapshot harness copy (no .git — the generation dirs under
// ~/.claude/hooks) is mutable and reapable: the 2026-10-11 outage ran
// install.ts --step registerLaunchd from $PREFIX/scripts, resolved __REPO__
// into suspenders.generation-<hash>/.harness (no packages/buckle) and the
// buckle-spoke crash-looped with governance:strict fail-closing dispatch.
// .git as a FILE is the linked-worktree marker (W427); a main checkout has
// the .git DIR. Snapshots normalize to the checkout named by the harness
// receipt's `source`; when that yields no pinned checkout, registration
// refuses. Supersedes W427's pinnedCheckoutRefusal, which waved the no-.git
// snapshot through — exactly the shape that crashed the spoke.
export type StableRepo =
	| { ok: true; repo: string; normalized: boolean }
	| { ok: false; refusal: string };

export function resolveStableRepo(repo: string, prefix: string): StableRepo {
	// Positive ID only — never classify by walking ancestors for a .git: the
	// ~/.claude dotfiles checkout puts a .git DIR above every snapshot under
	// the hooks dir, so a climb misclassifies the generation snapshot as a
	// pinned checkout (live-verified 2026-10-11).
	const repoGit = gitDirKind(repo);
	if (repoGit === "dir") return { ok: true, repo, normalized: false };
	if (basename(dirname(repo)) === "packages") {
		const root = dirname(dirname(repo));
		const rootGit = gitDirKind(root);
		if (rootGit === "dir") return { ok: true, repo, normalized: false };
		if (rootGit === "file")
			return {
				ok: false,
				refusal: `${join(root, ".git")} is a file — ${root} is a linked git worktree, not a pinned stack checkout; launchd units must not point into a reapable tree (run install.sh from the pinned checkout)`,
			};
	}
	return normalizeSnapshotRepo(repo, prefix);
}

// statSync(join(dir, ".git")): "dir" = a pinned checkout toplevel, "file" =
// the linked-worktree marker (W427), undefined = absent.
function gitDirKind(dir: string): "dir" | "file" | undefined {
	try {
		return statSync(join(dir, ".git")).isDirectory() ? "dir" : "file";
	} catch {
		return undefined;
	}
}

function normalizeSnapshotRepo(repo: string, prefix: string): StableRepo {
	const receiptPath = join(prefix, "harness-receipt.json");
	let source: string | undefined;
	try {
		const parsed = JSON.parse(readFileSync(receiptPath, "utf8")) as {
			source?: unknown;
		};
		if (typeof parsed.source === "string" && parsed.source.trim() !== "")
			source = parsed.source;
	} catch {
		/* absent or unreadable receipt is refused below */
	}
	if (source === undefined)
		return {
			ok: false,
			refusal: `${repo} is a snapshot harness copy (no .git) and ${receiptPath} names no source checkout — launchd units must not point into a reapable snapshot (run install.sh from the pinned checkout)`,
		};
	let checkoutStat: import("node:fs").Stats | undefined;
	try {
		checkoutStat = statSync(join(source, ".git"));
	} catch {
		/* source without .git is refused below */
	}
	const candidate = join(source, "packages", "suspenders");
	if (
		checkoutStat === undefined ||
		!checkoutStat.isDirectory() ||
		!existsSync(candidate)
	)
		return {
			ok: false,
			refusal: `${receiptPath} source ${source} is not a pinned stack checkout — launchd units must not point into a reapable snapshot (refresh the harness or run install.sh from the pinned checkout)`,
		};
	return { ok: true, repo: candidate, normalized: true };
}

// W576.7: publication may only bless definitions launchd actually LOADED.
// A supported writer rewriting the unit between bootstrap and receipt
// publication would otherwise be adopted silently — the loaded arguments are
// compared against the rendered unit and any mismatch refuses the unit.
export async function verifiedLoad(
	label: string,
	domain: string,
	expected: string[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const printed = await execa(
		"/bin/launchctl",
		["print", `${domain}/${label}`],
		{ reject: false, stdout: "pipe", stderr: "pipe" },
	);
	if (printed.exitCode !== 0)
		return { ok: false, reason: "loaded definition inspection failed" };
	const args = parseLoadedArguments(printed.stdout);
	if (args === null)
		return { ok: false, reason: "loaded arguments unavailable" };
	if (JSON.stringify(args) !== JSON.stringify(expected))
		return {
			ok: false,
			reason:
				"loaded arguments differ from the rendered unit — competing writer after load",
		};
	return { ok: true };
}

export async function registerLaunchd(ctx: StepContext): Promise<StepResult> {
	if (process.platform !== "darwin") {
		return {
			status: "skipped",
			note: "not macOS — launchd agents not registered (matches install.sh)",
		};
	}
	const stable = resolveStableRepo(ctx.repo, ctx.prefix);
	if (!stable.ok) {
		return { status: "failed", note: stable.refusal };
	}
	const repo = stable.repo;
	const home = process.env.HOME ?? "";
	const agentsDir = join(home, "Library", "LaunchAgents");
	const insightsDir = join(home, ".claude-insights");
	// W264: agent logs live in the private insights dir, never world-readable /tmp
	mkdirSync(insightsDir, { recursive: true, mode: 0o700 });
	chmodSync(insightsDir, 0o700);
	const bun = Bun.which("bun");
	if (bun === null) {
		return {
			status: "failed",
			note: "bun is not on PATH — cannot render services",
		};
	}
	const renderer = join(repo, "scripts/install-services.ts");
	const res = await execa(
		process.execPath,
		[
			renderer,
			"--target",
			"darwin",
			"--out",
			agentsDir,
			"--json",
			"--owner-initial-install",
			"--bun",
			bun,
			"--home",
			home,
			"--prefix",
			ctx.prefix,
			"--repo",
			repo,
		],
		{ cwd: repo, stderr: "inherit" },
	);
	const rendered = JSON.parse(res.stdout) as {
		services: Array<{ service: string; files: string[]; port?: number }>;
	};
	const plists = rendered.services.flatMap((s) =>
		s.files.filter((f) => f.endsWith(".plist")),
	);
	const receiptPath = join(home, ".config/klh/service-activation.json");
	let previous: ActivationReceipt | undefined;
	try {
		previous = readActivation(receiptPath);
	} catch {
		/* Unknown or absent intent is never invented. */
	}
	const failed: string[] = [];
	const refused: string[] = [];
	const activated: ActivationService[] = [];
	const ports = JSON.parse(
		process.env.SUSPENDERS_SERVICE_PORTS_JSON ?? "{}",
	) as Record<string, number>;
	// W546: the manifest may declare a listener port (buckle-spoke :4101) —
	// the receipt records it so supervision lsof-verifies the LISTENER, not
	// just the PID. A machine-level env override wins over the declaration.
	const declaredPorts = new Map(
		rendered.services.flatMap((s) =>
			s.port === undefined
				? []
				: s.files
						.filter((f) => f.endsWith(".plist"))
						.map((f) => [f.replace(/\.plist$/, ""), s.port as number]),
		),
	);
	if (
		Object.values(ports).some(
			(port) => !Number.isInteger(port) || port < 1 || port > 65535,
		)
	)
		throw new Error("Invalid machine service port mapping");
	for (const file of plists) {
		const label = file.replace(/\.plist$/, "");
		const unit = join(agentsDir, file);
		const log = join(insightsDir, `launchd-${label}.log`);
		const reviewed = previous?.services.find(
			(service) => service.label === label && service.generation,
		);
		// load-launchd.sh: plutil -lint, bootout, bootstrap, print — per-unit
		// diagnostics land in the insights log, never the installer's stdout
		const load = reviewed
			? { exitCode: 0 }
			: await execa(
					"bash",
					[
						join(repo, "scripts/load-launchd.sh"),
						unit,
						log,
						"--owner-initial-install",
					],
					{ reject: false, stdout: "pipe", stderr: "pipe" },
				);
		if (load.exitCode !== 0) failed.push(label);
		else {
			try {
				const parsed = await execa(
					"/usr/bin/plutil",
					["-convert", "json", "-o", "-", unit],
					{ stdout: "pipe", stderr: "pipe" },
				);
				const definition = JSON.parse(parsed.stdout) as {
					ProgramArguments: string[];
					KeepAlive?: boolean;
				};
				if (
					reviewed &&
					(digestUnit(readFileSync(unit)) !== reviewed.unitSha256 ||
						JSON.stringify(definition.ProgramArguments) !==
							JSON.stringify(reviewed.arguments))
				) {
					failed.push(label);
					refused.push(`${label} — reviewed unit changed during registration`);
					continue;
				}
				// machine env override wins, else the manifest declaration
				const port = ports[label] ?? declaredPorts.get(label);
				// W576.7: refuse units whose loaded arguments left the rendered
				// definition between bootstrap and publication.
				const verified = await verifiedLoad(
					label,
					`gui/${process.getuid()}`,
					definition.ProgramArguments,
				);
				if (!verified.ok) {
					failed.push(label);
					refused.push(`${label} — ${verified.reason}`);
					continue;
				}
				activated.push({
					label,
					unit,
					unitSha256: digestUnit(readFileSync(unit)),
					arguments: definition.ProgramArguments,
					resident: definition.KeepAlive === true,
					...(port === undefined ? {} : { port }),
					...(reviewed?.generation === undefined
						? {}
						: { generation: reviewed.generation }),
				});
			} catch {
				failed.push(label);
			}
		}
	}
	// Record only successful explicit registration attempts; generated files alone are not activation.
	const receipt: ActivationReceipt = {
		schema: "fleet.service-activation.v1",
		platform: "darwin",
		domain: `gui/${process.getuid()}`,
		manifest: join(repo, "deploy/services.yaml"),
		manifestSha256: digestUnit(
			readFileSync(join(repo, "deploy/services.yaml")),
		),
		services: activated,
	};
	writeActivation(receiptPath, retainActivation(receipt, previous));
	const superseded: string[] = [];
	const legacyLabels = loadLegacyLabels(join(repo, "deploy/services.yaml"));
	for (const legacy of legacyLabels) {
		await execa("launchctl", ["bootout", `gui/${process.getuid()}/${legacy}`], {
			reject: false,
			stdout: "pipe",
			stderr: "pipe",
		});
		const legacyPlist = join(agentsDir, `${legacy}.plist`);
		if (existsSync(legacyPlist)) {
			rmSync(legacyPlist);
			superseded.push(legacy);
		}
	}
	if (failed.length > 0) {
		return {
			status: "failed",
			note: `launchd jobs failed: ${failed.join(" ")}`,
			detail: `diagnostics: ${join(insightsDir, "launchd-<label>.log")}${refused.length > 0 ? `; refused: ${refused.join("; ")}` : ""}`,
		};
	}
	return {
		status: "ok",
		note: `${rendered.services.length} launchd agents rendered via install-services.ts and loaded${stable.normalized ? " — snapshot normalized to the pinned checkout (W631)" : ""}`,
		detail: `${agentsDir} — from deploy/services.yaml; legacy labels superseded: ${superseded.length > 0 ? superseded.join(" ") : "none"}`,
	};
}
