// post-merge-live.ts — W2546: the LIVE process seams of the post-merge
// runner, isolated from the pure decision core (post-merge-runner.ts) so
// tests inject fakes and never touch launchd, plists or machine config.
// Everything here is subprocess-backed and SYNC by design: the wire probe
// rides the deploy/healthcheck/probe.ts one-shot child (exit code IS the
// verdict — async probeOnce stays in its own process), the fenced apply
// rides `install.ts --step upgradeGateway --gateway-review <sha> --yes`
// (upgrade-gateway.ts stages the proposal itself when preparing, so the
// review digest always names the exact staged candidate, #101172), and
// observation is launchctl print parsed — never guessed. Unknown
// inspection NEVER equals proven absence (#101322 seam 2).
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { expandHome, setting } from "@klh/settings";
import { PROBE_TIMEOUT_MS } from "./activation-readiness.ts";
import {
	carryGenerationPinned,
	type CarryDeps,
	type CarryResult,
} from "./post-merge-carry.ts";
import {
	awaitIdentity,
	pollProbe,
	type PostMergeRunnerDeps,
} from "./post-merge-labels.ts";
import {
	inspectServices,
	parseLoadedArguments,
	readActivation,
	type ActivationReceipt,
	type ServiceVerdict,
} from "./service-drift.ts";
import { gatewayReviewToken, type GatewayUpgrade } from "../upgrade-gateway.ts";

/** The one generation-pinned label the carry flow owns (upgrade-gateway). */
const CARRY_LABEL = "com.suspenders.buckle-spoke";

/** Configured probe contract per label (#101667): the port and health path
 * each surface ACTUALLY answers. The receipt's recorded port wins when
 * present (config-over-code); defaults are each surface's configured
 * value — buckle-spoke 4101 (services.yaml port), belt-swarm childPort
 * 4000 (router-shim listener the supervisor adopts), dashboard 7791
 * (BELT_PORT default), board 7799 (board/context.ts PORT default). */
const PROBE_TARGETS: Readonly<Record<string, { port: number; path: string }>> =
	{
		"com.suspenders.buckle-spoke": { port: 4101, path: "/health" },
		"com.suspenders.belt-swarm": { port: 4000, path: "/health/liveliness" },
		"com.belt.dashboard": { port: 7791, path: "/api/health" },
		"com.suspenders.board": { port: 7799, path: "/api/prompt/settings" },
	};

const sh = (cmd: string[], cwd?: string): { code: number; out: string } => {
	// N2: spawnSync THROWS when the absolute-path binary is missing (ENOENT
	// on a non-darwin host) — convert to a typed nonzero failure so the
	// caller records a failed observation, never a crashed runner.
	let p: ReturnType<typeof Bun.spawnSync>;
	try {
		p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	} catch (error) {
		return { code: 127, out: String(error) };
	}
	return {
		code: p.exitCode ?? 1,
		out: `${p.stdout?.toString() ?? ""}${p.stderr?.toString() ?? ""}`,
	};
};

