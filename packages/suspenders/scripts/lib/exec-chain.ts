// scripts/lib/exec-chain.ts — W183.2: the lane executor chain, decomposed
// out of dispatch-next.ts (1500-line law). One module owns the chain
// vocabulary: the repo .prefer file chain (must=/prefer=/can=/hub=,
// dotfiles-win)
// and the ordered default_executors fallback chain — execPick walks either
// by attempt index (a dead lane re-dispatch advances it; overrun parks on
// the last entry), the same-bin tail rides claude native --fallback-model,
// "claude" stays the appended last resort.
import { readFileSync } from "node:fs";
// feed values (llm:<machine>:<tail>) translate to belt model ids via the
// catalog grammar; lookups: swarm inventory + BYO local-models.json
import { feedModelOf } from "../../hooks/board/executor-catalog.ts";
import { specialistByPort } from "../../hooks/board/local-swarm.ts";
import { readBoardSettings } from "../../hooks/lib/board-config.ts";
// W374: the per-provider quota measure — providerOf keys a chain slot to its
// provider; quota demotion reorders the DEFAULT ladder only (a .prefer MUST
// chain is owner intent, W228 parity with the W620 cv reorder).
import type { ProviderPenalty } from "../../hooks/lib/exec-quota.ts";
import { providerOf } from "../../hooks/lib/exec-quota.ts";
// W422: which chain tokens are their own CLI vs belt model pins is ADAPTER
// data (registry.ts) — the if copilot/else-claude ternaries retired here.
import {
	adapterFor,
	isSpawnableExecutor,
} from "../../hooks/lib/executors/registry.ts";
// W813: chain tokens may name HUBS (a stack.json/hubs.json label rides
// that hub); can= doability probes resolveLaneExecutor + darkHubNow + the
// cv tally — all sync, so execPick stays sync.
import { readRegistry } from "../../hooks/lib/hub-locate.ts";
import { readUserPlane } from "../../hooks/lib/repo-laws.ts";
import { darkHubNow, tryLoadStack } from "../../hooks/lib/stack-config.ts";
import { resolveLaneExecutor } from "./launch-preflight.ts";

/** Repo dotfile (.prefer, dotfiles-win law): `must=` / `prefer=` / `can=`
 * / `hub=Label` / `hub-url=url[,url...]` — a repo pins its executor chain
 * and hub label. `hub` is resolved to a real endpoint by hub-locate.ts
 * (owner directive 2026-10-03: "local hub to remote hubs scenario" — label
 * is not just a display prefix); `hub-url` adds repo-declared one-off
 * candidates tried before the global registry (most specific intent wins).
 * Policy still gates: an executor the W201 allow-list denies SKIPs with a
 * loud note.
 *
 * `must=`/`prefer=` may repeat and carry comma-lists (W813: `must=a,b` =
 * two targets on one line, the LEFT one tried first). W813 POSITION LAW:
 * later directives win per position — a directive on a later line outranks
 * one above it (the 2026-10-03 musts-first grouping is retired; a prefer=
 * line below a must= line is genuinely tried first). `directives` is the
 * file-order list; execPick() orders + walks it by attempt index.
 *
 * W813 `can=<model|hub>` — the developer override: when the target is
 * doable on this machine it INVALIDATES the must= lines (one-shot, no
 * must edit needed); unavailable, the line vanishes and must stands
 * unchanged. A later can= line wins. */
export interface PreferChainEntry {
	value: string;
	kind: "must" | "prefer" | "can";
	/** 1-based source line — the W813 position tiebreak. */
	line: number;
}

/** Audit metadata for the actual executor selection, never a routing input. */
export interface PreferDecision {
	source: "dotfile" | "default" | "posture";
	directive: "must" | "prefer" | "can" | "default" | "posture";
	line: number;
	index: number;
	target: string;
	can: "absent" | "active" | "unavailable";
}

export const posturePreference = (
	selected: PreferDecision,
	target: string,
	index: number,
): PreferDecision => ({
	source: "posture",
	directive: "posture",
	line: 0,
	index,
	target,
	can: selected.can,
});

