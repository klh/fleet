// hooks/lib/runaway.ts — W830: the runaway-guard breaker logic. Pure and
// unit-testable; the gate (gates/runaway.ts) owns IO and verdicts. Three
// breakers read the session transcript before each call: same-tool
// same-args repeat, consecutive tool failures, and a session dollar cap
// (transcript usage × operator rates — the stack has no hardcoded pricing,
// so rates ride SUSPENDERS_RUNAWAY_USD_RATES and cap 0 disables the
// dollar breaker). Advisory law: every read/state failure fails OPEN —
// a lost counter or unreadable transcript never blocks a healthy call.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import {
	readSessionState,
	sessionStatePath,
	writeSessionState,
} from "./session-state.ts";
import { isNoise } from "./tool-failures.ts";

export type RunawayConfig = {
	disabled: boolean;
	repeatMax: number;
	failStreak: number;
	usdCap: number;
	rates: Rates;
	tailBytes: number;
	scanCapBytes: number;
};

export type RateRow = {
	in?: number;
	out?: number;
	cacheR?: number;
	cacheC?: number;
};
export type Rates = Record<string, RateRow>;

// per-lane thresholds: machine config or the 0600 lane --settings env pin
export function runawayConfig(
	env: Record<string, string | undefined> = process.env,
): RunawayConfig {
	const num = (key: string, d: number): number => {
		const raw = env[key];
		if (raw === undefined || raw === "") return d;
		const v = Number(raw);
		return Number.isFinite(v) ? v : d;
	};
	return {
		disabled: env.SUSPENDERS_RUNAWAY === "0",
		repeatMax: Math.max(1, num("SUSPENDERS_RUNAWAY_REPEAT_MAX", 3)),
		failStreak: Math.max(1, num("SUSPENDERS_RUNAWAY_FAIL_STREAK", 6)),
		usdCap: Math.max(0, num("SUSPENDERS_RUNAWAY_USD_CAP", 0)),
		rates: parseRates(env.SUSPENDERS_RUNAWAY_USD_RATES),
		tailBytes: Math.max(1024, num("SUSPENDERS_RUNAWAY_TAIL_BYTES", 65_536)),
		scanCapBytes: Math.max(
			65_536,
			num("SUSPENDERS_RUNAWAY_SCAN_CAP_BYTES", 16_777_216),
		),
	};
}

// `{"<model-prefix>": {"in":…,"out":…,"cacheR":…,"cacheC":…}, "*": {…}}` —
// USD per million tokens, longest prefix wins, "*" is the fallback tier
export function parseRates(raw: string | undefined): Rates {
	try {
		const v = raw ? JSON.parse(raw) : {};
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Rates) : {};
	} catch {
		return {};
	}
}

export function rateRowFor(model: string, rates: Rates): RateRow | null {
	let best: string | null = null;
	for (const k of Object.keys(rates)) {
		if (k === "*") continue;
		if (model.startsWith(k) && (best === null || k.length > best.length))
			best = k;
	}
	if (best) return rates[best] ?? null;
	return rates["*"] ?? null;
}

// canonical args key: key-order invariant, capped like failKey
export function stableKey(input: unknown): string {
	return stableStringify(input).slice(0, 200);
}

function stableStringify(v: unknown): string {
	if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
	if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
	const o = v as Record<string, unknown>;
	const keys = Object.keys(o).sort();
	return `{${keys
		.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
		.join(",")}}`;
}

// ---- tail scan: repeats + consecutive failures in the recent window ----

export type TailVerdict = { repeats: number; failStreak: number };

