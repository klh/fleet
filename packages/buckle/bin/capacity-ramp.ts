// bin/capacity-ramp.ts — reusable opt-in capacity benchmark (W1266). Never
// runs without KLH_CODING_PLAN_E2E=1; keys are read from --key-env or the
// raw --key-file and printed only as a sha256 fingerprint. Ramps concurrent
// requests per configured leg (preset "coding-plan" = the three official
// Z.ai Coding Plan endpoints; --legs name=protocol@base adds any other
// endpoint), records unique sockets, peak accepted streams, peak ACTIVELY
// PRODUCING streams (absolute wall-clock second per parsed model delta,
// #69068), per-level attempted/2xx/terminal-completed/provider-429/1302/
// HTTP200-response.failed/local-refusal/throughput counters (#69069), and
// per-hop /v1/admin/slots before/after each level (#69070). Buckle legs
// ride a minted scoped key, revoked at the end. Secrets and prompts are
// never printed; long-work prompts are synthetic exercises with a marker.
//
// usage:
//   KLH_CODING_PLAN_E2E=1 bun packages/buckle/bin/capacity-ramp.ts \
//     [--preset coding-plan] [--legs n=protocol@base,...] \
//     [--levels 8,16,24,32,40,50] [--gap-ms 200] [--model glm-5.3-flash] \
//     [--work long|short] [--key-file ~/.claude/local-llm/zai.key] \
//     [--key-env ZAI_CODING_PLAN_KEY] [--admin-env BUCKLE_ADMIN_KEY] \
//     [--buckle http://127.0.0.1:4101] [--admin-hops <spoke>,<hub>] \
//     [--out /tmp/w1266-capacity-<ts>.jsonl]
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import https from "node:https";
import http from "node:http";

interface Args {
	levels: number[];
	gapMs: number;
	/** bounded output budget per job (1..16384; owner steer 2026-10-24) */
	maxTokens: number;
	model: string;
	buckle: string | null;
	adminEnv: string;
	keyEnv: string;
	keyFile: string;
	adminHops: string;
	preset: string;
	legs: string;
	work: boolean;
	out: string | null;
}

interface Row {
	leg: string;
	protocol: "anthropic" | "chat" | "responses";
	target: string;
	level: number;
	seq: number;
	/** absolute epoch ms the request was fired (timeline reconstruction) */
	startedAt: number;
	socketPort: number | null;
	tHeadersMs: number | null;
	tEndMs: number | null;
	status: number | null;
	retryAfter: string | null;
	errCode: string | null;
	errType: string | null;
	errMsg: string | null;
	sseTerminals: string[];
	// long-work validation (W1266 owner steer 2026-10-24): a distinct coding
	// work item per request, streamed, with a marker to find in the output.
	marker: string | null;
	markerOk: boolean;
	textBytes: number;
	reasonBytes: number;
	chunks: number;
	genFirstMs: number | null;
	genLastMs: number | null;
	terminal: string | null;
	finishReason: string | null;
}

const OFFICIAL = {
	anthropic: "https://api.z.ai/api/anthropic",
	chat: "https://api.z.ai/api/coding/paas/v4",
	responses: "https://api.z.ai/api/v1",
} as const;

const USAGE = `refusing: set KLH_CODING_PLAN_E2E=1 to opt in to live Coding Plan traffic`;

// --- helpers ------------------------------------------------------------
const argOf = (argv: string[], flag: string): string | null => {
	const i = argv.indexOf(flag);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};

/** sha256 prefix — provenance without disclosure. */
const fingerprint = (key: string): string =>
	createHash("sha256").update(key).digest("hex").slice(0, 10);

/** Key sourcing: --key-env NAME first, else the RAW machine key file
 *  (--key-file, default ~/.claude/local-llm/zai.key, mode 0600). No env-file
 *  scanning: a standard Z.ai API key must never be mistaken for the Coding
 *  Plan key. The value is never printed — fingerprint only. */
function loadKey(args: Args): string {
	const fromEnv = process.env[args.keyEnv];
	if (fromEnv !== undefined && fromEnv.length > 20) {
		console.error(`key: env:${args.keyEnv} fp:${fingerprint(fromEnv)}`);
		return fromEnv;
	}
	const path = args.keyFile.replace(/^~/, process.env.HOME ?? "");
	const raw = readFileSync(path, "utf8").trim();
	if (raw.length < 20)
		throw new Error(`no Coding Plan key at ${path} (${args.keyEnv} unset)`);
	console.error(`key: ${path} fp:${fingerprint(raw)}`);
	return raw;
}

