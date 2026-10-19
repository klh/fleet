#!/usr/bin/env bun
// scripts/rebless-activation.ts — W640 install-grade re-bless verb (the W639
// owner-GO mechanism, no longer a hand-run bun script). Corrects the private
// service-activation receipt BEFORE an install --with-launchd: the render
// fence (lib/service-activation-fence.ts) compares receipt.manifestSha256
// against the ACTIVE GENERATION's deploy/services.yaml, so a receipt recorded
// before the last harness sync refuses every render. Mechanics (lesson
// w639-rebless): candidate manifestSha256 is read from the active generation
// and must hash-equal the repo copy; per-service unitSha256 comes from the
// --out dry render (stdout inspection mode appends banners — the sha would
// differ); args come from that plist's ProgramArguments; the generation block
// stays absent (stable-path intent only).
//
// Usage (owner-gated, never accidental):
//   bun scripts/rebless-activation.ts --re-bless-activation \
//       --confirm <manifest-sha-prefix (>=12 hex of the NEW candidate sha)>
//       [--drop <label>]... [--home <path>] [--prefix <path>] [--repo <path>]
// A run without --confirm dry-renders, prints the old-intent vs candidate
// diff and names the sha to confirm — writes nothing. install.sh wires this
// as: ./install.sh --re-bless-activation --confirm <sha-prefix>

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectActivatedDispatch } from "./lib/activated-dispatch.ts";
import {
	type ActivationReceipt,
	digestUnit,
	readActivation,
	retainActivation,
	writeActivation,
} from "./lib/service-drift.ts";

export const CONFIRM_MIN = 12;

export interface ReblessOptions {
	home: string;
	prefix: string;
	repo: string;
	/** Explicit owner intent — the verb refuses without it. */
	intent: boolean;
	confirm?: string;
	/** W849: retired labels removed from prior-intent retention pre-merge. */
	drop: string[];
	/** Machine-level SUSPENDERS_SERVICE_PORTS_JSON override (install-launchd parity). */
	portOverrides?: Record<string, number>;
}

export interface RenderedService {
	service: string;
	files: string[];
	port?: number;
}

export interface ReblessDeps {
	inspectGeneration: (
		prefix: string,
	) => { state: string; root: string | null };
	/** install-services.ts --out <outDir> --json (never stdout — banners shift the sha). */
	render: (outDir: string) => RenderedService[];
	parseUnit: (bytes: string) => {
		ProgramArguments: string[];
		KeepAlive?: boolean;
	};
	publish: (receipt: ActivationReceipt) => void;
	uid: number;
}

export type ReblessOutcome =
	| { wrote: true; manifestSha256: string; services: number; diff: string[] }
	| { wrote: false; refusal: string; diff: string[] };

/** Gate for --confirm: >=12 hex chars that prefix the candidate manifest sha. */
export function confirmFailure(
	confirm: string | undefined,
	sha: string,
): string | null {
	if (confirm === undefined)
		return `refused: re-run with --confirm <manifest-sha-prefix> — the candidate manifest sha is ${sha}`;
	const value = confirm.toLowerCase();
	if (value.length < CONFIRM_MIN || !/^[a-f0-9]+$/.test(value) || !sha.startsWith(value))
		return `refused: --confirm ${confirm} does not prefix-match the candidate manifest sha ${sha} (>=${CONFIRM_MIN} hex chars)`;
	return null;
}

/** Old-receipt intent vs candidate render, one line per change — the operator reviews THIS. */
export function activationDiff(
	previous: ActivationReceipt | undefined,
	candidate: ActivationReceipt,
): string[] {
	const lines: string[] = [
		`manifest: ${previous?.manifest ?? "(none)"} -> ${candidate.manifest}`,
		`manifest sha: ${previous?.manifestSha256 ?? "(none)"} -> ${candidate.manifestSha256}`,
	];
	const oldServices = new Map(
		(previous?.services ?? []).map((service) => [service.label, service]),
	);
	const candidateLabels = new Set(candidate.services.map((s) => s.label));
	for (const service of candidate.services) {
		const old = oldServices.get(service.label);
		if (!old) {
			lines.push(`+ ${service.label} (new in intent)`);
			continue;
		}
		const changes: string[] = [];
		if (old.unitSha256 !== service.unitSha256)
			changes.push(
				`unit ${old.unitSha256.slice(0, 8)}.. -> ${service.unitSha256.slice(0, 8)}..`,
			);
		if (JSON.stringify(old.arguments) !== JSON.stringify(service.arguments))
			changes.push(
				`args ${JSON.stringify(old.arguments)} -> ${JSON.stringify(service.arguments)}`,
			);
		if (old.resident !== service.resident)
			changes.push(`resident ${old.resident} -> ${service.resident}`);
		if (old.port !== service.port)
			changes.push(`port ${old.port ?? "none"} -> ${service.port ?? "none"}`);
		if (changes.length > 0) lines.push(`~ ${service.label}: ${changes.join("; ")}`);
	}
	for (const label of oldServices.keys())
		if (!candidateLabels.has(label))
			lines.push(`- ${label} (retained from prior intent, absent from candidate render)`);
	return lines;
}