export const preferOf = (
	repo: string,
): {
	directives: PreferChainEntry[];
	hub: string | null;
	hubUrls: string[];
	can: { value: string; line: number } | null;
} => {
	try {
		const directives: PreferChainEntry[] = [];
		let hub: string | null = null;
		let hubUrlRaw = "";
		let can: { value: string; line: number } | null = null;
		const lines = readFileSync(`${repo}/.prefer`, "utf8").split("\n");
		for (let li = 0; li < lines.length; li++) {
			const line = lines[li] ?? "";
			const i = line.indexOf("=");
			if (i <= 0) continue;
			const k = line.slice(0, i).trim();
			const v = line.slice(i + 1).trim();
			if (!v) continue;
			// W519 plane split: a quoted value (or any value carrying a space)
			// is the .prefer ROUTING plane (lib/prefer-routing.ts) — never an
			// executor-chain entry; a chain entry with a space can only ever
			// pin a garbage model. Legacy executor files (must=opus) are
			// unquoted single tokens and ride the chain exactly as before.
			if (v.startsWith('"') || /\s/.test(v)) continue;
			if (k === "must" || k === "prefer") {
				const kind: "must" | "prefer" = k === "must" ? "must" : "prefer";
				// W813 comma-list: `must=a,b` = repeated lines on one line,
				// left target tried first (position law orders LINES, not commas)
				for (const value of v
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean))
					directives.push({ value, kind, line: li + 1 });
			} else if (k === "can") {
				can = { value: v, line: li + 1 }; // later can= wins (position law)
			} else if (k === "hub") hub = v;
			else if (k === "hub-url") hubUrlRaw = v;
		}
		return {
			directives,
			hub,
			hubUrls: hubUrlRaw
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean),
			can,
		};
	} catch {
		return { directives: [], hub: null, hubUrls: [], can: null };
	}
};

// W422: a chain token that names a registered agent rides its own binary;
// a MISS is a belt model pin — belt routes by model id, so a model name IS
// an executor riding the claude CLI (W183.2 semantics, now registry data).
const binOf = (e: string): string => adapterFor(e).bin;
const modelOf = (e: string): string | null =>
	isSpawnableExecutor(e) ? null : e;

// W183.2 — one wiring of the catalog's feed-value grammar to its sources:
// llm:local:<port> → swarm inventory, llm:user:<name> → local-models.json,
// any other llm:<machine>:<tail> tail IS the belt model id.
const feedModel = (e: string): string | null =>
	feedModelOf(e, specialistByPort, (n) =>
		readUserPlane().entries.find((u) => u.name === n),
	);
const slotOf = (e: string): { model: string | null; bin: string } | null => {
	// W422: registered agents ride their own CLI with NO model pin (belt
	// routes the model for model-named tokens only); unregistered tokens
	// translate via the feed/model catalog or drop out.
	if (isSpawnableExecutor(e)) return { model: null, bin: binOf(e) };
	const model = feedModel(e);
	return model ? { model, bin: binOf(e) } : null;
};

// W813: a chain token may name a HUB — known = a stack.json hub profile or
// hubs.json registry label (case-insensitive, resolveHub precedent). A hub
// slot rides the default executor (claude, NO model pin — the hub's belt
// routes the model).
const hubLabelOf = (e: string): string | null => {
	if (isSpawnableExecutor(e) || !e.trim()) return null;
	const tok = e.trim().toLowerCase();
	if (
		Object.keys(tryLoadStack()?.hubs ?? {}).some((l) => l.toLowerCase() === tok)
	)
		return e.trim();
	const reg = readRegistry();
	return Object.keys(reg).some((l) => l.toLowerCase() === tok)
		? e.trim()
		: null;
};

// W374 vocabulary: provider-exhaustion evidence is the one unavailable
// signal the picker has for model targets.
const exhausted = (e: string, quota?: ProviderPenalty): boolean => {
	const p = providerOf(e);
	return !!p && !!(quota?.get(p) ?? null);
};

// W813: classify a chain token into its ride — spawnable executor, hub
// slot, or model pin (the model pin shape is unchanged W183.2 behavior).
const slotFor = (
	e: string,
): { model: string | null; bin: string; hub: string | null } => {
	if (isSpawnableExecutor(e)) return { model: null, bin: binOf(e), hub: null };
	if (hubLabelOf(e)) return { model: null, bin: "claude", hub: e };
	return { model: modelOf(e), bin: binOf(e), hub: null };
};

// W813: the .prefer directives ordered for the attempt walk — later lines
// win (position law); a doable can= joins at its line as a prefer-kind
// entry and INVALIDATES the must lines, an unavailable one vanishes and
// must stands unchanged.
const chainEntriesOf = (
	prefer: ReturnType<typeof preferOf>,
	cvOf?: Map<string, number>,
	quota?: ProviderPenalty,
): { entries: PreferChainEntry[]; can: PreferDecision["can"] } => {
	const canTok =
		prefer.can && canDoable(prefer.can.value, cvOf, quota) ? prefer.can : null;
	const kept = prefer.directives.filter((d) => !canTok || d.kind !== "must");
	if (canTok)
		kept.push({ value: canTok.value, kind: "can", line: canTok.line });
	// stable sort: equal lines keep file order (comma-list left-first)
	kept.sort((a, b) => b.line - a.line);
	return {
		entries: kept,
		can: canTok ? "active" : prefer.can ? "unavailable" : "absent",
	};
};