const loadAdmin = (args: Args): string | null =>
	process.env[args.adminEnv] ?? null;

void USAGE;

// --- per-protocol request build ------------------------------------------
type Protocol = "anthropic" | "chat" | "responses";

const pathOf = (protocol: Protocol): string =>
	protocol === "anthropic"
		? "/v1/messages"
		: protocol === "chat"
			? "/chat/completions"
			: "/responses";

/** Exact request URL for one leg: RETAINS the base's pathname prefix.
 *  new URL("/v1/messages", "https://api.z.ai/api/anthropic") resolves to
 *  https://api.z.ai/v1/messages — the leading slash discards /api/anthropic
 *  and every direct Coding Plan request 404s (live 2026-10-24).
 *  hop=true for buckle legs: the gate exposes /v1/chat/completions and
 *  /v1/responses (handlers.ts), while the direct Z.ai bases already carry
 *  their prefix (/api/coding/paas/v4, /api/v1) — bare suffix there. */
export const endpointOf = (
	base: string,
	protocol: Protocol,
	hop = false,
): URL => {
	const url = new URL(base);
	const suffix = pathOf(protocol);
	const path = hop && !suffix.startsWith("/v1") ? `/v1${suffix}` : suffix;
	url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
	return url;
};

const headersOf = (protocol: Protocol, key: string): Record<string, string> =>
	protocol === "anthropic"
		? {
				"content-type": "application/json",
				"x-api-key": key,
				"anthropic-version": "2023-06-01",
			}
		: { "content-type": "application/json", authorization: `Bearer ${key}` };

// --- concurrency accounting ----------------------------------------------
interface Live {
	open: number;
	peakSockets: number;
	accepted: number;
	peakAccepted: number;
	// owner #69068: absolute wall-clock second → set of request seqs that
	// produced a parsed model delta in that second; peak = max Set.size.
	deltaSecs: Map<number, Set<number>>;
}

const errOf = (text: string): Pick<Row, "errCode" | "errType" | "errMsg"> => {
	try {
		const j = JSON.parse(text) as {
			error?: Record<string, unknown>;
			code?: unknown;
			type?: unknown;
			message?: unknown;
		};
		// provider shape nests under error; problem+json (buckle) is top-level
		const s: Record<string, unknown> = j.error ?? j;
		return {
			errCode: typeof s.code === "string" ? s.code : null,
			errType: typeof s.type === "string" ? s.type : null,
			errMsg: typeof s.message === "string" ? s.message.slice(0, 120) : null,
		};
	} catch {
		return { errCode: null, errType: null, errMsg: null };
	}
};

interface FireOpts {
	mod: typeof https | typeof http;
	base: string;
	leg: string;
	protocol: Protocol;
	hop: boolean;
	key: string;
	model: string;
	maxTokens: number;
	maxOutputTokens: number;
	level: number;
	seq: number;
	work: boolean;
	live: Live;
	maxSockets: number;
}

const rowOf = (
	r: Omit<
		Row,
		"retryAfter" | "errCode" | "errType" | "errMsg" | "sseTerminals"
	> &
		Partial<Row>,
): Row => ({
	retryAfter: null,
	errCode: null,
	errType: null,
	errMsg: null,
	sseTerminals: [],
	marker: null,
	markerOk: false,
	textBytes: 0,
	reasonBytes: 0,
	chunks: 0,
	genFirstMs: null,
	genLastMs: null,
	terminal: null,
	finishReason: null,
	...r,
});

// --- long-work mode (owner steer 2026-10-24) ------------------------------
// A distinct bounded coding task per request; the answer must stream, carry
// the unique MARKER-<seq> token, and reach a protocol terminal.
const WORK_MIN_BYTES = 2_000;
/** Sustained-output work prompt (owner steer 2026-10-24): the marker rides
 *  the FIRST line (survives textSample truncation) and the deliverable is
 *  explicitly exhaustive so jobs sustain minutes, not ~17s — paced ramps
 *  must be able to hold 40-50 CONCURRENT productive streams. */
const workPrompt = (seq: number): string =>
	`Work item MARKER-${seq}. The very first line of your reply must be ` +
	`exactly MARKER-${seq}. Then implement exercise index ${seq % 30} from ` +
	`the list [fizzbuzz-variant, prime-sieve, gcd-chain, quicksort, ` +
	`bst-insert, word-frequency, roman-numerals, matrix-rotate, ` +
	`binary-search, anagram-group, rle-encode, caesar-cipher, hanoi-steps, ` +
	`pig-latin, slope-validate, trie-prefix, kth-largest, dedupe-stream, ` +
	`stock-profit, rotate-array, ip-validate, csv-parse, json-flatten, ` +
	`lru-cache, bracket-balance, pascal-triangle, string-compress, ` +
	`vowel-count, digit-sum, memo-fib] exhaustively in TypeScript: full ` +
	`implementation, 3 test cases with expected outputs, a line-by-line ` +
	`complexity walkthrough, a table of at least 8 edge cases, and a ` +
	`refactor discussion. Repeat the literal token MARKER-${seq} in every ` +
	`section header. Be exhaustive and detailed; do not summarize.`;