/** W849: retired labels leave prior intent BEFORE the retain merge — a
 * retained ghost re-flags the watchdog every pass. Render entries always win. */
export function dropActivationServices(
	receipt: ActivationReceipt,
	labels: readonly string[],
): ActivationReceipt {
	if (labels.length === 0) return receipt;
	const drop = new Set(labels);
	return {
		...receipt,
		services: receipt.services.filter((service) => !drop.has(service.label)),
	};
}

function portOverrideFailure(overrides: Record<string, number>): string | null {
	for (const port of Object.values(overrides))
		if (!Number.isInteger(port) || port < 1 || port > 65535)
			return `invalid machine service port mapping (${JSON.stringify(overrides)})`;
	return null;
}

export function reblessActivation(
	options: ReblessOptions,
	deps: ReblessDeps,
): ReblessOutcome {
	if (process.platform !== "darwin")
		throw new Error("launchd activation requires macOS");
	if (!options.intent)
		return {
			wrote: false,
			refusal:
				"refused: explicit --re-bless-activation owner intent required (never accidental)",
			diff: [],
		};
	if (
		options.portOverrides !== undefined &&
		portOverrideFailure(options.portOverrides) !== null
	)
		throw new Error("Invalid machine service port mapping");
	const receiptPath = join(options.home, ".config/klh/service-activation.json");
	let previous: ActivationReceipt;
	try {
		previous = readActivation(receiptPath);
	} catch {
		return {
			wrote: false,
			refusal: `refused: no readable activation receipt at ${receiptPath} — initial intent is install.sh --with-launchd territory, not a re-bless`,
			diff: [],
		};
	}
	for (const service of previous.services)
		if (service.generation)
			return {
				wrote: false,
				refusal: `refused: ${service.label} is generation-pinned in the existing receipt — the re-bless verb handles stable-path intent only (use the reviewed gateway upgrade path)`,
				diff: [],
			};
	const active = deps.inspectGeneration(options.prefix);
	if (active.state !== "ok" || active.root === null)
		return {
			wrote: false,
			refusal: `refused: active generation integrity unavailable (state ${active.state}) — refresh the harness first`,
			diff: [],
		};
	const activeManifest = join(
		active.root,
		"packages/suspenders/deploy/services.yaml",
	);
	const repoManifest = join(options.repo, "deploy/services.yaml");
	let activeSha: string;
	let repoSha: string;
	try {
		activeSha = digestUnit(readFileSync(activeManifest));
		repoSha = digestUnit(readFileSync(repoManifest));
	} catch {
		return {
			wrote: false,
			refusal: `refused: manifest unreadable at ${activeManifest} or ${repoManifest}`,
			diff: [],
		};
	}
	if (activeSha !== repoSha)
		return {
			wrote: false,
			refusal: `refused: active-generation manifest differs from the repo copy (${activeSha.slice(0, 12)} vs ${repoSha.slice(0, 12)}) — they hash-equal only right after a sync; sync/refresh the harness, then re-bless`,
			diff: [],
		};
	// Dry render via --out (byte-exact files); stdout mode appends banners and
	// would record a wrong unitSha256 (lesson w639-rebless).
	const outDir = mkdtempSync(join(tmpdir(), "rebless-activation-"));
	let candidate: ActivationReceipt;
	try {
		const rendered = deps.render(outDir);
		const services = rendered.map((entry) => {
			const plist = entry.files.find((file) => file.endsWith(".plist"));
			if (plist === undefined)
				throw new Error(
					`candidate render produced no plist for service "${entry.service}"`,
				);
			const bytes = readFileSync(join(outDir, plist));
			const definition = deps.parseUnit(bytes.toString());
			const label = `com.suspenders.${entry.service}`;
			const port = options.portOverrides?.[label] ?? entry.port;
			return {
				label,
				unit: join(options.home, "Library/LaunchAgents", plist),
				unitSha256: digestUnit(bytes),
				arguments: definition.ProgramArguments,
				resident: definition.KeepAlive === true,
				...(port === undefined ? {} : { port }),
			};
		});
		candidate = {
			schema: "fleet.service-activation.v1",
			platform: "darwin",
			domain: `gui/${deps.uid}`,
			manifest: repoManifest,
			manifestSha256: activeSha,
			services,
		};
	} catch (error) {
		return {
			wrote: false,
			refusal: `refused: candidate dry-render failed (${String(error)})`,
			diff: [],
		};
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
	const retained = dropActivationServices(previous, options.drop);
	const dropLines = options.drop.filter((label) =>
		previous.services.some((service) => service.label === label),
	);
	const diff = [
		...dropLines.map((label) => `- ${label} (dropped from prior intent)`),
		...activationDiff(retained, candidate),
	];
	const failure = confirmFailure(options.confirm, activeSha);
	if (failure !== null) return { wrote: false, refusal: failure, diff };
	deps.publish(retainActivation(candidate, retained));
	return {
		wrote: true,
		manifestSha256: activeSha,
		services: candidate.services.length,
		diff,
	};
}

export function parseReblessArgs(
	argv: string[],
): { ok: true; options: ReblessOptions } | { ok: false; reason: string } {
	const value = (flag: string): string | undefined => {
		const at = argv.findIndex(
			(entry) => entry === flag || entry.startsWith(`${flag}=`),
		);
		if (at < 0) return undefined;
		const inline = argv[at].includes("=")
			? argv[at].slice(argv[at].indexOf("=") + 1)
			: undefined;
		if (inline !== undefined) return inline === "" ? undefined : inline;
		const v = argv[at + 1];
		if (v === undefined || v.startsWith("--")) return undefined;
		return v;
	};
	const known = new Set([
		"--re-bless-activation",
		"--confirm",
		"--drop",
		"--home",
		"--prefix",
		"--repo",
	]);
	const valued = new Set(["--confirm", "--drop", "--home", "--prefix", "--repo"]);
	const drops: string[] = [];
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const flag = arg.replace(/=.*$/, "");
		if (!known.has(flag)) return { ok: false, reason: `unknown flag "${arg}"` };
		if (!valued.has(flag)) continue;
		const inline = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[i + 1];
		if (
			inline === undefined ||
			inline === "" ||
			(!arg.includes("=") && inline.startsWith("--"))
		)
			return { ok: false, reason: `flag ${flag} needs a value` };
		if (flag === "--drop") drops.push(inline);
		if (!arg.includes("=")) i += 1;
	}
	const home = process.env.HOME ?? "";
	const prefixOverride = value("--prefix");
	return {
		ok: true,
		options: {
			home: value("--home") ?? home,
			prefix: prefixOverride ?? process.env.SUSPENDERS_PREFIX ?? join(home, ".claude/hooks/suspenders"),
			repo: value("--repo") ?? join(import.meta.dir, ".."),
			intent: argv.includes("--re-bless-activation"),
			confirm: value("--confirm"),
			drop: drops,
			...(process.env.SUSPENDERS_SERVICE_PORTS_JSON === undefined
				? {}
				: {
						portOverrides: JSON.parse(
							process.env.SUSPENDERS_SERVICE_PORTS_JSON,
						) as Record<string, number>,
					}),
		},
	};
}