// text is a bounded transcript tail (transcriptTail) — the first line may be
// partial and is dropped. repeats counts PAST calls identical to the pending
// one; failStreak counts trailing consecutive is_error results (noise
// classes are transparent: neither counted nor streak-breaking).
export function scanTail(
	text: string,
	tool: string,
	inputKey: string,
): TailVerdict {
	const key = `${tool}:${inputKey}`;
	const pending = new Map<string, string>(); // tool_use id → bash command
	const results: { err: boolean; cmd: string | undefined; text: string }[] = [];
	let repeats = 0;
	// every line parses on its own: a tail-starting partial line just fails
	// JSON.parse and is skipped, complete lines always count
	for (const line of text.split("\n")) {
		if (!line) continue;
		let row: {
			type?: string;
			message?: {
				content?: {
					type?: string;
					id?: string;
					name?: string;
					input?: unknown;
					tool_use_id?: string;
					is_error?: boolean;
					content?: unknown;
				}[];
			};
		} | null = null;
		try {
			row = JSON.parse(line) as typeof row;
		} catch {
			continue;
		}
		const content = row?.message?.content;
		if (!Array.isArray(content)) continue;
		if (row?.type === "assistant") {
			for (const c of content) {
				if (c?.type !== "tool_use") continue;
				if (`${c.name}:${stableKey(c.input)}` === key) repeats++;
				if (
					c.input &&
					typeof c.input === "object" &&
					typeof (c.input as { command?: unknown }).command === "string"
				)
					pending.set(c.id ?? "", (c.input as { command: string }).command);
			}
		} else if (row?.type === "user") {
			for (const c of content) {
				if (c?.type !== "tool_result") continue;
				const t =
					typeof c.content === "string"
						? c.content
						: JSON.stringify(c.content ?? "");
				results.push({
					err: c.is_error === true,
					cmd: pending.get(c.tool_use_id ?? ""),
					text: t.slice(0, 300),
				});
			}
		}
	}
	let streak = 0;
	for (let i = results.length - 1; i >= 0; i--) {
		const r = results[i];
		if (!r?.err) break;
		if (isNoise(r.cmd, r.text)) continue;
		streak++;
	}
	return { repeats, failStreak: streak };
}

// ---- incremental usage scan: the dollar breaker's evidence ----

export type UsageState = {
	offset: number;
	costUsd: number;
	in: number;
	out: number;
	cacheR: number;
	cacheC: number;
};

export const zeroUsage = (): UsageState => ({
	offset: 0,
	costUsd: 0,
	in: 0,
	out: 0,
	cacheR: 0,
	cacheC: 0,
});

export function usageStatePath(sid: string): string {
	return sessionStatePath("runaway-usage", sid);
}

export function readUsageState(sid: string): UsageState {
	return readSessionState<UsageState>(usageStatePath(sid)) ?? zeroUsage();
}

export function writeUsageState(sid: string, st: UsageState): boolean {
	return writeSessionState(usageStatePath(sid), st);
}

// Reads only the bytes past st.offset (state dies with the session, tmp) —
// each PreToolUse call costs one bounded read, never a whole-file scan.
// Truncation restarts bounded (scanCap); a delta beyond the cap skips the
// oldest history (fail open: undercount, never block). Per-row costUSD is
// honored when present, else tokens × rates for the row's model. A read
// failure returns prev unchanged — never advances, never blocks.
export function readUsageDelta(
	path: string,
	prev: UsageState,
	rates: Rates,
	scanCap = 16_777_216,
): UsageState {
	let fd: number | null = null;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		const st: UsageState = { ...prev };
		if (size < st.offset) st.offset = Math.max(0, size - scanCap);
		if (size - st.offset > scanCap) st.offset = size - scanCap;
		const len = size - st.offset;
		if (len <= 0) return st;
		const buf = Buffer.alloc(len);
		readSync(fd, buf, 0, len, st.offset);
		const text = buf.toString("utf8");
		const lastNl = text.lastIndexOf("\n");
		if (lastNl < 0) return st; // no complete line yet
		// offset always lands on a line boundary; a mid-line start (size -
		// scanCap) yields a partial first line that fails JSON.parse harmlessly
		for (const line of text.slice(0, lastNl).split("\n")) {
			if (!line.includes('"type":"assistant"')) continue;
			let row: {
				costUSD?: unknown;
				message?: {
					model?: unknown;
					usage?: Record<string, unknown>;
				};
			} | null = null;
			try {
				row = JSON.parse(line) as typeof row;
			} catch {
				continue;
			}
			if (row?.type !== "assistant") continue;
			const n = (x: unknown): number =>
				typeof x === "number" && Number.isFinite(x) ? x : 0;
			const u = row.message?.usage;
			const i = n(u?.input_tokens);
			const o = n(u?.output_tokens);
			const cr = n(u?.cache_read_input_tokens);
			const cc = n(u?.cache_creation_input_tokens);
			st.in += i;
			st.out += o;
			st.cacheR += cr;
			st.cacheC += cc;
			if (typeof row.costUSD === "number" && Number.isFinite(row.costUSD)) {
				st.costUsd += row.costUSD; // transcript-priced row: authoritative
				continue;
			}
			const r = rateRowFor(String(row.message?.model ?? ""), rates);
			if (!r) continue;
			st.costUsd +=
				(i * (r.in ?? 0) +
					o * (r.out ?? 0) +
					cr * (r.cacheR ?? 0) +
					cc * (r.cacheC ?? 0)) /
				1e6;
		}
		st.offset += lastNl + 1;
		return st;
	} catch {
		return prev;
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

// node:fs read face lives in the gate — this module stays pure-testable