/** Parsed generation stats — counted from PARSED deltas only (owner #69067):
 *  raw SSE envelope bytes are not model output. */
interface GenStats {
	nChunks: number;
	textBytes: number;
	reasonBytes: number;
	genFirstMs: number | null;
	genLastMs: number | null;
	textSample: string;
	/** reasoning sample: marker may ride reasoning when text is thin */
	reasonSample: string;
}

/** Generated text/reasoning parsed out of one SSE data payload (#69067). */
function deltaPieces(
	protocol: Protocol,
	payload: string,
): { text: string; reason: string } {
	let text = "";
	let reason = "";
	try {
		const j = JSON.parse(payload) as Record<string, unknown>;
		const kind = j.type;
		const d = j.delta;
		if (protocol === "responses") {
			if (kind === "response.output_text.delta" && typeof d === "string")
				text = d;
			if (kind === "response.reasoning_text.delta" && typeof d === "string")
				reason = d;
		} else if (protocol === "anthropic") {
			if (kind === "content_block_delta") {
				const b = d as Record<string, unknown> | undefined;
				if (b !== undefined) {
					if (typeof b.text === "string") text = b.text;
					if (typeof b.thinking === "string") reason = b.thinking;
				}
			}
		} else if (protocol === "chat") {
			const choices = j.choices as
				| { delta?: { content?: unknown; reasoning_content?: unknown } }[]
				| undefined;
			const first = choices !== undefined ? choices[0] : undefined;
			const c = first !== undefined ? first.delta : undefined;
			if (c !== undefined) {
				if (typeof c.content === "string") text = c.content;
				if (typeof c.reasoning_content === "string")
					reason = c.reasoning_content;
			}
		}
	} catch {
		// non-JSON data lines carry no model deltas
	}
	return { text, reason };
}

/** Response phase: accepted-stream accounting (2xx headers until body end). */
function onResponse(
	opts: FireOpts,
	res: http.IncomingMessage,
	resolve: (row: Row) => void,
	t0: number,
): void {
	const tHeaders = Date.now() - t0;
	const port = res.socket?.localPort ?? null;
	const status = res.statusCode ?? 0;
	let accepted = false;
	if (status > 0 && status < 400) {
		accepted = true;
		opts.live.accepted++;
		opts.live.peakAccepted = Math.max(
			opts.live.peakAccepted,
			opts.live.accepted,
		);
	}
	const raw: Buffer[] = [];
	let nChunks = 0;
	let lineBuf = "";
	const stats: GenStats = {
		nChunks: 0,
		textBytes: 0,
		reasonBytes: 0,
		genFirstMs: null,
		genLastMs: null,
		textSample: "",
		reasonSample: "",
	};
	const record = (text: string, reason: string): void => {
		if (text.length === 0 && reason.length === 0) return;
		const now = Date.now();
		if (stats.genFirstMs === null) stats.genFirstMs = now - t0;
		stats.genLastMs = now - t0;
		stats.textBytes += Buffer.byteLength(text);
		stats.reasonBytes += Buffer.byteLength(reason);
		if (stats.textSample.length < 16_384) stats.textSample += text;
		if (stats.reasonSample.length < 16_384) stats.reasonSample += reason;
		const sec = Math.floor(now / 1000);
		const set = opts.live.deltaSecs.get(sec) ?? new Set<number>();
		set.add(opts.seq);
		opts.live.deltaSecs.set(sec, set);
	};
	res.on("data", (c: Buffer) => {
		raw.push(c);
		nChunks++;
		lineBuf += c.toString("utf8");
		let nl = lineBuf.indexOf("\n");
		while (nl >= 0) {
			const line = lineBuf.slice(0, nl).trim();
			lineBuf = lineBuf.slice(nl + 1);
			if (line.startsWith("data:")) {
				const payload = line.slice(5).trim();
				if (payload !== "" && payload !== "[DONE]") {
					const p = deltaPieces(opts.protocol, payload);
					record(p.text, p.reason);
				}
			}
			nl = lineBuf.indexOf("\n");
		}
	});
	res.on("end", () => {
		if (accepted) opts.live.accepted--;
		stats.nChunks = nChunks;
		resolve(
			rowFor(
				opts,
				t0,
				tHeaders,
				port,
				status,
				Buffer.concat(raw).toString("utf8"),
				stats,
			),
		);
	});
}

