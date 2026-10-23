// hooks/board/data-checks.ts — the setup/wiring check builders, moved
// verbatim from data.ts (W1238.6.5 decompose): the settings.json hook scan,
// tier-manifest facts, the advice-endpoint LLM probe and setupChecks.
// data.ts re-exports the face so route imports stay stable.
import { existsSync, readFileSync } from "node:fs";
import {
	BIND,
	gatePath,
	LLM_ORIGIN,
	REG_DIR,
	sessionStartPath,
} from "./context.ts";
import { hubCheck } from "./hub-check.ts";

// advisory wiring checks — never throw; a failed check is information, not an
// error. settings.json hook commands may spell $HOME literally — expand before
// comparing against this install's script paths.
export function settingsCommands(kind: string): string[] {
	try {
		const s = JSON.parse(
			readFileSync(`${process.env.HOME}/.claude/settings.json`, "utf8"),
		) as {
			hooks?: Record<string, { hooks?: { command?: string }[] }[]>;
		};
		return (s?.hooks?.[kind] ?? [])
			.flatMap((m) => (m?.hooks ?? []).map((h) => String(h?.command ?? "")))
			.map((c) => c.replaceAll("$HOME", process.env.HOME ?? "~"));
	} catch {
		return [];
	}
}

// W852: the advice endpoint is a belt specialist whose residency is the
// machine's tier manifest (belt bin/registry-emit.ts `tier` → tier.json,
// warm_ports; llm-keepwarm reads the same file). At BELT_TIER=minimal the
// default :8901 coder is NOT resident, so a healthy minimal fleet painted
// FAIL — the endpoint loads on first use instead. Precedence mirrors belt's
// resolveTier: BELT_TIER env → manifest → full.
const TIER_MANIFEST_PATH = () =>
	process.env.BELT_TIER_MANIFEST ??
	`${process.env.HOME}/.claude/local-llm/tier.json`;

// keepwarm's fail-safe set (hooks/bin/llm-keepwarm.ts) — the ≤4GB residents
const MINIMAL_FALLBACK_PORTS = [8902, 8913];

export function tierFacts(): { tier: string; warmPorts: number[] } {
	let tier =
		process.env.BELT_TIER === "minimal" || process.env.BELT_TIER === "full"
			? process.env.BELT_TIER
			: "full";
	let warmPorts: number[] = [];
	try {
		const doc = JSON.parse(readFileSync(TIER_MANIFEST_PATH(), "utf8")) as {
			tier?: string;
			warm_ports?: unknown;
		};
		if (tier === "full" && (doc.tier === "minimal" || doc.tier === "full"))
			tier = doc.tier;
		if (Array.isArray(doc.warm_ports))
			warmPorts = doc.warm_ports.filter(
				(p): p is number => typeof p === "number" && p > 0 && p < 65536,
			);
	} catch {
		// no manifest / unreadable → env tier or full, no on-demand excuse
	}
	if (tier === "minimal" && !warmPorts.length)
		warmPorts = MINIMAL_FALLBACK_PORTS;
	return { tier, warmPorts };
}

const probeModels = async (origin: string, ms: number): Promise<boolean> => {
	try {
		const r = await fetch(`${origin}/v1/models`, {
			signal: AbortSignal.timeout(ms),
		});
		return r.ok;
	} catch {
		return false;
	}
};

export async function llmCheck(): Promise<{ ok: boolean; detail: string }> {
	const direct = await probeModels(LLM_ORIGIN, 1500);
	if (direct) return { ok: true, detail: `${LLM_ORIGIN} answers` };
	const { tier, warmPorts } = tierFacts();
	// full tier: the endpoint IS resident, when a resident endpoint is down
	// it is down. minimal tier: the advice target loads on demand — the
	// resident swarm answering is what matters (W852 owner complaint).
	if (tier !== "minimal" || !warmPorts.length)
		return { ok: false, detail: `no answer from ${LLM_ORIGIN} within 1.5s` };
	const up = (
		await Promise.all(
			warmPorts.map((p) => probeModels(`http://127.0.0.1:${p}`, 1000)),
		)
	)
		.map((ok, i) => (ok ? warmPorts[i] : 0))
		.filter(Boolean);
	if (!up.length)
		return {
			ok: false,
			detail: `${LLM_ORIGIN} down and the resident swarm (${warmPorts.join(", ")}) silent`,
		};
	return {
		ok: true,
		detail: `${LLM_ORIGIN} is on-demand (tier manifest) — resident swarm ${up.join(", ")} answers; advice works, first use pays a model-load stall`,
	};
}

