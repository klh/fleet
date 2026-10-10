#!/usr/bin/env bun
// admission.ts — admission control for z.ai-heavy lanes (W2), the dispatcher
// gate composing quota-window + admission (W21), and the local-degradation
// plan for usage blackouts (W22). Pure CLI: no daemons, no polling loops.
//
//   bun ~/.claude/bin/admission.ts check --kind zai-heavy --as <sid>
//       exit 0 allow (one-line reason) / 1 deny (reason + retry-after) / 2 unknown
//   bun ~/.claude/bin/admission.ts dispatch-check --as <sid> [--project p]
//       quota-window verdict + admission check; exit codes match quota-window
//       (0 safe / 1 near cliff / 2 unknown); a near-cliff deny names the
//       predicted reset and suggests local degradation
//   bun ~/.claude/bin/admission.ts degradation-status
//       JSON degradation plan (keep-on-local vs queued-behind-reset);
//       exit 0 safe / 1 degraded / 2 unknown
//   bun ~/.claude/bin/admission.ts cooldown --retry-after <sec> | --until <iso|epoch-ms> | --clear
//       shared 429 cooldown fact `zai.cooldown.until` — a 429 from any lane
//       cools ALL lanes; --retry-after honors Retry-After plus jitter
//
// W2 concurrency signal (chosen evidence): a lane counts as z.ai-heavy-active
// iff its live progress entry mentions z.ai — entry id and/or label in
// /tmp/agent-progress/<id>.json matches /\bz\.?ai/i. Progress entries are the
// best available cross-lane liveness signal: the only live fleet-wide state a
// non-owner can read (15-min TTL per the progress contract; facts carry no
// liveness semantics, claims are not exposed to non-owners). Lanes opt in by
// mentioning z.ai in their progress id/label.