/** Verdict extraction: SSE terminal events beat status (live 2026-10-24:
 *  Responses refusals ride HTTP 200 inside response.failed). */
function rowFor(
	opts: FireOpts,
	t0: number,
	tHeadersMs: number | null,
	port: number | null,
	status: number,
	text: string,
	stats: {
		nChunks: number;
		textBytes: number;
		reasonBytes: number;
		genFirstMs: number | null;
		genLastMs: number | null;
		textSample: string;
		reasonSample: string;
	},
): Row {
	// Terminal frames ride the stream TAIL (live probe 2026-10-24: a 17s
	// thinking stream exceeds 64KB raw, so a clipped scan read terminal=null
	// on every row); scan the FULL body, keep error JSON on the head clip.
	const clipped = text.slice(0, 65_536);
	const terminals = [
		...text.matchAll(/"type":"((?:response|message|content_block)[._]\w+)"/g),
	].map((m) => m[1]);
	const stop =
		/"finish_reason":"(\w+)"/.exec(text)?.[1] ??
		/"stop_reason":"(\w+)"/.exec(text)?.[1] ??
		null;
	const terminal =
		terminals.find((t) => t === "response.completed") ??
		terminals.find((t) => t === "response.failed") ??
		terminals.find((t) => t === "response.incomplete") ??
		(text.includes("message_stop") ? "message_stop" : null) ??
		(text.includes("[DONE]") ? "chat_done" : null);
	return rowOf({
		leg: opts.leg,
		protocol: opts.protocol,
		target: opts.base,
		level: opts.level,
		seq: opts.seq,
		startedAt: t0,
		socketPort: port,
		tHeadersMs,
		tEndMs: Date.now() - t0,
		status,
		marker: opts.work ? `MARKER-${opts.seq}` : null,
		markerOk:
			opts.work &&
			(stats.textSample.includes(`MARKER-${opts.seq}`) ||
				stats.reasonSample.includes(`MARKER-${opts.seq}`)),
		textBytes: stats.textBytes,
		reasonBytes: stats.reasonBytes,
		chunks: stats.nChunks,
		genFirstMs: stats.genFirstMs,
		genLastMs: stats.genLastMs,
		terminal,
		finishReason: stop,
		...(terminals.length > 0 ? { sseTerminals: terminals } : errOf(clipped)),
	});
}

const errorRow = (opts: FireOpts, t0: number): Row =>
	rowOf({
		leg: opts.leg,
		protocol: opts.protocol,
		target: opts.base,
		level: opts.level,
		seq: opts.seq,
		startedAt: t0,
		socketPort: null,
		tHeadersMs: null,
		tEndMs: Date.now() - t0,
		status: null,
		errCode: "transport_error",
	});

/** One genuinely concurrent request over its own socket (keepAlive=false,
 *  maxSockets=level) — the owner-verified Node agent method. */
function fireRequest(opts: FireOpts): Promise<Row> {
	const url = endpointOf(opts.base, opts.protocol, opts.hop);
	const body = bodyOf(
		opts.protocol,
		opts.model,
		opts.maxTokens,
		opts.maxOutputTokens,
		opts.work,
		opts.seq,
	);
	return new Promise<Row>((resolve) => {
		const t0 = Date.now();
		const req = opts.mod.request(
			url,
			{
				method: "POST",
				headers: headersOf(opts.protocol, opts.key),
				agent: new opts.mod.Agent({
					keepAlive: false,
					maxSockets: opts.maxSockets,
				}),
			},
			(res) => onResponse(opts, res, resolve, t0),
		);
		req.on("socket", (s) => {
			opts.live.open++;
			opts.live.peakSockets = Math.max(opts.live.peakSockets, opts.live.open);
			s.on("close", () => {
				opts.live.open--;
			});
		});
		req.setTimeout(opts.work ? 120_000 : 30_000, () => {
			req.destroy();
			resolve(errorRow(opts, t0));
		});
		req.on("error", () => resolve(errorRow(opts, t0)));
		req.end(body);
	});
}

interface LevelOpts {
	leg: string;
	protocol: Protocol;
	hop: boolean;
	base: string;
	key: string;
	model: string;
	maxTokens: number;
	maxOutputTokens: number;
	work: boolean;
	level: number;
	gapMs: number;
}

