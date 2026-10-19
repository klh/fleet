// hooks/lib/targets.ts — fleet-wide install targets (W298).
//
// Detection is entirely the vendored vercel-labs/skills registry
// (./vendor/skills-agents.ts, 70+ CLI/agent homes, copied verbatim and
// unmodified — see that file's header). This module only adds OUR layer on
// top: which of those detected targets have a suspenders hook-gate wire
// script (hooks/dialects/<cli>/wire.ts), and which are merely detected but
// not yet wired — gated, not removed, so the full breadth stays visible for
// future adapters (docs/cli-dialect-pattern.md covers adding one).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { adapterForExact } from "./executors/registry.ts";
import {
	agents,
	detectInstalledAgents,
	getAgentConfig,
	type AgentConfig,
	type AgentType,
} from "./vendor/skills-agents.ts";

export type { AgentType, AgentConfig };

/** Targets with a real hooks/dialects/<cli>/wire.ts (W296 + codex's W73/W66 original). */
const WIRE_SCRIPT: Partial<Record<AgentType, string>> = {
	codex: "codex",
	"github-copilot": "copilot",
	grok: "grok",
	cline: "cline",
};

/** claude-code wires natively via its own settings.json hooks — no wire.ts. */
const NATIVE: ReadonlySet<AgentType> = new Set(["claude-code"]);

export interface FleetTarget {
	type: AgentType;
	displayName: string;
	/** True once a real CLI home dir is found on this machine. */
	installed: boolean;
	/** True if suspenders has a hook adapter for this target (wired or native). */
	supported: boolean;
	/** True if wiring is Claude Code's own built-in hooks, not a wire.ts run. */
	native: boolean;
	/** Absolute path to hooks/dialects/<cli>/wire.ts, when supported and not native. */
	wireScriptPath?: string;
}

const dialectsRoot = (repoRoot: string): string =>
	join(repoRoot, "hooks", "dialects");

/** Build the full target list: every vendored agent, gated by our support. */
export function listTargets(repoRoot: string): FleetTarget[] {
	return (Object.keys(agents) as AgentType[])
		.filter((type) => type !== "universal") // not a real install target
		.map((type) => {
			const cfg = getAgentConfig(type);
			const dialect = WIRE_SCRIPT[type];
			const native = NATIVE.has(type);
			return {
				type,
				displayName: cfg.displayName,
				installed: false, // filled in by detectFleetTargets (async)
				supported: native || dialect !== undefined,
				native,
				wireScriptPath: dialect
					? join(dialectsRoot(repoRoot), dialect, "wire.ts")
					: undefined,
			};
		});
}

/** Detect which of the vendored 70+ targets are actually installed here. */
export async function detectFleetTargets(
	repoRoot: string,
): Promise<FleetTarget[]> {
	const installedTypes = new Set(await detectInstalledAgents());
	return listTargets(repoRoot).map((t) => ({
		...t,
		installed: installedTypes.has(t.type),
	}));
}

/** AgentType -> executor-registry token (W918 single-catalog law): the
 *  one translation table for the tokens that differ; the rest resolve by
 *  identity. A new adapter row must name its AgentType here. */
const AGENT_TO_EXECUTOR: Partial<Record<AgentType, string>> = {
	"claude-code": "claude",
	"github-copilot": "copilot",
};

/** W918 capability evidence: Buckle front-route per target. true = the
 *  executor verifiably rides the governed buckle front (per-lane bksk_
 *  key, /w/<sid>) — flips ONLY on a landed e2e proof (docs/w918.2-*.md
 *  pattern: probe token round-trip on the lane front); "unknown" =
 *  unaudited — W914 coordinates endpoints. */
const BUCKLE_ROUTE: Partial<Record<AgentType, boolean | "unknown">> = {
	"claude-code": true,
	// W918.2 @370134b5: probe token round-trip on /w/<slug>/v1/responses
	// with a scoped bksk_ key (docs/w918.2-codex-executor-lane-proof.md).
	// Cloud glm leg bounces on Responses params — operator config, not a
	// route gap. github-copilot stays "unknown" until W918.3 lands.
	codex: true,
};

/** Evidence-backed capability states for one catalog target (W918). The
 *  honesty law: skills-dir detection and skill-installability are NOT
 *  runnable evidence — headless spawn requires a registered spawnable
 *  adapter plus a live binary probe on this machine; IDE-only targets
 *  stay false regardless of detection. */
export interface FleetCapabilities {
	/** Vendored-registry detection (skills dir / env probe) on this machine. */
	detected: boolean;
	/** The vercel-labs/skills CLI can install skills into this target. */
	skillInstallable: boolean;
	/** A suspenders hook adapter exists (native, or its wire.ts on disk). */
	hookWired: boolean;
	/** Headless lane spawn possible HERE: spawnable adapter + binary probe. */
	headlessSpawnable: boolean;
	/** Verified fork/resume semantics (adapter forkArgs non-null). */
	sessionResumable: boolean;
	/** Rides the governed Buckle front; "unknown" = unaudited (W914). */
	buckleCompatible: boolean | "unknown";
}

/** Binary probe — PATH probe plus PATH-independent install paths (launchd
 *  runs a bare PATH, W626). Overridable for deterministic tests. */
export type BinProbe = (bin: string, installPaths?: string[]) => boolean;

export const defaultBinProbe: BinProbe = (bin, installPaths) =>
	Boolean(Bun.which(bin)) ||
	(installPaths?.some((p) => existsSync(p)) ?? false);

/** Assemble the evidence-backed capability row for one target (W918). */
export function targetCapabilities(
	type: AgentType,
	repoRoot: string,
	detected: boolean,
	probe: BinProbe = defaultBinProbe,
): FleetCapabilities {
	const adapter = adapterForExact(AGENT_TO_EXECUTOR[type] ?? type);
	const dialect = WIRE_SCRIPT[type];
	const native = NATIVE.has(type);
	return {
		detected,
		skillInstallable: true, // a registry row IS the skills CLI target list
		hookWired:
			native ||
			(dialect !== undefined &&
				existsSync(join(dialectsRoot(repoRoot), dialect, "wire.ts"))),
		headlessSpawnable:
			adapter !== null &&
			adapter.spawnable === true &&
			probe(adapter.bin, adapter.installPaths),
		sessionResumable: adapter !== null && adapter.forkArgs("probe") !== null,
		buckleCompatible: BUCKLE_ROUTE[type] ?? "unknown",
	};
}

/** Full catalog: every vendored target with its capability evidence. */
export async function capabilityCatalog(
	repoRoot: string,
): Promise<Array<FleetTarget & { capabilities: FleetCapabilities }>> {
	const installed = new Set(await detectInstalledAgents());
	return listTargets(repoRoot).map((t) => ({
		...t,
		installed: installed.has(t.type),
		capabilities: targetCapabilities(t.type, repoRoot, installed.has(t.type)),
	}));
}