import { readdirSync, readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { quotaWindowVerdict } from "./quota-window.ts";

const GOV_DIR = `${process.env.HOME}/.cache/claude-governor`;
const DB_PATH = `${GOV_DIR}/governor.db`;
const FACT_KEY = "zai.cooldown.until";
const PROGRESS_DIR = "/tmp/agent-progress";
export const PROGRESS_TTL_MS = 15 * 60_000; // /tmp/agent-progress contract: 15-min TTL
export const ZAI_HEAVY_CAP = 3; // ~3 concurrent z.ai-heavy lanes (W2)
const JITTER_MS = 30_000; // herd-spread added on top of Retry-After
const LOCAL_STACK = {
	coder: "http://127.0.0.1:8901", // 32B coder (llm-routing.md: warm codegen)
	nonThinking: "http://127.0.0.1:8902", // non-thinking 4B (short tasks)
	reasoning: "http://127.0.0.1:8903", // Claude-distilled 27B (deep reasoning)
	anthropicShim: "http://127.0.0.1:4000", // claude-fast; auto-falls-back remote
};

export type ProgressEntry = {
	id: string;
	at: number; // entry timestamp (epoch ms) — liveness = now - at <= TTL
	done: number;
	total: number;
	label?: string;
	etaSeconds?: number;
};

export function isZaiHeavy(e: { id: string; label?: string }): boolean {
	return /\bz\.?ai/i.test(`${e.id} ${e.label ?? ""}`);
}

export function activeEntries(
	entries: ProgressEntry[],
	nowMs: number,
	ttlMs = PROGRESS_TTL_MS,
): ProgressEntry[] {
	return entries.filter((e) => nowMs - e.at <= ttlMs);
}

export function countActiveZaiHeavy(
	entries: ProgressEntry[],
	nowMs: number,
	ttlMs = PROGRESS_TTL_MS,
): number {
	return activeEntries(entries, nowMs, ttlMs).filter(isZaiHeavy).length;
}

// accepts epoch-ms (>=13 digits) or epoch-seconds (10 digits) or ISO
export function parseUntilMs(raw: string): number {
	const s = raw.trim();
	if (/^\d+$/.test(s)) return s.length >= 13 ? Number(s) : Number(s) * 1000;
	return Date.parse(s);
}

export function cooldownVerdict(
	cooldownValue: string | null | undefined,
	nowMs: number,
): { active: boolean; untilMs: number | null; remainingSec: number } {
	const untilMs = cooldownValue ? parseUntilMs(cooldownValue) : NaN;
	if (!Number.isFinite(untilMs))
		return { active: false, untilMs: null, remainingSec: 0 };
	const remainingSec = Math.max(0, Math.ceil((untilMs - nowMs) / 1000));
	return { active: remainingSec > 0, untilMs, remainingSec };
}

// shared cooldown is extend-only: never shorten an active cooldown
export function mergeCooldown(
	existingMs: number | null,
	proposedMs: number,
	nowMs: number,
): number {
	const cd = cooldownVerdict(
		existingMs === null ? null : String(existingMs),
		nowMs,
	);
	return cd.active && cd.untilMs !== null
		? Math.max(cd.untilMs, proposedMs)
		: proposedMs;
}

// deny(1) > unknown(2) > allow(0); output is quota-window convention
// (0 safe / 1 near cliff / 2 unknown)
export function combineVerdicts(quota: number, admission: number): 0 | 1 | 2 {
	if (quota === 1 || admission === 1) return 1;
	if (quota === 2 || admission === 2) return 2;
	return 0;
}

// task-shaped local routing (docs/llm-routing.md); first match wins
const ROUTE_TABLE: Array<[RegExp, { endpoint: string; role: string }]> = [
	[
		/danish|multilingual|translat/i,
		{
			endpoint: LOCAL_STACK.anthropicShim,
			role: "claude-fast shim :4000 (Qwen3.5 multilingual specialist per llm-routing.md)",
		},
	],
	[
		/reason|analys|review|design|plan/i,
		{
			endpoint: LOCAL_STACK.reasoning,
			role: "Claude-distilled 27B reasoning :8903",
		},
	],
	[
		/code|impl|refactor|build|test/i,
		{ endpoint: LOCAL_STACK.coder, role: "32B coder :8901" },
	],
];

export function suggestLocalRoute(label = ""): {
	endpoint: string;
	role: string;
} {
	for (const [re, route] of ROUTE_TABLE) if (re.test(label)) return route;
	return { endpoint: LOCAL_STACK.nonThinking, role: "non-thinking 4B :8902" };
}

export type Verdict = {
	exit: 0 | 1 | 2;
	lines: string[];
	retryAfterSec?: number;
};

// W2 core. Cooldown first (shared hard brake), then the lane cap.
// dbError=true → exit 2 unknown (fail-open-ish: dispatcher decides).
export function admissionVerdict(input: {
	nowMs: number;
	cooldownValue: string | null | undefined;
	dbError?: boolean;
	entries: ProgressEntry[];
}): Verdict {
	const fmt = (s: number) => (s >= 90 ? `${Math.round(s / 60)}m` : `${s}s`);
	if (input.dbError) {
		return {
			exit: 2,
			lines: [
				"admission: UNKNOWN — governor.db unreadable; cannot verify shared z.ai cooldown (fail-open: dispatcher decides)",
			],
		};
	}
	const cd = cooldownVerdict(input.cooldownValue, input.nowMs);
	if (cd.active) {
		const until = new Date(cd.untilMs!).toISOString();
		return {
			exit: 1,
			retryAfterSec: cd.remainingSec,
			lines: [
				`admission: DENY — shared z.ai cooldown active until ${until} (${fmt(cd.remainingSec)} left; a 429 from any lane cools ALL lanes) — route local-first ${LOCAL_STACK.coder} coder / ${LOCAL_STACK.nonThinking} non-thinking / ${LOCAL_STACK.reasoning} reasoning / ${LOCAL_STACK.anthropicShim} shim`,
			],
		};
	}
	const heavies = activeEntries(input.entries, input.nowMs).filter(isZaiHeavy);
	if (heavies.length >= ZAI_HEAVY_CAP) {
		const oldest = Math.min(...heavies.map((e) => e.at));
		const wait = Math.max(
			1,
			Math.ceil((oldest + PROGRESS_TTL_MS - input.nowMs) / 1000),
		);
		return {
			exit: 1,
			retryAfterSec: wait,
			lines: [
				`admission: DENY — z.ai-heavy lane cap ${heavies.length}/${ZAI_HEAVY_CAP} reached — queue behind a lane (retry-after ${fmt(wait)}) or route local-first ${LOCAL_STACK.coder} / ${LOCAL_STACK.reasoning} / ${LOCAL_STACK.anthropicShim}`,
			],
		};
	}
	return {
		exit: 0,
		lines: [
			`admission: ALLOW — ${heavies.length}/${ZAI_HEAVY_CAP} z.ai-heavy lanes active, no cooldown — local-first: default local stack, remote z.ai only for >32k context or frontier quality`,
		],
	};
}

// W21: compose quota-window verdict + admission check; deny > unknown > allow
export function dispatchVerdict(
	quota: { code: number; expiry: number | null; lines: string[] },
	admission: Verdict,
): Verdict {
	const exit = combineVerdicts(quota.code, admission.exit);
	const lines = [...quota.lines, ...admission.lines];
	if (quota.code === 1 && quota.expiry) {
		const iso = new Date(quota.expiry).toISOString();
		lines.push(
			`dispatch: near cliff — predicted reset ${iso}; queue long batches behind it or degrade to local stack ${LOCAL_STACK.coder} / ${LOCAL_STACK.reasoning} / ${LOCAL_STACK.nonThinking} / ${LOCAL_STACK.anthropicShim} (docs/llm-routing.md)`,
		);
	}
	return { exit, lines };
}

export type DegradationPlan = {
	verdict: "near-cliff" | "blackout" | "safe";
	degraded: boolean;
	resetAt: string | null; // predicted reset ISO, null when unknown (blackout)
	resetInMinutes: number | null;
	generatedAt: string;
	localStack: Record<string, string>;
	keepOnLocal: Array<{ id: string; label: string; route: string }>;
	queuedBehindReset: Array<{
		id: string;
		label: string;
		retryAfterMinutes: number | null;
	}>;
	admissionRules: string[];
};

// W22: pure plan builder. quota code 1 → "near-cliff"; code 2 (no predicted
// reset observed) → "blackout" — quota-window cannot distinguish "never used"
// from "quota exhausted awaiting reset", so unknown maps to blackout-risk.
export function buildDegradationPlan(
	quota: { code: number; expiry: number | null },
	entries: ProgressEntry[],
	nowMs: number,
): DegradationPlan {
	const live = activeEntries(entries, nowMs);
	const degraded = quota.code !== 0;
	const resetInMin = quota.expiry
		? Math.max(0, Math.round((quota.expiry - nowMs) / 60000))
		: null;
	const queued = live
		.filter(isZaiHeavy)
		.map((e) => ({
			id: e.id,
			label: e.label ?? "",
			retryAfterMinutes: resetInMin,
		}));
	const keep = live
		.filter((e) => !isZaiHeavy(e))
		.map((e) => {
			const r = suggestLocalRoute(e.label ?? "");
			return {
				id: e.id,
				label: e.label ?? "",
				route: `${r.role} @ ${r.endpoint}`,
			};
		});
	return {
		verdict:
			quota.code === 1 ? "near-cliff" : quota.code === 2 ? "blackout" : "safe",
		degraded,
		resetAt: quota.expiry ? new Date(quota.expiry).toISOString() : null,
		resetInMinutes: resetInMin,
		generatedAt: new Date(nowMs).toISOString(),
		localStack: { ...LOCAL_STACK },
		keepOnLocal: degraded ? keep : [],
		queuedBehindReset: degraded ? queued : [],
		admissionRules: [
			"local-first: default to the local stack; remote z.ai only for >32k context or frontier quality (docs/llm-routing.md)",
			`z.ai-heavy cap ${ZAI_HEAVY_CAP} concurrent lanes (progress id/label mentions z.ai; ${PROGRESS_TTL_MS / 60000}-min TTL)`,
			"shared cooldown fact zai.cooldown.until — a 429 from any lane cools ALL lanes until it expires",
			"on deny: park behind the reset (honor retry-after) or degrade to local; never hard-fail a lane",
		],
	};
}

export function readProgressEntries(dir = PROGRESS_DIR): ProgressEntry[] {
	const out: ProgressEntry[] = [];
	try {
		for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
			try {
				const j = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
				if (typeof j?.at === "number") {
					out.push({
						id: f.replace(/\.json$/, ""),
						at: j.at,
						done: j.done ?? 0,
						total: j.total ?? 0,
						label: j.label,
						etaSeconds: j.etaSeconds,
					});
				}
			} catch {}
		}
	} catch {} // missing dir → no live lanes
	return out;
}