async function runLevel(opts: LevelOpts): Promise<{ rows: Row[]; live: Live }> {
	const live: Live = {
		open: 0,
		peakSockets: 0,
		accepted: 0,
		peakAccepted: 0,
		deltaSecs: new Map(),
	};
	const mod = opts.base.startsWith("https") ? https : http;
	const fires: Promise<Row>[] = [];
	for (let seq = 0; seq < opts.level; seq++) {
		fires.push(
			fireRequest({ ...opts, mod, seq, live, maxSockets: opts.level }),
		);
		if (opts.gapMs > 0) await Bun.sleep(opts.gapMs);
	}
	return { rows: await Promise.all(fires), live };
}

/** Owner #69068: peak DISTINCT requests producing parsed model deltas in one
 *  absolute wall-clock second. Per-request-relative buckets cannot establish
 *  global overlap, and bucket-fill counts stalled streams — neither here. */
function producingPeak(live: Live): number {
	let peak = 0;
	for (const set of live.deltaSecs.values()) peak = Math.max(peak, set.size);
	return peak;
}

const bodyOf = (
	protocol: Protocol,
	model: string,
	maxTokens: number,
	maxOutputTokens: number,
	work: boolean,
	seq: number,
): string => {
	const prompt = work ? workPrompt(seq) : "ping";
	const stream = work || protocol === "responses";
	if (protocol === "responses")
		return JSON.stringify({
			model,
			max_output_tokens: maxOutputTokens,
			input: prompt,
			stream,
		});
	if (protocol === "anthropic")
		return JSON.stringify({
			model,
			max_tokens: maxTokens,
			stream,
			messages: [{ role: "user", content: prompt }],
		});
	return JSON.stringify({
		model,
		max_tokens: maxTokens,
		stream,
		messages: [{ role: "user", content: prompt }],
	});
};

// --- level telemetry (#69069/#69070) --------------------------------------

interface HopSnap {
	hop: string;
	before: unknown;
	after: unknown;
}

/** Pool snapshot from one Buckle hop's admin surface. Each hop carries its
 *  OWN credential env NAME (spoke vs hub keys differ — live 2026-10-24 the
 *  hub 401'd the spoke admin). A missing/failed snapshot is recorded as
 *  explicitly unavailable, never silently counted (owner steer #69168);
 *  the token value itself is never printed or persisted. */
const fetchSlots = async (
	base: string,
	admin: string | null,
	envName: string,
): Promise<unknown> => {
	if (admin === null || admin.length === 0)
		return { unavailable: `admin env ${envName} unset — hop count not taken` };
	try {
		const r = await fetch(`${base}/v1/admin/slots`, {
			headers: { authorization: `Bearer ${admin}` },
		});
		if (!r.ok) return { error: `status ${r.status}` };
		return await r.json();
	} catch (e) {
		return { error: String(e).slice(0, 120) };
	}
};

/** One --admin-hops entry: url or url@ENV_NAME (default: --admin-env). */
const hopSpecOf = (
	spec: string,
	defaultEnv: string,
): { base: string; env: string } => {
	const at = spec.lastIndexOf("@");
	return at > 0
		? { base: spec.slice(0, at), env: spec.slice(at + 1) }
		: { base: spec, env: defaultEnv };
};

const slotOf = async (hop: { base: string; env: string }): Promise<unknown> =>
	fetchSlots(hop.base, process.env[hop.env] ?? null, hop.env);

const appendJsonl = (path: string, obj: unknown): void => {
	appendFileSync(path, `${JSON.stringify(obj)}\n`);
};

const pctOf = (sorted: number[], p: number): number | null => {
	if (sorted.length === 0) return null;
	const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[i];
};

/** Per-level verdict (#69069): count EVERYTHING happening during the test.
 *  2xx without a protocol terminal is NEVER success. */
interface LevelSummary {
	leg: string;
	protocol: Protocol;
	level: number;
	gapMs: number;
	wallMs: number;
	attempted: number;
	accepted2xx: number;
	terminalCompleted: number;
	http200Failed: number;
	provider429: number;
	code1302: number;
	entitlement1311: number;
	localRefused: number;
	transportError: number;
	uniqueSockets: number;
	peakSockets: number;
	peakAccepted: number;
	peakProducing: number;
	markerOk: number;
	substantive: number;
	textBytesTotal: number;
	throughputBps: number;
	genP50Ms: number | null;
	genP95Ms: number | null;
	hops: HopSnap[];
}

