#!/usr/bin/env bun
// record-service-activation.ts — W639: the owner-invoked re-bless surface for
// ~/.config/klh/service-activation.json after a deploy/services.yaml change.
// "Rendering is not approval": the installer's render never publishes intent on
// its own — the fence (assertServiceActivation) holds the receipt as the
// authority, so a manifest change (W631 stable-path renders, W638 auto-install
// entry) refuses every launchd registration until the owner re-blesses. This
// recorder regenerates that approval from the PINNED checkout's manifest with
// the exact render registerLaunchd applies (same manifest, same substitution
// values), so the next `install.sh --with-launchd` render passes the fence and
// the receipt then names stable repo paths, never reapable generation
// snapshots (the 2026-10-11 outage class).
//
// Usage (explicit owner intent required):
//   bun scripts/record-service-activation.ts --approve-stable \
//     [--repo <packages/suspenders>] [--prefix <dir>] [--bun <path>] [--home <dir>]
//
// --repo defaults to the harness receipt's `source` checkout (normalized by
// the W631 resolveStableRepo — snapshots are refused); the active generation's
// services.yaml must match the pinned checkout's byte-for-byte (sync the
// harness first — bash install.sh from the pinned checkout) so the receipt
// can never approve code the installed generation does not serve. Entries
// carrying a reviewed `generation` pin are refused — those belong to the
// documented upgradeGateway review flow (SERVICE-ACTIVATION.md). No launchd
// state is touched: publish = receipt only; registerLaunchd applies the
// blessed definitions, load-verifies them and republishes what launchd
// actually loaded.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	defaultRenderValues,
	loadManifest,
	renderDarwin,
	type RenderValues,
} from "./install-services.ts";
import { resolveStableRepo } from "./install-launchd.ts";
import { inspectActivatedDispatch } from "./lib/activated-dispatch.ts";
import {
	digestUnit,
	readActivation,
	writeActivation,
	type ActivationReceipt,
	type ActivationService,
} from "./lib/service-drift.ts";

export interface ApproveStableOptions {
	/** packages/suspenders root of the pinned checkout (default: harness receipt source). */
	repo?: string;
	prefix?: string;
	home?: string;
	bun?: string;
	domain?: string;
	receiptPath?: string;
}

export interface ApproveStableDeps {
	inspectActive: () =>
		| { state: "ok"; root: string; revision?: string }
		| { state: string; root?: string };
	read: (path: string) => string;
	publish: (receipt: ActivationReceipt) => void;
}

export interface BlessSummary {
	repo: string;
	manifest: string;
	receipt: ActivationReceipt;
	/** Labels whose blessed arguments differ from the prior receipt. */
	changed: string[];
	/** Labels re-blessed with unchanged arguments. */
	identical: string[];
	/** Labels absent from the prior receipt (new services, e.g. the W638 watcher). */
	added: string[];
}

export type ActiveGeneration = Awaited<
	ReturnType<typeof inspectActivatedDispatch>
>;

// Same validation registerLaunchd applies to SUSPENDERS_SERVICE_PORTS_JSON:
// integers 1..65535, otherwise a typed refusal — never a silent partial bless.
function machineServicePorts(): Record<string, number> {
	const raw = process.env.SUSPENDERS_SERVICE_PORTS_JSON;
	if (raw === undefined || raw.trim() === "") return {};
	const parsed: unknown = JSON.parse(raw);
	const ports: Record<string, number> = {};
	for (const [label, port] of Object.entries(
		parsed as Record<string, unknown>,
	)) {
		if (
			typeof port !== "number" ||
			!Number.isInteger(port) ||
			port < 1 ||
			port > 65535
		)
			throw new Error("Invalid machine service port mapping");
		ports[label] = port;
	}
	return ports;
}

function parseRenderedUnit(body: string): {
	arguments: string[];
	resident: boolean;
} {
	const parsed = Bun.spawnSync(
		["/usr/bin/plutil", "-convert", "json", "-o", "-", "-"],
		{ stdin: Buffer.from(body), stdout: "pipe", stderr: "ignore" },
	);
	if (parsed.exitCode !== 0) throw new Error("rendered unit cannot be parsed");
	const definition = JSON.parse(parsed.stdout.toString()) as {
		ProgramArguments: string[];
		KeepAlive?: boolean;
	};
	return {
		arguments: definition.ProgramArguments,
		resident: definition.KeepAlive === true,
	};
}

function sourceCheckout(prefix: string): string | undefined {
	try {
		const parsed = JSON.parse(
			readFileSync(join(prefix, "harness-receipt.json"), "utf8"),
		) as { source?: unknown };
		if (typeof parsed.source === "string" && parsed.source.trim() !== "")
			return parsed.source;
	} catch {
		/* absence is refused by the caller */
	}
	return undefined;
}