export function getCooldownFact(dbPath = DB_PATH): string | null {
	const db = new Database(dbPath); // plain open (WAL), read-only use
	try {
		const r = db
			.query("SELECT value FROM facts WHERE key = ?")
			.get(FACT_KEY) as { value: string } | null;
		return r?.value ?? null;
	} finally {
		db.close();
	}
}

export function setCooldownFact(
	dbPath: string,
	untilMs: number,
	source: string,
): void {
	const db = new Database(dbPath);
	try {
		// same upsert convention as coord.ts fact set
		db.query(
			"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, ?, 1, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, version = version + 1, ts = excluded.ts",
		).run(FACT_KEY, String(untilMs), source, Date.now());
	} finally {
		db.close();
	}
}

export function clearCooldownFact(dbPath: string): void {
	const db = new Database(dbPath);
	try {
		db.query("DELETE FROM facts WHERE key = ?").run(FACT_KEY);
	} catch {}
	db.close();
}

function usage(): never {
	console.log(
		"admission — z.ai-heavy admission control. check | dispatch-check | degradation-status | cooldown",
	);
	process.exit(2);
}

function arg(name: string, argv: string[]): string | undefined {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}

// [main-block]

if (import.meta.main) {
	const cmd = process.argv[2];
	const as = arg("--as", process.argv) ?? "unknown";
	try {
		if (cmd === "check") {
			if (arg("--kind", process.argv) !== "zai-heavy") {
				console.log("admission: UNKNOWN — unsupported --kind (only zai-heavy)");
				process.exit(2);
			}
			let cdVal: string | null = null;
			let dbError = false;
			try {
				cdVal = getCooldownFact();
			} catch {
				dbError = true;
			}
			const v = admissionVerdict({
				nowMs: Date.now(),
				cooldownValue: cdVal,
				dbError,
				entries: readProgressEntries(),
			});
			for (const l of v.lines) console.log(l);
			process.exit(v.exit);
		}
		if (cmd === "dispatch-check") {
			// --project accepted but ignored: cap + cooldown are fleet-global
			void arg("--project", process.argv);
			const qv = quotaWindowVerdict();
			let cdVal: string | null = null;
			let dbError = false;
			try {
				cdVal = getCooldownFact();
			} catch {
				dbError = true;
			}
			const av = admissionVerdict({
				nowMs: Date.now(),
				cooldownValue: cdVal,
				dbError,
				entries: readProgressEntries(),
			});
			const dv = dispatchVerdict(qv, av);
			for (const l of dv.lines) console.log(l);
			process.exit(dv.exit);
		}
		if (cmd === "degradation-status") {
			const qv = quotaWindowVerdict();
			const plan = buildDegradationPlan(qv, readProgressEntries(), Date.now());
			console.log(JSON.stringify(plan, null, 2));
			process.exit(
				plan.verdict === "safe" ? 0 : plan.verdict === "near-cliff" ? 1 : 2,
			);
		}
		if (cmd === "cooldown") {
			const nowMs = Date.now();
			if (process.argv.includes("--clear")) {
				try {
					clearCooldownFact(DB_PATH);
					console.log("cooldown: cleared zai.cooldown.until");
					process.exit(0);
				} catch (e) {
					console.log(`cooldown: clear failed — ${(e as Error).message}`);
					process.exit(2);
				}
			}
			const untilRaw = arg("--until", process.argv);
			const retryAfter = arg("--retry-after", process.argv);
			if (untilRaw === undefined && retryAfter === undefined) usage();
			let existingMs: number | null = null;
			try {
				const cd = cooldownVerdict(getCooldownFact(), nowMs);
				if (cd.active) existingMs = cd.untilMs;
			} catch {}
			const proposed =
				retryAfter !== undefined
					? nowMs +
						Number(retryAfter) * 1000 +
						Math.floor(Math.random() * JITTER_MS)
					: parseUntilMs(untilRaw!);
			if (!Number.isFinite(proposed)) usage();
			const finalMs = mergeCooldown(existingMs, proposed, nowMs);
			setCooldownFact(DB_PATH, finalMs, `admission:${as}`);
			const jitterNote =
				retryAfter !== undefined ? ", includes herd jitter" : "";
			const keptNote =
				finalMs !== proposed ? ", existing longer cooldown kept" : "";
			console.log(
				`cooldown: zai.cooldown.until = ${new Date(finalMs).toISOString()} (source admission:${as}${jitterNote}${keptNote})`,
			);
			process.exit(0);
		}
		usage();
	} catch (e) {
		console.log(`admission: UNKNOWN — ${(e as Error).message}`);
		process.exit(2);
	}
}