function summarize(
	leg: string,
	protocol: Protocol,
	level: number,
	gapMs: number,
	rows: Row[],
	live: Live,
	wallMs: number,
	hops: HopSnap[],
): LevelSummary {
	const gen = rows
		.filter((r) => r.genLastMs !== null)
		.map((r) => r.genLastMs as number)
		.sort((a, b) => a - b);
	const textBytes = rows.reduce((a, r) => a + r.textBytes, 0);
	const count = (f: (r: Row) => boolean): number => rows.filter(f).length;
	return {
		leg,
		protocol,
		level,
		gapMs,
		wallMs,
		attempted: rows.length,
		accepted2xx: count(
			(r) => r.status !== null && r.status >= 200 && r.status < 300,
		),
		terminalCompleted: count(
			(r) => r.terminal !== null && r.terminal !== "response.failed",
		),
		http200Failed: count(
			(r) => r.status === 200 && r.terminal === "response.failed",
		),
		provider429: count((r) => r.status === 429 && r.errCode !== null),
		code1302: count((r) => r.errCode === "1302"),
		entitlement1311: count((r) => r.errCode === "1311"),
		localRefused: count((r) => r.status === 429 && r.errCode === null),
		transportError: count((r) => r.errCode === "transport_error"),
		uniqueSockets: new Set(
			rows.map((r) => r.socketPort).filter((p) => p !== null),
		).size,
		peakSockets: live.peakSockets,
		peakAccepted: live.peakAccepted,
		peakProducing: producingPeak(live),
		markerOk: count((r) => r.markerOk),
		substantive: count((r) => r.textBytes + r.reasonBytes >= WORK_MIN_BYTES),
		textBytesTotal: textBytes,
		throughputBps: Math.round(textBytes / Math.max(1, wallMs / 1000)),
		genP50Ms: pctOf(gen, 50),
		genP95Ms: pctOf(gen, 95),
		hops,
	};
}

const renderLine = (s: LevelSummary): string =>
	`[${s.leg} L${s.level} gap${s.gapMs}] att=${s.attempted} 2xx=${s.accepted2xx} ` +
	`done=${s.terminalCompleted} f200fail=${s.http200Failed} ` +
	`429=${s.provider429} rate1302=${s.code1302} 1311=${s.entitlement1311} ` +
	`locrej=${s.localRefused} sock=${s.uniqueSockets}/${s.peakSockets} ` +
	`acc=${s.peakAccepted} prod=${s.peakProducing} mrk=${s.markerOk} ` +
	`sub=${s.substantive} tput=${s.throughputBps}B/s wall=${s.wallMs}ms`;

const reportTable = (sums: LevelSummary[]): string => {
	const head =
		"| leg | level | gap | att | 2xx | done | f200fail | 429 | 1302 | 1311 | locrej | sockU | sockPeak | acc | prod | mrk | sub | tputBps | wallMs |";
	const sep =
		"|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
	const row = (s: LevelSummary): string =>
		`| ${s.leg} | ${s.level} | ${s.gapMs} | ${s.attempted} | ${s.accepted2xx} | ${s.terminalCompleted} | ${s.http200Failed} | ${s.provider429} | ${s.code1302} | ${s.entitlement1311} | ${s.localRefused} | ${s.uniqueSockets} | ${s.peakSockets} | ${s.peakAccepted} | ${s.peakProducing} | ${s.markerOk} | ${s.substantive} | ${s.throughputBps} | ${s.wallMs} |`;
	return [head, sep, ...sums.map(row)].join("\n");
};

const LEG_SLEEP_MS = 2_000;

interface MintedKey {
	id: string;
	key: string;
}

/** Mint-response shape: the gate maps `key_id` (live 2026-10-24: parsing
 *  `id` left minted.id undefined, the revoke URL was invalid and the scoped
 *  test key stayed ACTIVE until manual revocation). */
export const mintedOf = (body: unknown): MintedKey | null => {
	// null/undefined/non-object bodies (a 404 HTML page, an empty reply)
	if (typeof body !== "object" || body === null) return null;
	const j = body as { key?: unknown; key_id?: unknown; id?: unknown };
	const id =
		typeof j.key_id === "string"
			? j.key_id
			: typeof j.id === "string"
				? j.id
				: null;
	const key = typeof j.key === "string" ? j.key : null;
	return id !== null && key !== null ? { id, key } : null;
};

const mintLaneKey = async (
	adminBase: string,
	admin: string,
): Promise<MintedKey | null> => {
	try {
		const r = await fetch(`${adminBase}/v1/admin/keys`, {
			method: "POST",
			headers: { authorization: `Bearer ${admin}` },
			body: JSON.stringify({
				name: "w1266-e2e",
				scopes: ["buckle:proxy:WRITE_"],
			}),
		});
		if (!r.ok) return null;
		return mintedOf(await r.json());
	} catch {
		return null;
	}
};