// W813 can= doability — sync probes only (execPick stays sync):
// executor → its bin resolves (launch-preflight); hub → known label NOT
// inside a quiet-hours dark-window (W483: a dark hub is EXPECTED down);
// feed value → translates to a real model; bare model id → recent
// validated use on THIS machine (the cv tally) with no exhaustion evidence.
const canDoable = (
	e: string,
	cvOf?: Map<string, number>,
	quota?: ProviderPenalty,
): boolean => {
	if (isSpawnableExecutor(e)) return resolveLaneExecutor(e) !== null;
	if (hubLabelOf(e)) return !darkHubNow(e);
	if (e.includes(":")) {
		const m = feedModel(e);
		return !!m && !exhausted(m, quota);
	}
	return (cvOf?.get(e) ?? 0) > 0 && !exhausted(e, quota);
};

/** Executor pick (W201 policy + W176 prefer-drives + dotfiles-win): a repo
 * .prefer MUST beats everything except the policy allow-list; otherwise the
 * first default_executors entry that survives wins. Non-claude/codex
 * executors ride the claude CLI with ANTHROPIC_MODEL pinned — belt routes
 * by model id, so a model name IS an executor. copilot rides its own CLI.
 * The hub label now resolves to a real endpoint via hub-locate.ts (hub,
 * hubUrls passed through for the caller to resolve — resolution is async,
 * network-touching, and does not belong in this sync picker).
 *
 * `attempt` walks the .prefer directive chain (W813 position law: later
 * directives win — attempt 0 rides the LAST directive line; a
 * dead/resumed lane advances the index toward earlier directives so the
 * fleet loop itself IS the cross-bin retry (claude -> copilot works,
 * not just model->model). Within one spawn, same-bin chain entries
 * AFTER the picked index ride natively too: claude's own
 * `--fallback-model` (comma list, retries in order, confirmed 2026-10-03
 * to recover even from a flat invalid-model-name 400 — not just overload)
 * — so a single process already tries several models before a re-dispatch
 * cycle is ever needed.
 *
 * `quota` (W374) is the per-provider penalty map (hooks/lib/exec-quota.ts):
 * slots riding a provider with POSITIVE exhaustion evidence demote below
 * healthy ones — quota health outranks trust, an exhausted provider strands
 * the lane (429 death → W366 reclaim dance) while trust only ranks among
 * usable slots. Applies to the DEFAULT ladder ONLY. */