export function approveStableActivation(
	options: ApproveStableOptions,
	deps: ApproveStableDeps,
): BlessSummary {
	const home = options.home ?? process.env.HOME ?? "";
	const prefix =
		options.prefix ??
		process.env.SUSPENDERS_PREFIX ??
		join(home, ".claude/hooks/suspenders");
	const repoRoot =
		options.repo ??
		join(sourceCheckout(prefix) ?? "", "packages", "suspenders");
	const stable = resolveStableRepo(repoRoot, prefix);
	if (!stable.ok) throw new Error(stable.refusal);
	const active = deps.inspectActive();
	if (active.state !== "ok" || active.root === undefined)
		throw new Error(
			"activated generation unavailable — sync the harness first (install from the pinned checkout)",
		);
	const manifest = join(stable.repo, "deploy/services.yaml");
	const activeManifest = join(
		active.root,
		"packages/suspenders/deploy/services.yaml",
	);
	if (deps.read(manifest) !== deps.read(activeManifest))
		throw new Error(
			"pinned checkout manifest differs from the activated generation — sync the harness first (install from the pinned checkout)",
		);
	const domain = options.domain ?? `gui/${process.getuid()}`;
	const receiptPath =
		options.receiptPath ?? join(home, ".config/klh/service-activation.json");
	let prior: ActivationReceipt;
	try {
		prior = readActivation(receiptPath);
	} catch {
		throw new Error(
			"no readable prior activation receipt — first approval belongs to the installer's --owner-initial-install, not a re-bless",
		);
	}
	if (prior.domain !== domain)
		throw new Error(
			`prior activation receipt domain ${prior.domain} differs from ${domain}`,
		);
	const values: RenderValues = defaultRenderValues({
		bun: options.bun,
		home,
		prefix,
		repo: stable.repo,
	});
	const ports = machineServicePorts();
	const services: ActivationService[] = [];
	const changed: string[] = [];
	const identical: string[] = [];
	const added: string[] = [];
	for (const spec of loadManifest(manifest)) {
		const label = `com.suspenders.${spec.name}`;
		const priorEntry = prior.services.find((entry) => entry.label === label);
		if (priorEntry?.generation !== undefined)
			throw new Error(
				`${label} is generation-pinned; use the documented reviewed gateway upgrade flow (SERVICE-ACTIVATION.md), not a stable re-bless`,
			);
		const body = renderDarwin(spec, values);
		const unit = join(home, "Library/LaunchAgents", `${label}.plist`);
		const definition = parseRenderedUnit(body);
		const port = ports[label] ?? spec.port;
		services.push({
			label,
			unit,
			unitSha256: digestUnit(body),
			arguments: definition.arguments,
			resident: definition.resident,
			...(port === undefined ? {} : { port }),
		});
		if (priorEntry === undefined) added.push(label);
		else if (
			JSON.stringify(priorEntry.arguments) !==
			JSON.stringify(definition.arguments)
		)
			changed.push(label);
		else identical.push(label);
	}
	const receipt: ActivationReceipt = {
		schema: "fleet.service-activation.v1",
		platform: "darwin",
		domain,
		manifest,
		manifestSha256: digestUnit(deps.read(manifest)),
		services,
	};
	deps.publish(receipt);
	return { repo: stable.repo, manifest, receipt, changed, identical, added };
}

if (import.meta.main) {
	try {
		if (process.platform !== "darwin")
			throw new Error("activation receipt is darwin-only");
		const args = process.argv.slice(2);
		const value = (key: string): string | undefined => {
			const at = args.indexOf(key);
			return at < 0 ? undefined : args[at + 1];
		};
		if (!args.includes("--approve-stable"))
			throw new Error("explicit --approve-stable owner intent required");
		const home = process.env.HOME ?? "";
		const prefix =
			value("--prefix") ??
			process.env.SUSPENDERS_PREFIX ??
			join(home, ".claude/hooks/suspenders");
		const receiptPath = join(home, ".config/klh/service-activation.json");
		const summary = approveStableActivation(
			{
				repo: value("--repo"),
				prefix,
				home: value("--home"),
				bun: value("--bun"),
			},
			{
				inspectActive: () => inspectActivatedDispatch(prefix),
				read: (path) => readFileSync(path, "utf8"),
				publish: (receipt) => writeActivation(receiptPath, receipt),
			},
		);
		console.log(
			`activation receipt re-blessed from ${summary.manifest} (${summary.repo})`,
		);
		console.log(
			`blessed ${summary.receipt.services.length} services — args changed: ${summary.changed.length === 0 ? "none" : summary.changed.join(" ")}; added: ${summary.added.length === 0 ? "none" : summary.added.join(" ")}`,
		);
		console.log(
			"apply with install.sh --with-launchd from the pinned checkout; registerLaunchd load-verifies and republishes what launchd loaded",
		);
	} catch (error) {
		console.error(`activation re-bless refused: ${(error as Error).message}`);
		process.exitCode = 1;
	}
}