export async function setupChecks(): Promise<unknown[]> {
	const [llm, hubs] = await Promise.all([llmCheck(), hubCheck()]);
	// wired = a registered command runs the hook BY NAME — the install layout
	// varies (namespaced suspenders/ vs legacy hooks/), so a literal-path match
	// false-negatived every non-namespaced machine
	const hookOk = settingsCommands("PreToolUse").some((c) =>
		c.includes("gate.ts"),
	);
	const startOk = settingsCommands("SessionStart").some((c) =>
		c.includes("session-start.ts"),
	);
	// W852 — the install's activation receipt (~/.config/klh/service-activation.json,
	// SERVICE-ACTIVATION.md): blessed intent for every launchd unit this install
	// registered. Unreadable/empty = install-grade wiring is missing.
	const ACTIVATION_RECEIPT = `${process.env.HOME}/.config/klh/service-activation.json`;
	let activationOk = false;
	let activationDetail =
		"no readable receipt at ~/.config/klh/service-activation.json";
	try {
		const doc = JSON.parse(readFileSync(ACTIVATION_RECEIPT, "utf8")) as {
			services?: unknown[];
		};
		const n = Array.isArray(doc.services) ? doc.services.length : 0;
		if (n > 0) {
			activationOk = true;
			activationDetail = `receipt blessed ${n} services`;
		}
	} catch {
		// missing/unreadable — surfaced as the check's FAIL + fix
	}
	// W852 — the board's own launchd unit: a server cannot paint itself
	// healthy (owner law), so the check is the UNIT is installed, not the
	// process — the answering process IS this board.
	const boardPlist = `${process.env.HOME}/Library/LaunchAgents/com.suspenders.board.plist`;
	const boardOk = existsSync(boardPlist);
	// W882 — the W779 heartbeat fold: maintenance cadence lives in the ONE
	// com.suspenders.fleet-loop unit (services.yaml:144). The retired
	// monitor-agent plists ride the legacyLabels boot-out list
	// (services.yaml:292) — installs remove them, so they are never checked.
	const fleetLoopPlist = `${process.env.HOME}/Library/LaunchAgents/com.suspenders.fleet-loop.plist`;
	const fleetLoopOk = existsSync(fleetLoopPlist);
	return [
		{
			id: "db",
			label: "Control-plane database",
			ok: true,
			detail: `${REG_DIR}/governor.db`,
			fix: null,
		},
		{
			id: "hooks-wired",
			label: "Hook gates wired",
			ok: hookOk,
			detail: hookOk
				? gatePath
				: `PreToolUse hooks in ~/.claude/settings.json do not reference ${gatePath}`,
			fix: hookOk ? null : "./install.sh --wire",
		},
		{
			id: "session-start",
			label: "Session injection wired",
			ok: startOk,
			detail: startOk
				? sessionStartPath
				: `SessionStart hooks in ~/.claude/settings.json do not reference ${sessionStartPath}`,
			fix: startOk ? null : "./install.sh --wire",
		},
		{
			id: "fleet-loop",
			label: "Fleet-loop heartbeat unit",
			ok: fleetLoopOk,
			detail: fleetLoopOk
				? "com.suspenders.fleet-loop launchd unit installed"
				: "no com.suspenders.fleet-loop plist in ~/Library/LaunchAgents",
			fix: fleetLoopOk ? null : "./install.sh --with-launchd",
		},
		{
			id: "activation",
			label: "Service activation receipt",
			ok: activationOk,
			detail: activationDetail,
			fix: activationOk ? null : "./install.sh --with-launchd",
		},
		{
			id: "board-unit",
			label: "Board service unit",
			ok: boardOk,
			detail: boardOk
				? "com.suspenders.board launchd unit installed"
				: "no com.suspenders.board plist in ~/Library/LaunchAgents",
			fix: boardOk ? null : "./install.sh --with-launchd",
		},
		{
			id: "llm",
			label: "Advice LLM endpoint",
			ok: llm.ok,
			detail: llm.detail,
			fix: llm.ok ? null : "local LLM stack docs",
		},
		{
			id: "hubs",
			label: "Hub reachability",
			ok: hubs.ok,
			detail: hubs.detail,
			fix: hubs.fix,
		},
		{ id: "bind", label: "LAN binding", ok: true, detail: BIND, fix: null },
	];
}