export const execPick = (
	attempt = 0,
	repo: string,
	cvOf?: Map<string, number>,
	quota?: ProviderPenalty,
): {
	name: string;
	agent: string;
	model: string | null;
	bin: string;
	hub: string | null;
	hubUrls: string[];
	fallbackModels: string[];
	chainLen: number;
	chainIdx: number;
	preference: PreferDecision;
} => {
	const prefer = preferOf(repo);
	const s = readBoardSettings().settings;
	const enabled = s.enabled_executors;
	const allowed = (name: string): boolean => !enabled || enabled.includes(name);
	const label = (executor: string, hubOverride?: string | null): string => {
		const h = hubOverride ?? prefer.hub;
		return h ? `[${h.toUpperCase()}] ${executor}` : executor;
	};
	const { entries: chainEntries, can } = chainEntriesOf(prefer, cvOf, quota);
	if (chainEntries.length > 0) {
		const chain = chainEntries.map((d) => d.value);
		const idx = Math.min(attempt, chain.length - 1);
		const e = chain[idx];
		const chosen = chainEntries[idx];
		const slot = slotFor(e);
		// W228+W813: the directive at the picked position is owner intent —
		// allow-list collision is surfaced, never silently rerouted.
		if (!allowed(e))
			console.log(
				`NOTE — .prefer chain[${idx}]=${e} not in enabled_executors; directive wins (W228/W813)`,
			);
		// W374: a chain slot riding an exhausted provider is surfaced, never
		// rerouted (same law as the allow-list collision above)
		const qwhy = quota?.get(providerOf(slot.model ?? e) ?? "");
		if (qwhy)
			console.log(
				`NOTE — quota: .prefer chain[${idx}]=${e} rides an exhausted provider (${qwhy}); directive wins (W228/W813)`,
			);
		const bin = slot.bin;
		// same-bin tail after idx: natively chained via --fallback-model so
		// one process tries all of them before a dead-lane re-dispatch is
		// needed; a bin switch further down the chain can only be reached
		// by that re-dispatch (a CLI flag can't cross binaries mid-process).
		const fallbackModels = chain.slice(idx + 1).flatMap((next) => {
			const ns = slotFor(next);
			return ns.bin === bin && ns.model ? [ns.model] : [];
		});
		return {
			agent: label(e, slot.hub),
			model: slot.model,
			bin,
			hub: slot.hub ?? prefer.hub,
			hubUrls: prefer.hubUrls,
			fallbackModels,
			chainLen: chain.length,
			chainIdx: idx,
			name: e,
			preference: {
				source: "dotfile",
				directive: chosen.kind,
				line: chosen.line,
				index: idx,
				target: e,
				can,
			},
		};
	}
	// W183.2 - the ordered default_executors list IS the fallback chain: the
	// same attempt-walk the .prefer chain gets (a dead lane re-dispatch
	// advances the index; overrun parks on the last entry), the same-bin tail
	// rides claude native --fallback-model, and "claude" stays the last
	// resort unless the allow-list blocks it. Untranslatable feed values
	// (unknown llm: target) drop out - they name no real model.
	const chain: { name: string; model: string | null; bin: string }[] = [];
	// dedupe preserving order — a list that already ends with claude must not
	// carry the appended last resort twice
	for (const name of new Set([...(s.default_executors ?? []), "claude"])) {
		if (!allowed(name)) continue;
		const slot = slotOf(name);
		if (slot) chain.push({ name, ...slot });
	}
	// W620: the trust tally reorders the DEFAULT ladder only — stable sort by
	// consecutive-valid desc (missing = 0; no cvOf AND no quota penalty
	// anywhere = order preserved, claude stays the appended last resort). A
	// .prefer MUST chain is NEVER reordered (W228 owner law).
	// W374: quota health outranks trust — slots riding a provider with
	// positive exhaustion evidence sort below healthy slots (an exhausted
	// provider strands the lane, 429 death → W366 reclaim dance; trust only
	// ranks among usable slots). The pre-sort head at the attempt index is
	// what quota reshuffles, and the reshuffle is loud (NOTE, admission
	// NOTE precedent).
	const quotaWhy = (slot: {
		name: string;
		model: string | null;
	}): string | null => quota?.get(providerOf(slot.model ?? slot.name)) ?? null;
	const penaltyOf = (slot: { name: string; model: string | null }): number =>
		quotaWhy(slot) ? 1 : 0;
	const wouldBe = chain[Math.min(attempt, chain.length - 1)];
	if (cvOf || quota)
		chain.sort((a, b) => {
			const dq = penaltyOf(a) - penaltyOf(b);
			if (dq !== 0) return dq;
			return (
				(cvOf?.get(b.model ?? b.name) ?? 0) -
				(cvOf?.get(a.model ?? a.name) ?? 0)
			);
		});
	// W374: loud, never silent — name what quota routed around and where
	if (quota && wouldBe && penaltyOf(wouldBe) === 1)
		console.log(
			`NOTE — quota: ${wouldBe.name} demoted (${quotaWhy(wouldBe)}) — pick routes to ${chain[0]?.name ?? "claude"}`,
		);
	if (chain.length > 0) {
		const idx = Math.min(attempt, chain.length - 1);
		const { name, model, bin } = chain[idx];
		const fallbackModels = chain
			.slice(idx + 1)
			.filter((next) => next.bin === bin)
			.map((next) => next.model)
			.filter((m): m is string => !!m);
		return {
			agent: label(name),
			model,
			bin,
			hub: prefer.hub,
			hubUrls: prefer.hubUrls,
			fallbackModels,
			chainLen: chain.length,
			chainIdx: idx,
			name,
			preference: {
				source: "default",
				directive: "default",
				line: 0,
				index: idx,
				target: name,
				can,
			},
		};
	}
	return {
		name: "claude",
		agent: "claude",
		model: null,
		bin: "claude",
		hub: prefer.hub,
		hubUrls: prefer.hubUrls,
		fallbackModels: [],
		chainLen: 0,
		chainIdx: 0,
		preference: {
			source: "default",
			directive: "default",
			line: 0,
			index: 0,
			target: "claude",
			can,
		},
	};
};
