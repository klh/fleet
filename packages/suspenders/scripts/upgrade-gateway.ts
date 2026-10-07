import {
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { processBirth } from "./lib/launch-fencing.ts";
import { inspectActivatedDispatch } from "./lib/activated-dispatch.ts";
import {
	digestUnit,
	readActivation,
	writeActivation,
	type ActivationReceipt,
} from "./lib/service-drift.ts";
import type { StepContext, StepResult } from "./install-run.ts";

const LABEL = "com.suspenders.buckle-spoke";
export interface GatewayUpgrade {
	unit: string;
	beforeUnitSha256: string;
	beforeReceiptSha256: string;
	processSha256: string;
	candidate: string;
	candidateSha256: string;
	arguments: string[];
	generation: { root: string; revision: string; payloadSha256: string };
	manifest: string;
}
function plist(bytes: string, format: "json" | "xml1"): string {
	const result = Bun.spawnSync(
		["/usr/bin/plutil", "-convert", format, "-o", "-", "-"],
		{ stdin: Buffer.from(bytes), stdout: "pipe", stderr: "ignore" },
	);
	if (result.exitCode !== 0) throw new Error("Gateway unit cannot be parsed");
	return result.stdout.toString();
}
/** Exact loaded argv + PID birth snapshot; PID replacement is a new review. */
export function observeGateway(): string {
	const print = () => {
		const result = Bun.spawnSync(
			["/bin/launchctl", "print", `gui/${process.getuid()}/${LABEL}`],
			{ stdout: "pipe", stderr: "ignore" },
		);
		if (result.exitCode !== 0)
			throw new Error("Gateway supervised identity unavailable");
		const text = result.stdout.toString(),
			pid = Number(/\n\s*pid = (\d+)/.exec(text)?.[1]);
		const block = /\n\s*arguments = \{([\s\S]*?)\n\s*\}/.exec(text)?.[1];
		const birth =
			Number.isSafeInteger(pid) && pid > 1 ? processBirth(pid) : null;
		if (!birth || !block)
			throw new Error("Gateway supervised identity unknown");
		const args = block
			.split("\n")
			.map((value) => value.trim())
			.filter(Boolean);
		return digestUnit(JSON.stringify({ pid, args, birth }));
	};
	const first = print();
	if (print() !== first)
		throw new Error("Gateway identity changed during observation");
	return first;
}
/** Read-only proposal; real generation paths pin code without moving machine state. */
export function prepareGatewayUpgrade(
	prefix: string,
	home: string,
	observe: () => string = observeGateway,
): GatewayUpgrade {
	const active = inspectActivatedDispatch(prefix);
	if (active.state !== "ok" || !active.root || !active.revision)
		throw new Error("Reviewed generation unavailable");
	const root = realpathSync(prefix);
	const proof = JSON.parse(
		readFileSync(join(root, "harness-receipt.json"), "utf8"),
	);
	const bundle = join(active.root, "packages/buckle/src/server.bundle.js");
	if (realpathSync(bundle) !== bundle)
		throw new Error("Gateway entry escapes reviewed generation");
	const unit = join(home, "Library/LaunchAgents", `${LABEL}.plist`);
	if (realpathSync(unit) !== unit)
		throw new Error("Gateway unit destination is not canonical");
	const before = readFileSync(unit, "utf8");
	const definition = JSON.parse(plist(before, "json"));
	if (definition.Label !== LABEL || !Array.isArray(definition.ProgramArguments))
		throw new Error("Gateway unit identity unavailable");
	const entries = definition.ProgramArguments.flatMap(
		(arg: string, index: number) =>
			/\/(?:src\/server\.ts|server\.bundle\.js)$/.test(arg) ? [index] : [],
	);
	if (entries.length !== 1)
		throw new Error("Gateway wrapper has no unambiguous server entry");
	definition.ProgramArguments[entries[0]] = bundle;
	const candidate = plist(JSON.stringify(definition), "xml1");
	const receiptPath = join(home, ".config/klh/service-activation.json");
	const receipt = readActivation(receiptPath);
	if (
		receipt.domain !== `gui/${process.getuid()}` ||
		!receipt.services.some((service) => service.label === LABEL)
	)
		throw new Error("Prior gateway activation authority unavailable");
	return {
		unit,
		beforeUnitSha256: digestUnit(before),
		beforeReceiptSha256: digestUnit(readFileSync(receiptPath)),
		processSha256: observe(),
		candidate,
		candidateSha256: digestUnit(candidate),
		arguments: definition.ProgramArguments,
		generation: {
			root,
			revision: active.revision,
			payloadSha256: proof.payloadSha256,
		},
		manifest: join(active.root, "packages/suspenders/deploy/services.yaml"),
	};
}
export function assertUpgradeSnapshot(
	proposal: GatewayUpgrade,
	unit: string,
	receipt: string,
	generation: GatewayUpgrade["generation"],
	processSha256: string,
): void {
	if (
		digestUnit(unit) !== proposal.beforeUnitSha256 ||
		digestUnit(receipt) !== proposal.beforeReceiptSha256 ||
		digestUnit(proposal.candidate) !== proposal.candidateSha256 ||
		JSON.stringify(generation) !== JSON.stringify(proposal.generation) ||
		processSha256 !== proposal.processSha256
	)
		throw new Error("Gateway proposal is stale; prepare and review again");
}
/** Approval covers the candidate and every compared owner/process snapshot. */
export const gatewayReviewToken = (proposal: GatewayUpgrade): string =>
	digestUnit(JSON.stringify(proposal));
/** Explicit canonical installer step. Preparing never changes a service or receipt. */
export async function upgradeGateway(
	ctx: StepContext & { gatewayReview?: string },
	deps: {
		observe: () => string;
		load: (args: string[], prefix: string) => { exitCode: number };
	} = {
		observe: observeGateway,
		load: (args, prefix) =>
			Bun.spawnSync(args, {
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, SUSPENDERS_PREFIX: prefix },
			}),
	},
): Promise<StepResult> {
	if (process.platform !== "darwin")
		return {
			status: "skipped",
			note: "Gateway launchd upgrade requires macOS",
		};
	const home = process.env.HOME ?? "";
	const proposal = prepareGatewayUpgrade(ctx.prefix, home, deps.observe);
	const receiptPath = join(home, ".config/klh/service-activation.json");
	const staging = join(home, ".config/klh/gateway-review");
	mkdirSync(staging, { recursive: true, mode: 0o700 });
	const reviewSha256 = gatewayReviewToken(proposal);
	const prepared = join(staging, `${reviewSha256}.json`);
	if (!ctx.gatewayReview) {
		writeFileSync(prepared, JSON.stringify(proposal), { mode: 0o600 });
		return {
			status: "ok",
			note: `Gateway candidate staged; no activation. Review ${prepared}; approve with --step upgradeGateway --gateway-review ${reviewSha256} --yes`,
			detail: JSON.stringify({
				revision: proposal.generation.revision,
				candidateSha256: proposal.candidateSha256,
				reviewSha256,
				proposal: prepared,
			}),
		};
	}
	if (ctx.gatewayReview !== reviewSha256)
		throw new Error("Gateway approval differs from current reviewed candidate");
	const reviewed = JSON.parse(readFileSync(prepared, "utf8")) as GatewayUpgrade;
	const beforeReceipt = readFileSync(receiptPath, "utf8"),
		beforeUnit = readFileSync(proposal.unit, "utf8");
	assertUpgradeSnapshot(
		reviewed,
		beforeUnit,
		beforeReceipt,
		proposal.generation,
		deps.observe(),
	);
	const old = readActivation(receiptPath);
	const approved: ActivationReceipt = {
		...old,
		manifest: proposal.manifest,
		manifestSha256: digestUnit(readFileSync(proposal.manifest)),
		services: old.services.map((service) =>
			service.label === LABEL
				? {
						...service,
						unitSha256: proposal.candidateSha256,
						arguments: proposal.arguments,
						generation: proposal.generation,
					}
				: service,
		),
	};
	// Use the existing receipt publisher and fenced loader, not a second installer.
	// Check both snapshots immediately before publishing approved intent.
	assertUpgradeSnapshot(
		reviewed,
		readFileSync(proposal.unit, "utf8"),
		readFileSync(receiptPath, "utf8"),
		proposal.generation,
		deps.observe(),
	);
	writeActivation(receiptPath, approved);
	const nextUnit = `${proposal.unit}.reviewed-${crypto.randomUUID()}`;
	try {
		writeFileSync(nextUnit, proposal.candidate, { mode: 0o600 });
		renameSync(nextUnit, proposal.unit);
	} catch (error) {
		// Restore prior intent only if no competing receipt writer intervened.
		if (
			digestUnit(readFileSync(receiptPath)) ===
			digestUnit(JSON.stringify(approved))
		)
			writeActivation(receiptPath, old);
		throw error;
	} finally {
		rmSync(nextUnit, { force: true });
	}

	const result = deps.load(
		[
			"/bin/bash",
			join(proposal.generation.root, "scripts/load-launchd.sh"),
			proposal.unit,
			join(home, ".claude-insights/launchd-reviewed-gateway.log"),
		],
		ctx.prefix,
	);
	if (result.exitCode !== 0)
		throw new Error(
			"Reviewed gateway registration failed; approved candidate retained for observation and owner recovery",
		);
	return {
		status: "ok",
		note: `Gateway registered from reviewed generation ${proposal.generation.revision}`,
	};
}
