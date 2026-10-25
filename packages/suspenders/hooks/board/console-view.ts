// hooks/board/console-view.ts — W147 console: data gathering + policy patch builders (W157 board split).
// Pieces moved verbatim from bin/fleet-board.ts; exports widened so
// sibling modules and the route modules import them.

import { db, BELT_REPO } from "./context.ts";
import {
	ConfigError,
	parsePolicy,
	policyAsJson,
	policyWritePath,
	readBoardSettings,
	resolvePolicy,
} from "../lib/board/board-config.ts";
import type {
	PolicyPatch,
	PolicyGatewayParsed,
} from "../lib/board/board-config.ts";
import type {
	ConsoleMe,
	BeltView,
	Feature,
	LocalService,
	UpstreamGroup,
	LocalView,
} from "../bin/console-html.ts";
import { probeAll, withRecovery } from "./service-probe.ts";
import { networkPayload } from "./network-overview.ts";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readEffectiveUpstreams } from "./console-upstreams.ts";

// ─── W147 console: data gathering for the console pages ───────────────────
export const consoleMe = (): ConsoleMe => {
	const row = db
		.query(
			"SELECT actor, tags FROM sessions WHERE actor IS NOT NULL ORDER BY started_at DESC, hb DESC LIMIT 1",
		)
		.get() as { actor: string; tags: string | null } | null;
	const actors = (
		db
			.query(
				"SELECT DISTINCT actor FROM sessions WHERE actor IS NOT NULL ORDER BY actor",
			)
			.all() as { actor: string }[]
	).map((r) => r.actor);
	let tags: Record<string, string> = {};
	try {
		tags = row?.tags ? (JSON.parse(row.tags) as Record<string, string>) : {};
	} catch {}
	return {
		actor: row?.actor ?? "unassigned",
		tags,
		actors,
		defaultActor: readBoardSettings().settings.default_actor ?? "",
	};
};

// buckle upstreams.json (read-only display): group name == wire id; an empty
// group is DORMANT — in the ladder but resolving to zero deployments.
const upstreamSnapshot = () =>
	readEffectiveUpstreams({
		basePath: process.env.BUCKLE_REPO
			? `${process.env.BUCKLE_REPO}/upstreams.json`
			: new URL("../../../buckle/upstreams.json", import.meta.url).pathname,
		overridePath:
			process.env.BUCKLE_UPSTREAMS ??
			`${process.env.HOME}/.claude/local-llm/upstreams.json`,
	});
export const readUpstreams = (): UpstreamGroup[] | null =>
	upstreamSnapshot()?.groups ?? null;

export const gatherBeltView = async (): Promise<BeltView> => {
	const pol = resolvePolicy({ beltRepo: BELT_REPO });
	let gateway: PolicyGatewayParsed | null = null;
	let policyError: string | null = null;
	if (pol) {
		try {
			gateway = parsePolicy(pol.text);
		} catch (e) {
			policyError =
				e instanceof ConfigError
					? e.message
					: e instanceof Error
						? e.message
						: String(e);
		}
	}
	// W273: every monitored service in the recovery map, not just two ports
	const health = (await probeAll()).map(withRecovery);
	const upstreams = upstreamSnapshot();
	return {
		policy: pol,
		gateway,
		policyError,
		health,
		groups: upstreams?.groups ?? null,
		upstreamSource: upstreams?.source,
		// W858.10.3: the Network overview payload as the card's SSR seed
		// (cached probes shared — no extra fan-out)
		network: await networkPayload(),
	};
};

// 15s cache — the probes hit every monitored port; a console view must not
// re-fan-out per request. probeAll classifies up/degraded/down (W273).
let probeCache: {
	at: number;
	probes: Awaited<ReturnType<typeof probeAll>>;
} | null = null;
const PROBE_TTL_MS = 15_000;
export const cachedProbes = async (): Promise<
	Awaited<ReturnType<typeof probeAll>>
> => {
	if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS)
		return probeCache.probes;
	const probes = await probeAll();
	probeCache = { at: Date.now(), probes };
	return probes;
};

export const gatherLocalView = async (): Promise<LocalView> => {
	const regPath =
		process.env.KLH_LOCAL_REGISTRY ??
		`${process.env.HOME}/.local/state/klh-local/registry.json`;
	const probes = await cachedProbes();
	let services: LocalService[] = [];
	try {
		const doc = JSON.parse(readFileSync(regPath, "utf8")) as {
			name?: string;
			port?: number;
			created_at?: string;
			upstream?: string;
		}[];
		services = Array.isArray(doc)
			? doc
					.filter((s) => s && typeof s.name === "string")
					.map((s) => ({
						name: String(s.name),
						port: Number(s.port ?? 0),
						created: String(s.created_at ?? ""),
						upstream: typeof s.upstream === "string" ? s.upstream : undefined,
					}))
			: [];
	} catch {
		// registry absent (hub deployments) — the probe table carries the view
	}
	return {
		services,
		regPath,
		error: null,
		probes,
		source: services.length
			? probes.length
				? "probes+registry"
				: "registry"
			: "probes",
	};
};