/** Sync sleep for the poll budgets (Atomics.wait — no event-loop escape). */
const sleepSync = (ms: number): void => {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Append one line to the sync log (parent dir created on demand). */
export const appendLog = (path: string, line: string): void => {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
};

/** 0600 stamp write — the ledger is the retry contract, never world-readable. */
const writeStamp0600 = (
	path: string,
	stamp: import("./activation-readiness.ts").PostMergeStamp,
): void => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(stamp, null, 2)}\n`, {
		mode: 0o600,
	});
};

/** plutil -convert json of unit bytes (null = unreadable, never guessed). */
const unitToJson = (bytes: string): string | null => {
	const p = Bun.spawnSync(
		["/usr/bin/plutil", "-convert", "json", "-o", "-", "-"],
		{ stdin: Buffer.from(bytes), stdout: "pipe", stderr: "ignore" },
	);
	return p.exitCode === 0 ? p.stdout.toString() : null;
};

/** harness-receipt.json contract (fleet.harness.v1) — named schema, the
 * boundary parses (Schema law W1238.4), the core never hand-casts. */
const HarnessProofSchema = z.object({
	schema: z.literal("fleet.harness.v1"),
	revision: z.string().regex(/^[a-f0-9]{40}$/),
	payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

/** The published harness receipt's revision (null = unreadable — never a
 * guess; provenance gates the carry). */
export const publishedRevision = (prefix: string): string | null => {
	try {
		return HarnessProofSchema.parse(
			JSON.parse(readFileSync(join(prefix, "harness-receipt.json"), "utf8")),
		).revision;
	} catch {
		return null;
	}
};

/** Revision of the generation the loaded daemon actually executes
 * (#101172/#101667): resolve the loaded bundle argv to its CANONICAL
 * generation receipt — the .harness root's harness-receipt.json — never
 * infer the SHA from a directory basename. null = unreadable. */
const loadedRevisionFor = (domain: string, label: string): string | null => {
	const print = sh(["/bin/launchctl", "print", `${domain}/${label}`]);
	const args = print.code === 0 ? parseLoadedArguments(print.out) : null;
	const bundle = args?.find((a) => a.endsWith("server.bundle.js"));
	if (bundle === undefined) return null;
	try {
		const real = realpathSync(bundle);
		const harness = real.match(/^(.*\/.harness)\/packages\/buckle\//);
		if (harness === null) return null;
		return HarnessProofSchema.parse(
			JSON.parse(
				readFileSync(join(dirname(harness[1]), "harness-receipt.json"), "utf8"),
			),
		).revision;
	} catch {
		return null;
	}
};

/** Daemon supervision state for the carry label: rc 0 = a supervised
 * process exists; "absent" ONLY on launchd's explicit not-found line
 * (unknown ≠ authorized absence, #101322 seam 2). */
const daemonStateFor = (
	domain: string,
	label: string,
): "loaded" | "absent" | "unknown" => {
	const print = sh(["/bin/launchctl", "print", `${domain}/${label}`]);
	if (print.code === 0) return "loaded";
	if (/Could not find (specified )?service/.test(print.out)) return "absent";
	return "unknown";
};

/** Receipt port (when recorded) + configured probe contract → the
 * public status URL (null = no probe surface known → readiness unproven). */
const probeUrlForLabel = (
	receipt: ActivationReceipt,
	label: string,
): string | null => {
	const target = PROBE_TARGETS[label];
	if (target === undefined) return null;
	const recorded = receipt.services.find((s) => s.label === label)?.port;
	return `http://127.0.0.1:${recorded ?? target.port}${target.path}`;
};

/** probe.ts one-shot stdout contract: the Sample JSON the child prints —
 * status 0 = transport failure (no HTTP answer), any other value = the
 * actual HTTP status the target answered with (Schema law, #101816). */
const ProbeSampleSchema = z.object({
	ok: z.boolean(),
	status: z.number(),
});

/** Outside-process wire probe via the probe.ts one-shot child (#101816):
 * the child's stdout Sample carries the TRUE transport/HTTP split the
 * poll contract needs — the exit code conflates them (every failure = 1)
 * and would make pollProbe stop on the first refused connection. A
 * definitive HTTP answer (any status) is a real verdict; only
 * status 0 (connection-refused/timeout during startup) keeps polling. */