const revokeLaneKey = async (
	adminBase: string,
	admin: string,
	id: string,
): Promise<boolean> => {
	try {
		const r = await fetch(`${adminBase}/v1/admin/keys/${id}/revoke`, {
			method: "POST",
			headers: { authorization: `Bearer ${admin}` },
		});
		return r.ok;
	} catch {
		return false;
	}
};

interface LegSpec {
	leg: string;
	protocol: Protocol;
	base: string;
	hop: boolean;
}

/** Named leg sets; the official Coding Plan trio is the W1266 preset. */
const PRESETS: Record<string, LegSpec[]> = {
	"coding-plan": [
		{
			leg: "direct-anthropic",
			protocol: "anthropic",
			base: OFFICIAL.anthropic,
			hop: false,
		},
		{ leg: "direct-chat", protocol: "chat", base: OFFICIAL.chat, hop: false },
		{
			leg: "direct-responses",
			protocol: "responses",
			base: OFFICIAL.responses,
			hop: false,
		},
	],
};

/** Parse one --legs entry: name=protocol@base. */
const legSpecOf = (spec: string): LegSpec | null => {
	const eq = spec.indexOf("=");
	const at = spec.indexOf("@", eq + 1);
	if (eq <= 0 || at <= eq) return null;
	const p = spec.slice(eq + 1, at);
	if (p !== "anthropic" && p !== "chat" && p !== "responses") return null;
	return {
		leg: spec.slice(0, eq),
		protocol: p,
		base: spec.slice(at + 1),
		hop: false,
	};
};

const legSpecsOf = (preset: string, extra: string): LegSpec[] => {
	const parsed = extra
		.split(",")
		.filter((s) => s.length > 0)
		.map(legSpecOf)
		.filter((s) => s !== null);
	return [...(PRESETS[preset] ?? []), ...(parsed as LegSpec[])];
};

interface RampCtx {
	levels: number[];
	gapMs: number;
	model: string;
	maxTokens: number;
	maxOutputTokens: number;
	work: boolean;
	admin: string | null;
	hops: { base: string; env: string }[];
	out: string;
	sums: LevelSummary[];
}

/** One leg at one level: pool before-snapshot, fire, after-snapshot. */
async function runLevelOnce(
	leg: LegSpec,
	level: number,
	key: string,
	ctx: RampCtx,
): Promise<string | null> {
	const before: { hop: string; slots: unknown }[] = [];
	for (const h of ctx.hops)
		before.push({ hop: h.base, slots: await slotOf(h) });
	const wall0 = Date.now();
	const { rows, live } = await runLevel({
		leg: leg.leg,
		protocol: leg.protocol,
		base: leg.base,
		hop: leg.hop,
		key,
		model: ctx.model,
		maxTokens: ctx.maxTokens,
		maxOutputTokens: ctx.maxOutputTokens,
		work: ctx.work,
		level,
		gapMs: ctx.gapMs,
	});
	const wallMs = Date.now() - wall0;
	return verdictFor(leg, level, rows, live, wallMs, before, ctx);
}

/** After-snapshot per hop, zipped with the before values (#69070). */
const hopAfter = async (
	ctx: RampCtx,
	before: { hop: string; slots: unknown }[],
): Promise<HopSnap[]> => {
	const hops: HopSnap[] = [];
	for (let i = 0; i < ctx.hops.length; i++)
		hops.push({
			hop: ctx.hops[i].base,
			before: before[i]?.slots,
			after: await slotOf(ctx.hops[i]),
		});
	return hops;
};

/** Summarize, record, and verdict one finished level. 2xx without a
 *  protocol terminal is NEVER success (#69069). */
async function verdictFor(
	leg: LegSpec,
	level: number,
	rows: Row[],
	live: Live,
	wallMs: number,
	before: { hop: string; slots: unknown }[],
	ctx: RampCtx,
): Promise<string | null> {
	const hops = await hopAfter(ctx, before);
	const s = summarize(
		leg.leg,
		leg.protocol,
		level,
		ctx.gapMs,
		rows,
		live,
		wallMs,
		hops,
	);
	ctx.sums.push(s);
	for (const r of rows) appendJsonl(ctx.out, r);
	appendJsonl(ctx.out, { kind: "summary", ...s });
	console.error(renderLine(s));
	if (s.provider429 > 0 || s.http200Failed > 0)
		return `${leg.leg} L${level}: provider pressure (1302=${s.code1302}, http200Failed=${s.http200Failed})`;
	if (s.terminalCompleted === 0)
		return `${leg.leg} L${level}: zero successful terminals`;
	return null;
}

