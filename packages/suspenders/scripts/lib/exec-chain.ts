// scripts/lib/exec-chain.ts — W183.2: the lane executor chain, decomposed
// out of dispatch-next.ts (1500-line law). One module owns the chain
// vocabulary: the repo .prefer file chain (must=/prefer=/hub=, dotfiles-win)
// and the ordered default_executors fallback chain — execPick walks either
// by attempt index (a dead lane re-dispatch advances it; overrun parks on
// the last entry), the same-bin tail rides claude native --fallback-model,
// "claude" stays the appended last resort.
import { readFileSync } from "node:fs";
import { readBoardSettings } from "../../hooks/lib/board-config.ts";
// feed values (llm:<machine>:<tail>) translate to belt model ids via the
// catalog grammar; lookups: swarm inventory + BYO local-models.json
import { feedModelOf } from "../../hooks/board/executor-catalog.ts";
import { specialistByPort } from "../../hooks/board/local-swarm.ts";
import { readUserPlane } from "../../hooks/lib/repo-laws.ts";
// W422: which chain tokens are their own CLI vs belt model pins is ADAPTER
// data (registry.ts) — the if copilot/else-claude ternaries retired here.
import { adapterFor, isSpawnableExecutor } from "../../hooks/lib/executors/registry.ts";

/** Repo dotfile (.prefer, dotfiles-win law): `must=executor` / `prefer=`
 * / `hub=Label` / `hub-url=url[,url...]` — a repo pins its executor and
 * hub label. `hub` is resolved to a real endpoint by hub-locate.ts (owner
 * directive 2026-10-03: "local hub to remote hubs scenario" — label is not
 * just a display prefix); `hub-url` adds repo-declared one-off candidates
 * tried before the global registry (most specific intent wins, same rule
 * as must). Policy still gates: an executor the W201 allow-list denies
 * SKIPs with a loud note.
 *
 * `must=`/`prefer=` may repeat — owner directive 2026-10-03: "we don't care
 * if it's claude cli or copilot or anything like that, we just want the
 * agents working to always go for the MUST or try the PREFER (there can be
 * multiple must and prefer in sequential order)". All `must=` lines (file
 * order) come first in the chain, then all `prefer=` lines (file order) —
 * must always outranks prefer, ties broken by position. `chain` is that
 * full ordered list; execPick() walks it by attempt index. */
export const preferOf = (
	repo: string,
): {
	chain: string[];
	hub: string | null;
	hubUrls: string[];
} => {
	try {
		const musts: string[] = [];
		const prefers: string[] = [];
		let hub: string | null = null;
		let hubUrlRaw = "";
		for (const line of readFileSync(`${repo}/.prefer`, "utf8").split("\n")) {
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
			if (k === "must") musts.push(v);
			else if (k === "prefer") prefers.push(v);
			else if (k === "hub") hub = v;
			else if (k === "hub-url") hubUrlRaw = v;
		}
		return {
			chain: [...musts, ...prefers],
			hub,
			hubUrls: hubUrlRaw
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean),
		};
	} catch {
		return { chain: [], hub: null, hubUrls: [] };
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

/** Executor pick (W201 policy + W176 prefer-drives + dotfiles-win): a repo
 * .prefer MUST beats everything except the policy allow-list; otherwise the
 * first default_executors entry that survives wins. Non-claude/codex
 * executors ride the claude CLI with ANTHROPIC_MODEL pinned — belt routes
 * by model id, so a model name IS an executor. copilot rides its own CLI.
 * The hub label now resolves to a real endpoint via hub-locate.ts (hub,
 * hubUrls passed through for the caller to resolve — resolution is async,
 * network-touching, and does not belong in this sync picker).
 *
 * `attempt` walks the must/prefer chain (owner directive 2026-10-03:
 * sequential try-in-order, CLI-agnostic). Attempt 0 is the first `must=`
 * (or first `prefer=` when there's no must); a dead/resumed lane advances
 * the index so the fleet loop itself IS the cross-bin retry (claude ->
 * copilot works, not just model->model). Within one spawn, same-bin chain
 * entries AFTER the picked index ride natively too: claude's own
 * `--fallback-model` (comma list, retries in order, confirmed 2026-10-03
 * to recover even from a flat invalid-model-name 400 — not just overload)
 * — so a single process already tries several models before a re-dispatch
 * cycle is ever needed. */
export const execPick = (
	attempt = 0,
	repo: string,
	cvOf?: Map<string, number>,
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
} => {
	const prefer = preferOf(repo);
	const s = readBoardSettings().settings;
	const enabled = s.enabled_executors;
	const allowed = (name: string): boolean => !enabled || enabled.includes(name);
	const label = (executor: string): string =>
		prefer.hub ? `[${prefer.hub.toUpperCase()}] ${executor}` : executor;
	if (prefer.chain.length > 0) {
		const idx = Math.min(attempt, prefer.chain.length - 1);
		const e = prefer.chain[idx];
		// W228 owner law: must ALWAYS wins — a repo .prefer is the more
		// specific owner intent; allow-list collision is surfaced, never
		// silently rerouted.
		if (!allowed(e))
			console.log(
				`NOTE — .prefer chain[${idx}]=${e} not in enabled_executors; MUST WINS (W228)`,
			);
		const bin = binOf(e);
		// same-bin tail after idx: natively chained via --fallback-model so
		// one process tries all of them before a dead-lane re-dispatch is
		// needed; a bin switch further down the chain can only be reached
		// by that re-dispatch (a CLI flag can't cross binaries mid-process).
		const fallbackModels = prefer.chain
			.slice(idx + 1)
			.filter((next) => binOf(next) === bin)
			.map((next) => modelOf(next))
			.filter((m): m is string => !!m);
		return {
			agent: label(e),
			model: modelOf(e),
			bin,
			hub: prefer.hub,
			hubUrls: prefer.hubUrls,
			fallbackModels,
			chainLen: prefer.chain.length,
			chainIdx: idx,
			name: e,
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
	// consecutive-valid desc (missing = 0; no cvOf or all-missing = order
	// preserved, claude stays the appended last resort). A .prefer MUST chain
	// is NEVER reordered (W228 owner law).
	if (cvOf)
		chain.sort(
			(a, b) =>
				(cvOf.get(b.model ?? b.name) ?? 0) -
				(cvOf.get(a.model ?? a.name) ?? 0),
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
	};
};