// Normal policy form → patch. Numbered tier inputs keep ladder order explicit
// while allowing operators to add a deployment without editing JSON.
export const formToPatch = (
	_feature: Feature,
	f: URLSearchParams,
): PolicyPatch => {
	const num = (k: string): number | undefined => {
		const v = (f.get(k) ?? "").trim();
		if (v === "") return undefined;
		const n = Number(v);
		return Number.isFinite(n) ? n : Number.NaN;
	};
	const ladder: NonNullable<PolicyPatch["ladder"]> = { model: "", tiers: [] };
	const numbered = new Map<string, Map<number, string>>();
	for (const [k, v] of f.entries()) {
		if (k.startsWith("tier_")) {
			const split = k.lastIndexOf("_");
			const index = Number(k.slice(split + 1));
			const model = decodeURIComponent(k.slice(5, split));
			if (
				!model ||
				["__proto__", "constructor", "prototype"].includes(model) ||
				!Number.isInteger(index) ||
				index < 0 ||
				index > 20
			)
				throw new ConfigError("invalid ladder tier field");
			const rows = numbered.get(model) ?? new Map<number, string>();
			rows.set(index, v.trim());
			numbered.set(model, rows);
			continue;
		}
		if (!k.startsWith("ladder_")) continue;
		ladder.model = k.slice(7);
		ladder.tiers = (v ?? "")
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
	}
	const ladders = Object.fromEntries(
		Array.from(numbered.entries(), ([model, rows]) => [
			model,
			Array.from(rows.entries())
				.sort(([a], [b]) => a - b)
				.map(([, tier]) => tier)
				.filter(Boolean),
		]),
	);
	return {
		ladder: ladder.model ? ladder : undefined,
		ladders: Object.keys(ladders).length ? ladders : undefined,
		num_retries: num("num_retries"),
		allowed_fails: num("allowed_fails"),
		cooldown_time: num("cooldown_time"),
	};
};

// values JSON (the preview page's hidden field) → validated patch or throw
export const valuesToPatch = (raw: string): PolicyPatch => {
	const v = JSON.parse(raw) as Record<string, unknown>;
	const out: PolicyPatch = {};
	for (const k of ["num_retries", "allowed_fails", "cooldown_time"] as const) {
		const n = v[k];
		if (n === undefined || n === null || n === "") continue;
		if (typeof n !== "number" || !Number.isInteger(n) || n < 0)
			throw new ConfigError(`gateway.${k}: must be an integer >= 0`);
		out[k] = n;
	}
	if (v.ladder !== undefined && v.ladder !== null) {
		if (typeof v.ladder !== "object")
			throw new ConfigError("ladder: bad value");
		const l = v.ladder as { model?: unknown; tiers?: unknown };
		if (typeof l.model !== "string" || !Array.isArray(l.tiers))
			throw new ConfigError("ladder: bad value");
		out.ladder = { model: l.model, tiers: l.tiers.map((t) => String(t)) };
	}
	if (v.ladders !== undefined && v.ladders !== null) {
		if (typeof v.ladders !== "object" || Array.isArray(v.ladders))
			throw new ConfigError("ladders: bad value");
		const ladders: Record<string, string[]> = {};
		for (const [model, tiers] of Object.entries(v.ladders)) {
			if (
				!model ||
				["__proto__", "constructor", "prototype"].includes(model) ||
				!Array.isArray(tiers) ||
				tiers.some((t) => typeof t !== "string")
			)
				throw new ConfigError(`ladders.${model}: bad value`);
			ladders[model] = tiers as string[];
		}
		out.ladders = ladders;
	}
	return out;
};

// The text the settings flow reads and rewrites: the env/runtime write path
// when it exists, else the resolved chain text (the new runtime file will be
// seeded from exactly this). One baseline for preview AND apply — the diff
// the operator confirms is the diff that lands.
export const policyBaseline = (): { text: string; mtimeMs: number } => {
	const wp = policyWritePath();
	if (existsSync(wp)) {
		const st = statSync(wp);
		return { text: readFileSync(wp, "utf8"), mtimeMs: st.mtimeMs };
	}
	const pol = resolvePolicy({ beltRepo: BELT_REPO });
	return {
		text: pol ? policyAsJson(pol.text) : '{"version":1,"gateway":{}}\n',
		mtimeMs: pol?.mtimeMs ?? 0,
	};
};