const rampLeg = async (
	leg: LegSpec,
	key: string,
	ctx: RampCtx,
): Promise<string | null> => {
	for (const level of ctx.levels) {
		const why = await runLevelOnce(leg, level, key, ctx);
		if (why !== null) return why;
	}
	return null;
};

const parseArgs = (argv: string[]): Args => ({
	levels: (argOf(argv, "--levels") ?? "8,16,24,32,40,50")
		.split(",")
		.map(Number)
		.filter((n) => Number.isFinite(n) && n > 0),
	gapMs: Number(argOf(argv, "--gap-ms") ?? "200"),
	maxTokens: Math.min(
		16384,
		Math.max(1, Number(argOf(argv, "--max-tokens") ?? "1024") || 1024),
	),
	model: argOf(argv, "--model") ?? "glm-5.3-flash",
	buckle: argOf(argv, "--buckle"),
	adminEnv: argOf(argv, "--admin-env") ?? "BUCKLE_ADMIN_KEY",
	keyEnv: argOf(argv, "--key-env") ?? "ZAI_CODING_PLAN_KEY",
	keyFile: argOf(argv, "--key-file") ?? "~/.claude/local-llm/zai.key",
	adminHops:
		argOf(argv, "--admin-hops") ??
		"http://127.0.0.1:4101,http://127.0.0.1:4301",
	preset: argOf(argv, "--preset") ?? "coding-plan",
	legs: argOf(argv, "--legs") ?? "",
	work: (argOf(argv, "--work") ?? "long") !== "short",
	out: argOf(argv, "--out") ?? `/tmp/w1266-capacity-${Date.now()}.jsonl`,
});

async function main(): Promise<number> {
	if (process.env.KLH_CODING_PLAN_E2E !== "1") {
		console.error(USAGE);
		return 2;
	}
	const args = parseArgs(process.argv.slice(2));
	const key = loadKey(args);
	const admin = loadAdmin(args);
	const ctx: RampCtx = {
		levels: args.levels,
		gapMs: args.gapMs,
		model: args.model,
		maxTokens: args.maxTokens,
		maxOutputTokens: args.maxTokens,
		work: args.work,
		admin,
		hops:
			admin === null
				? []
				: args.adminHops
						.split(",")
						.map((s) => s.trim())
						.filter((s) => s.length > 0)
						.map((s) => hopSpecOf(s, args.adminEnv)),
		out: args.out,
		sums: [],
	};
	return runRamps(args, key, admin, ctx);
}

async function runRamps(
	args: Args,
	key: string,
	admin: string | null,
	ctx: RampCtx,
): Promise<number> {
	const groups: { legs: LegSpec[]; key: string }[] = [
		{ legs: legSpecsOf(args.preset, args.legs), key },
	];
	let minted: MintedKey | null = null;
	if (args.buckle !== null && admin !== null)
		minted = await mintLaneKey(args.buckle, admin);
	if (minted === null && args.buckle !== null)
		console.error("buckle: key mint failed — skipping buckle legs");
	if (args.buckle !== null && minted !== null)
		groups.push({
			legs: (["anthropic", "chat", "responses"] as const).map((p) => ({
				leg: `buckle-${p}`,
				protocol: p,
				base: args.buckle,
				hop: true,
			})),
			key: minted.key,
		});
	return finishRamps(args, admin, minted, ctx, groups);
}

/** Ramp loop + revoke + verdict table (second half of runRamps). */
async function finishRamps(
	args: Args,
	admin: string | null,
	minted: MintedKey | null,
	ctx: RampCtx,
	groups: { legs: LegSpec[]; key: string }[],
): Promise<number> {
	const stops: string[] = [];
	for (const g of groups)
		for (const leg of g.legs) {
			const why = await rampLeg(leg, g.key, ctx);
			if (why !== null) stops.push(why);
			await Bun.sleep(LEG_SLEEP_MS);
		}
	if (args.buckle !== null && minted !== null && admin !== null) {
		const revoked = await revokeLaneKey(args.buckle, admin, minted.id);
		console.error(`buckle key revoke: ${revoked ? "ok" : "FAILED"}`);
		// fail-closed: a stranded scoped key must fail the run
		if (!revoked) return 3;
	}
	console.error(
		stops.length === 0
			? "ramp complete: no provider pressure hit"
			: `stopped:\n${stops.map((s) => `  - ${s}`).join("\n")}`,
	);
	console.log(reportTable(ctx.sums));
	console.error(`evidence: ${ctx.out}`);
	return 0;
}

if (import.meta.main) process.exit(await main());