if (import.meta.main) {
	if (process.platform !== "darwin") {
		console.error("rebless-activation: launchd activation requires macOS");
		process.exit(2);
	}
	const parsed = parseReblessArgs(process.argv.slice(2));
	if (!parsed.ok) {
		console.error(`rebless-activation: ${parsed.reason}`);
		process.exit(2);
	}
	const options = parsed.options;
	const receiptPath = join(options.home, ".config/klh/service-activation.json");
	const bun = Bun.which("bun");
	const outcome = reblessActivation(options, {
		inspectGeneration: (prefix) => {
			const active = inspectActivatedDispatch(prefix);
			return { state: active.state, root: active.root };
		},
		render: (outDir) => {
			if (bun === null)
				throw new Error("bun is not on PATH — cannot render candidates");
			const child = Bun.spawnSync(
				[
					bun,
					join(options.repo, "scripts/install-services.ts"),
					"--target",
					"darwin",
					"--out",
					outDir,
					"--json",
					"--bun",
					bun,
					"--home",
					options.home,
					"--prefix",
					options.prefix,
					"--repo",
					options.repo,
				],
				{ cwd: options.repo, stdout: "pipe", stderr: "pipe" },
			);
			if (child.exitCode !== 0)
				throw new Error(
					`candidate dry-render failed: ${child.stderr.toString().trim()}`,
				);
			return (JSON.parse(child.stdout.toString()) as { services: RenderedService[] })
				.services;
		},
		parseUnit: (bytes) => {
			const parsed = Bun.spawnSync(
				["/usr/bin/plutil", "-convert", "json", "-o", "-", "-"],
				{ stdin: Buffer.from(bytes), stdout: "pipe", stderr: "ignore" },
			);
			if (parsed.exitCode !== 0) throw new Error("candidate plist unreadable");
			return JSON.parse(parsed.stdout.toString()) as {
				ProgramArguments: string[];
				KeepAlive?: boolean;
			};
		},
		publish: (receipt) => writeActivation(receiptPath, receipt),
		uid: process.getuid(),
	});
	for (const line of outcome.diff) console.log(line);
	if (outcome.wrote) {
		console.log(
			`activation receipt re-blessed: ${outcome.manifestSha256.slice(0, 12)} (${outcome.services} services) — run install.sh --with-launchd to re-register units against this intent`,
		);
	} else {
		console.error(outcome.refusal);
		process.exitCode = 2;
	}
}