const probeUrlVerdict = (
	repo: string,
	url: string,
): { ok: boolean; status: number } => {
	const probe = Bun.spawnSync(
		[
			process.execPath,
			join(repo, "deploy", "healthcheck", "probe.ts"),
			"--target",
			url,
			"--timeout",
			String(PROBE_TIMEOUT_MS),
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	try {
		return ProbeSampleSchema.parse(JSON.parse(probe.stdout.toString()));
	} catch {
		// unparseable child output = no HTTP answer on record: transport
		// shape (0) so a startup window keeps polling inside the budget
		return { ok: false, status: 0 };
	}
};

/** install.ts --json outcome surface (the staging report, #101671). */
const InstallReportSchema = z.object({
	schema: z.literal("suspenders.install.v1"),
	steps: z.array(
		z.object({
			name: z.string(),
			status: z.string(),
			note: z.string(),
			detail: z.string().optional(),
		}),
	),
});

/** upgradeGateway staging detail: the exact staged artifact coordinates. */
const StagingDetailSchema = z.object({
	revision: z.string().optional(),
	candidateSha256: z.string().optional(),
	reviewSha256: z.string().optional(),
	proposal: z.string().optional(),
});

/** The staged proposal artifact itself (upgrade-gateway GatewayUpgrade). */
const GatewayUpgradeSchema = z.object({
	unit: z.string(),
	beforeUnitSha256: z.string(),
	beforeReceiptSha256: z.string(),
	processSha256: z.string(),
	candidate: z.string(),
	candidateSha256: z.string(),
	arguments: z.array(z.string()),
	generation: z.object({
		root: z.string(),
		revision: z.string(),
		payloadSha256: z.string(),
	}),
	manifest: z.string(),
});

/** Stage the gateway proposal through the EXISTING upgrader (#101667):
 * the no-review child run writes ~/.config/klh/gateway-review/<sha>.json
 * and touches no service; the staged artifact is read back and its digest
 * verified against its own filename, so the apply child's
 * --gateway-review names the exact staged bytes. */
const stagedProposal = (repo: string): GatewayUpgrade => {
	const staged = sh(
		[
			process.execPath,
			join(repo, "scripts/install.ts"),
			"--step",
			"upgradeGateway",
			"--yes",
			"--json",
			"--verbose",
		],
		repo,
	);
	if (staged.code !== 0)
		throw new Error(
			`gateway staging rc=${staged.code}: ${staged.out.trim().slice(-200)}`,
		);
	// #101671: consume the EXACT proposal this run staged — the --json
	// report's upgradeGateway row carries detail {revision, candidateSha256,
	// reviewSha256, proposal}; a future-dated or concurrent proposal in the
	// shared dir must never be selected by this run.
	const report = InstallReportSchema.parse(JSON.parse(staged.out));
	const row = report.steps.find((s) => s.name === "upgradeGateway");
	const detail = row === undefined ? undefined : row.detail;
	if (detail === undefined)
		throw new Error("staging report carries no proposal path");
	const named = StagingDetailSchema.parse(JSON.parse(detail));
	if (named.proposal === undefined)
		throw new Error("staging detail carries no proposal path");
	const proposal = GatewayUpgradeSchema.parse(
		JSON.parse(readFileSync(named.proposal, "utf8")),
	);
	const digest = named.proposal
		.split("/")
		.pop()
		?.replace(/\.json$/, "");
	if (digest === undefined || gatewayReviewToken(proposal) !== digest)
		throw new Error("staged gateway proposal digest mismatch");
	return proposal;
};

/** The complete live PostMergeRunnerDeps for one repo/state/log triple. */
/** The ONE production carry adapter (W2546 #101735): shared by the
 * post-merge runner and the ordinary install activateGateway step — never
 * a second CarryDeps implementation. Observation is real (canonical loaded
 * generation + launchd daemon state, never fabricated), the apply is the
 * fenced upgrader child, staging consumes the exact --json artifact. */
export function carryAdapter(
	repo: string,
	prefix: string,
	logPath: string,
): CarryDeps {
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	const domain = `gui/${uid}`;
	return {
		prepare: () => stagedProposal(repo),
		readUnit: (path) => readFileSync(path, "utf8"),
		unitToJson,
		publishedRevision: () => publishedRevision(prefix),
		loadedRevision: () => loadedRevisionFor(domain, CARRY_LABEL),
		daemonState: () => daemonStateFor(domain, CARRY_LABEL),
		applyReviewed: (sha) => {
			const applied = sh(
				[
					process.execPath,
					join(repo, "scripts/install.ts"),
					"--step",
					"upgradeGateway",
					"--gateway-review",
					sha,
					"--yes",
				],
				repo,
			);
			return {
				status: applied.code === 0 ? "ok" : `exit ${applied.code}`,
				note:
					applied.out
						.trim()
						.split("\n")
						.filter(Boolean)
						.slice(-3)
						.join(" | ") || `upgradeGateway rc=${applied.code}`,
			};
		},
		log: (line) => appendLog(logPath, line),
	};
}

/** The bounded-poll seam subset shared by the runner and the install
 * step's readiness proof (#101757). */
export type PollDeps = Pick<
	PostMergeRunnerDeps,
	"inspectLabel" | "probe" | "now" | "sleep"
>;

/** Gateway readiness, BOTH proofs (#101358 law): receipt-backed identity
 * (inspectServices) AND the outside-process wire probe. Uses the SAME
 * bounded poll loops as the post-merge runner (#101757): a just-loaded
 * gateway gets the full budget to settle — identity pending keeps
 * inspecting, connection-refused keeps probing — with NO repeated
 * apply/restart; an exhausted startup budget stays a truthful failure. */
export function gatewayReadiness(
	repo: string,
	budgetMs = 30_000,
	intervalMs = 500,
	over: Partial<PollDeps> = {},
): { ready: boolean; reason: string } {
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	const domain = `gui/${uid}`;
	const receiptPath = join(homedir(), ".config/klh/service-activation.json");
	let receipt: ActivationReceipt | null = null;
	try {
		receipt = readActivation(receiptPath);
	} catch {
		return { ready: false, reason: "activation receipt unreadable" };
	}
	if (receipt === null)
		return { ready: false, reason: "activation receipt unreadable" };
	const manifest = join(repo, "deploy/services.yaml");
	const polls: PollDeps = {
		inspectLabel: (label) =>
			inspectServices(receipt, domain, manifest).find((v) => v.label === label),
		probe: (url) => probeUrlVerdict(repo, url),
		now: () => Date.now(),
		sleep: sleepSync,
		...over,
	};
	const identity = awaitIdentity(polls, CARRY_LABEL, budgetMs, intervalMs);
	if (identity.state !== "ready")
		return {
			ready: false,
			reason: `identity ${identity.state} (${identity.reason})`,
		};
	const url = probeUrlForLabel(receipt, CARRY_LABEL);
	if (url === null) return { ready: false, reason: "no probe URL for gateway" };
	const probed = pollProbe(polls, url, budgetMs, intervalMs);
	return probed.ok
		? { ready: true, reason: `probe ok (${url})` }
		: {
				ready: false,
				reason: `probe failed (${url}, status ${probed.status})`,
			};
}

/** The installed suspenders prefix — the designated-home read (W2674):
 *  paths.suspenders_prefix through @klh/settings, never a direct env read
 *  (the env-map row keeps SUSPENDERS_PREFIX as the transition override;
 *  the schema default's ~/ expands at read time). */
export const suspendersPrefix = (): string =>
	expandHome(setting("paths.suspenders_prefix"));

export function buildPostMergeDeps(
	repo: string,
	statePath: string,
	logPath: string,
): PostMergeRunnerDeps {
	const prefix = suspendersPrefix();
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	const domain = `gui/${uid}`;
	const receiptPath = join(homedir(), ".config/klh/service-activation.json");
	const manifest = join(repo, "deploy/services.yaml");
	const readReceipt = (): ActivationReceipt | null => {
		try {
			return readActivation(receiptPath);
		} catch {
			return null;
		}
	};
	const say = (line: string): void => {
		console.log(line);
		appendLog(logPath, line);
	};
	const carryDeps = (): CarryDeps => carryAdapter(repo, prefix, logPath);
	return {
		publish: () =>
			sh(
				[
					process.execPath,
					join(repo, "scripts/install.ts"),
					"--step",
					"syncHarness",
					"--yes",
				],
				repo,
			),
		readReceipt,
		inspectLabel: (label: string): ServiceVerdict | undefined => {
			const receipt = readReceipt();
			return receipt
				? inspectServices(receipt, domain, manifest).find(
						(v) => v.label === label,
					)
				: undefined;
		},
		kick: (label) =>
			sh(["/bin/launchctl", "kickstart", "-k", `${domain}/${label}`]).code,
		probe: (url) => probeUrlVerdict(repo, url),
		loadedRevisionFor: (label) => loadedRevisionFor(domain, label),
		daemonStateFor: (label) => daemonStateFor(domain, label),
		probeUrlFor: (label) => {
			const receipt = readReceipt();
			return receipt ? probeUrlForLabel(receipt, label) : null;
		},
		carry: (expectedRevision: string): CarryResult =>
			carryGenerationPinned(carryDeps(), expectedRevision),
		platform: () => process.platform,
		log: say,
		sleep: sleepSync,
		now: () => Date.now(),
		writeStamp: (stamp) => writeStamp0600(statePath, stamp),
	};
}
