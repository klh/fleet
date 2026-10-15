// hooks/lib/exec-quota.ts — W374: the per-provider quota measure the
// executor pick reads (exec-chain.ts DEFAULT-ladder reorder; W620
// executor-cv parity: a READER over existing state, zero new emission).
// Providers with POSITIVE exhaustion evidence demote — no evidence never
// demotes:
//   zai      the buckle-gate cooldown fact `zai.cooldown.until` (epoch ms —
//            a live 429 names its own end) and the W335 window state file
//            (remembered 429-reset expiries; near-cliff = inside the
//            margin). Pick time only READS the state file: fresh
//            observations land via admission/quota-window, the fact is the
//            authoritative exhaustion signal.
//   copilot  the credit-forecast fact `copilot.credits.headroom` — verdict
//            WARN with fired arms, fresh within a day (a stale WARN is
//            history, not exhaustion).
// Class → provider: spawnable executors ride their adapter id (registry
// data); model pins ride zai when the token carries the family prefix
// (glm/zai — the W335 detector IS the z.ai 429 format) or a machine-listed
// prefix (SUSPENDERS_QUOTA_ZAI_CLASSES, config-over-code extension).
// W228 parity: the reorder applies to the DEFAULT ladder only — a .prefer
// MUST chain is owner intent and is never rerouted.
import { existsSync, readFileSync } from "node:fs";
import type { GovernorStore } from "./govdb.ts";
import { adapterForExact } from "./executors/registry.ts";

export type ProviderPenalty = Map<string, string>; // provider → demotion reason

// family prefixes a zai-riding model pin carries; the machine extends via
// env (comma list of prefixes) — never hardcoded per model id
export const zaiPrefixes = (): string[] => {
	const env = (process.env.SUSPENDERS_QUOTA_ZAI_CLASSES ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	return [...new Set(["glm", "zai", ...env])];
};

export const providerOf = (cls: string): string | null => {
	const adapter = adapterForExact(cls);
	if (adapter?.spawnable) return adapter.id;
	const tok = cls.toLowerCase();
	return zaiPrefixes().some((p) => tok.startsWith(p)) ? "zai" : null;
};

const WINDOW_STATE = (): string =>
	`${process.env.HOME}/.cache/claude-governor/quota-window.json`;

// read-only window read over the state quotaWindowVerdict persists — the
// first future reset inside the margin is the near-cliff signal
const windowNearCliff = (now: number, marginMs: number): string | null => {
	try {
		if (!existsSync(WINDOW_STATE())) return null;
		const resets = (
			JSON.parse(readFileSync(WINDOW_STATE(), "utf8")) as {
				resets?: number[];
			}
		).resets ?? [];
		const expiry = resets.find((r) => r > now);
		if (expiry === undefined) return null;
		const leftMin = Math.round((expiry - now) / 60000);
		return leftMin * 60000 <= marginMs
			? `quota window near cliff (~${leftMin} min left)`
			: null;
	} catch {
		return null; // unreadable state = no evidence
	}
};

// a stale headroom WARN is history, not exhaustion (credit-forecast writes
// the fact only on WARN; the JSON carries its read time)
const HEADROOM_FRESH_MS = 24 * 3600_000;

export const quotaProviderPenalty = (
	store: GovernorStore,
	opts: { now?: number; marginMs?: number } = {},
): ProviderPenalty => {
	const now = opts.now ?? Date.now();
	const marginMs = opts.marginMs ?? 45 * 60_000;
	const penalty: ProviderPenalty = new Map();
	const fact = (key: string): string | null => {
		try {
			const r = store
				.query("SELECT value FROM facts WHERE key = ?")
				.get(key) as { value: string } | null;
			return r?.value ?? null;
		} catch {
			return null; // pre-facts db — no evidence
		}
	};
	// z.ai: a live cooldown fact outranks the remembered window; either demotes
	const cd = fact("zai.cooldown.until");
	const cdMs = cd === null ? Number.NaN : Number(cd);
	if (Number.isFinite(cdMs) && cdMs > now)
		penalty.set("zai", `cooldown until ${new Date(cdMs).toISOString()}`);
	else {
		const win = windowNearCliff(now, marginMs);
		if (win) penalty.set("zai", win);
	}
	try {
		const raw = fact("copilot.credits.headroom");
		if (raw) {
			const h = JSON.parse(raw) as {
				verdict?: string;
				arms?: unknown;
				at?: number;
			};
			if (
				h.verdict === "WARN" &&
				Array.isArray(h.arms) &&
				h.arms.length > 0 &&
				typeof h.at === "number" &&
				now - h.at <= HEADROOM_FRESH_MS
			)
				penalty.set(
					"copilot",
					`credit headroom WARN (${(h.arms as string[]).join("+")})`,
				);
		}
	} catch {} // corrupt fact = no evidence
	return penalty;
};
