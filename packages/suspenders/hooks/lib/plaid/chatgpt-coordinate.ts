// hooks/lib/plaid/chatgpt-coordinate.ts — W1013: the WS-native ChatGPT
// auto-coordinate loop. Owner correction 2026-10-20: the clipboard channel
// (pbcopy+osascript) is WRONG for the autonomous loop — the ChatGPT
// co-supervisor holds a long-lived W931 plane identity, so briefs ride the
// board wire (POST /api/consult) and answers land back as consult.answer
// events on the same plane. A fleet-loop maintenance task fires this runner;
// it scans the work graph for the three gated triggers, composes a bounded
// scrubbed brief per trigger, asks over the W931 ingress, and on later fires
// drains answered consults back to the originating item and closes the loop
// with consult-reply feedback. Guardrails: one outbound ask per request
// identity per hour (W947 dedupe pattern), IKEA-scoped content and secret
// material never leave the machine (scrubOutbound + the IKEA skip), and the
// machine-level config IS the opt-in (no file = disabled, knowledge-sync
// discipline) with `.fleet/chatgpt-auto-paused` as the ops kill switch.
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonConfEither } from "../kernel-conf.ts";
import { openStore, type GovernorStore } from "../govdb/govdb-store.ts";
import { scrubOutbound } from "../notify/notify.ts";

export type TriggerClass = "need-decision" | "failed-relaunch" | "bench-row";

export interface ChatGptCoordConfig {
	/** the config IS the opt-in — absent file / enabled:false = idle runner */
	enabled: boolean;
	/** ChatGPT plane sid; empty = the --best ranked-expert ask */
	target: string;
	/** board base the W931 ingress lives on (config-over-code) */
	boardUrl: string;
	/** 0600 file holding the x-klh-write-token (secrets are never typed) */
	writeTokenFile: string;
	/** the runner's own plane identity (external session row on the board) */
	askerSid: string;
	/** one ask per request identity inside this window (W947 pattern) */
	dedupeS: number;
	/** work.failed events per item before the failed-relaunch trigger fires */
	failedRelaunches: number;
	/** the brief hard cap (mission: <=80 lines) */
	briefMaxLines: number;
	triggers: {
		needDecision: boolean;
		failedRelaunch: boolean;
		benchRow: boolean;
	};
}

export const CHATGPT_COORD_CONFIG_PATH = (): string =>
	process.env.KLH_CHATGPT_COORDINATE ??
	join(homedir(), ".config", "klh", "chatgpt-coordinate.json");

export const DEFAULT_CONFIG: ChatGptCoordConfig = {
	enabled: false,
	target: "",
	boardUrl: process.env.KLH_CHATGPT_BOARD_URL ?? "http://127.0.0.1:7799",
	writeTokenFile: join(homedir(), ".cache", "claude-governor", "write-token"),
	askerSid: "chatgpt-auto",
	dedupeS: 3600,
	failedRelaunches: 2,
	briefMaxLines: 80,
	triggers: { needDecision: true, failedRelaunch: true, benchRow: true },
};

const boolOf = (v: unknown): boolean => v === true;
const intOf = (v: unknown, dflt: number): number =>
	typeof v === "number" && Number.isInteger(v) && v > 0 ? v : dflt;

/** Merge a parsed yaml doc over the defaults; unknown keys ignored. */
export function normalizeConfig(raw: unknown): ChatGptCoordConfig {
	const r = (raw ?? {}) as Record<string, unknown>;
	const t = (r.triggers ?? {}) as Record<string, unknown>;
	return {
		...DEFAULT_CONFIG,
		enabled: boolOf(r.enabled),
		target: typeof r.target === "string" ? r.target.trim() : "",
		boardUrl:
			typeof r.board_url === "string" && r.board_url.trim() !== ""
				? r.board_url.trim().replace(/\/+$/, "")
				: DEFAULT_CONFIG.boardUrl,
		writeTokenFile:
			typeof r.write_token_file === "string" && r.write_token_file.trim() !== ""
				? r.write_token_file.trim()
				: DEFAULT_CONFIG.writeTokenFile,
		askerSid:
			typeof r.asker_sid === "string" && r.asker_sid.trim() !== ""
				? r.asker_sid.trim()
				: DEFAULT_CONFIG.askerSid,
		dedupeS: intOf(r.dedupe_s, DEFAULT_CONFIG.dedupeS),
		failedRelaunches: intOf(
			r.failed_relaunches,
			DEFAULT_CONFIG.failedRelaunches,
		),
		briefMaxLines: intOf(r.brief_max_lines, DEFAULT_CONFIG.briefMaxLines),
		triggers: {
			needDecision: boolOf(t.need_decision),
			failedRelaunch: boolOf(t.failed_relaunch),
			benchRow: boolOf(t.bench_row),
		},
	};
}

/** null when no config exists — the runner idles, never errors. */
export function loadChatGptCoordConfig(
	path: string = CHATGPT_COORD_CONFIG_PATH(),
): ChatGptCoordConfig | null {
	let raw: unknown;
	try {
		raw = readJsonConfEither(path);
	} catch {
		return null;
	}
	return normalizeConfig(raw);
}

export interface ChatGptCoordState {
	/** per-stream event cursors (events have no project column — the project
	 *  filter rides the payload, the cursor keeps the scan bounded). The
	 *  NEED_DECISION stream is deliberately cursor-free: liveness re-asks. */
	cursors: { failed: number };
	/** last bench trigger head (benchmarks.md row detection) */
	benchHead: string | null;
	/** request identity → {ts, consult} — the W947-pattern dedupe ledger */
	sent: Record<string, { ts: number; consult: string }>;
	/** open consults this runner asked: consult → {identity, itemId, ts} */
	open: Record<string, { identity: string; itemId: string | null; ts: number }>;
}

export const emptyState = (): ChatGptCoordState => ({
	cursors: { failed: 0 },
	benchHead: null,
	sent: {},
	open: {},
});

export function loadState(path: string): ChatGptCoordState {
	try {
		const raw = JSON.parse(
			readFileSync(path, "utf8"),
		) as Partial<ChatGptCoordState>;
		return {
			...emptyState(),
			...raw,
			cursors: { ...emptyState().cursors, ...raw.cursors },
		};
	} catch {
		return emptyState();
	}
}

export function saveState(path: string, state: ChatGptCoordState): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(state, null, "\t")}\n`);
}

export const pausedMarker = (repo: string): string =>
	join(repo, ".fleet", "chatgpt-auto-paused");

// ─── triggers ────────────────────────────────────────────────────────────────

export interface Trigger {
	cls: TriggerClass;
	/** dedupe identity — one ask per identity per window (W947 pattern) */
	identity: string;
	itemId: string | null;
	subject: string;
	detail: string;
}

const ID_RE = /^[Ww]\d[\w.]*$/;
const IKEA_RE = /ikea/i;
const payloadOf = (raw: string | null): Record<string, unknown> => {
	try {
		return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
	} catch {
		return {};
	}
};
const textOf = (v: unknown): string =>
	typeof v === "string" ? v.trim().slice(0, 400) : "";

/** IKEA intel NEVER crosses the wire (coord-facts-only law). */
export const ikeaContaminated = (...parts: (string | null)[]): boolean =>
	parts.some((p) => p !== null && IKEA_RE.test(p));

export interface ScanDeps {
	project: string;
	config: ChatGptCoordConfig;
	state: ChatGptCoordState;
	repo: string;
	/** head sha reader (injected; default rev-parse) */
	revParse?: (repo: string) => string | null;
	/** changed-paths reader between two heads (injected; default git diff) */
	changedPaths?: (repo: string, from: string, to: string) => string[];
}

interface EventRow {
	id: number;
	scope: string | null;
	payload: string | null;
}

const scanNeedDecision = (
	store: GovernorStore,
	deps: ScanDeps,
	triggers: Trigger[],
): void => {
	if (!deps.config.triggers.needDecision) return;
	// NOT cursor-consumed: a NEED_DECISION stays live until it is answered,
	// so the newest window re-yields every fire and the identity ledger's
	// hourly window is the sole ask cadence (unresolved decisions re-ask).
	const rows = store
		.query(
			"SELECT id, scope, payload FROM events WHERE kind = 'NEED_DECISION' ORDER BY id DESC LIMIT 20",
		)
		.all() as EventRow[];
	for (const r of rows) {
		const p = payloadOf(r.payload);
		const itemId =
			(r.scope && ID_RE.test(r.scope) ? r.scope : null) ??
			(typeof p.work === "string" && ID_RE.test(p.work) ? p.work : null);
		const reason = textOf(p.reason) || textOf(p.note) || "decision needed";
		if (ikeaContaminated(reason, r.scope, deps.project)) continue;
		triggers.push({
			cls: "need-decision",
			identity: `need-decision:${r.id}`,
			itemId,
			subject: itemId ? `decision needed on ${itemId}` : "decision needed",
			detail: reason,
		});
	}
};

const scanFailedRelaunch = (
	store: GovernorStore,
	deps: ScanDeps,
	triggers: Trigger[],
): void => {
	if (!deps.config.triggers.failedRelaunch) return;
	const rows = store
		.query(
			"SELECT id, payload FROM events WHERE kind = 'work.failed' AND id > ? ORDER BY id LIMIT 100",
		)
		.all(deps.state.cursors.failed) as EventRow[];
	for (const r of rows) {
		deps.state.cursors.failed = r.id;
		const p = payloadOf(r.payload);
		if (textOf(p.project) && textOf(p.project) !== deps.project) continue;
		const itemId = textOf(p.work);
		if (!itemId || !ID_RE.test(itemId)) continue;
		// the milestone counter IS the identity — each new failure can ask once
		const count = store
			.query(
				"SELECT COUNT(*) AS n FROM events WHERE kind = 'work.failed' AND id <= ?",
			)
			.get(r.id) as { n: number };
		if (Number(count.n) < deps.config.failedRelaunches) continue;
		const note = textOf(p.note) || "repeated lane failure";
		if (ikeaContaminated(note, itemId, deps.project)) continue;
		triggers.push({
			cls: "failed-relaunch",
			identity: `failed-relaunch:${itemId}:${count.n}`,
			itemId,
			subject: `${itemId} failed after ${count.n} runs`,
			detail: note,
		});
	}
};

const scanBenchRow = (deps: ScanDeps, triggers: Trigger[]): void => {
	if (!deps.config.triggers.benchRow) return;
	const head = (deps.revParse ?? defaultRevParse)(deps.repo);
	if (!head || head === deps.state.benchHead) return;
	const paths = deps.changedPaths
		? deps.changedPaths(deps.repo, deps.state.benchHead ?? head, head)
		: defaultChangedPaths(deps.repo, deps.state.benchHead ?? head, head);
	deps.state.benchHead = head;
	if (!paths.some((p) => p.endsWith("benchmarks.md"))) return;
	triggers.push({
		cls: "bench-row",
		identity: `bench-row:${head.slice(0, 12)}`,
		itemId: null,
		subject: "benchmarks.md row landed",
		detail: `bench verdict row landed at ${head.slice(0, 12)}; files: ${paths.slice(0, 5).join(", ")}`,
	});
};

const defaultRevParse = (repo: string): string | null => {
	const p = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"]);
	const out = p.stdout ? new TextDecoder().decode(p.stdout).trim() : "";
	return p.exitCode === 0 && out !== "" ? out : null;
};

const defaultChangedPaths = (
	repo: string,
	from: string,
	to: string,
): string[] => {
	if (from === to) return [];
	const p = Bun.spawnSync([
		"git",
		"-C",
		repo,
		"diff",
		"--name-only",
		`${from}..${to}`,
	]);
	if (p.exitCode !== 0) return [];
	return new TextDecoder()
		.decode(p.stdout)
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
};

export function scanTriggers(store: GovernorStore, deps: ScanDeps): Trigger[] {
	const triggers: Trigger[] = [];
	scanNeedDecision(store, deps, triggers);
	scanFailedRelaunch(store, deps, triggers);
	scanBenchRow(deps, triggers);
	return triggers;
}

// ─── brief composer ──────────────────────────────────────────────────────────

const LINE_CAP = 200;

/** Bounded, scrubbed co-supervisor brief: context, the trigger evidence and
 *  a per-item verdict ask — <=maxLines lines, every line machine-truncated,
 *  secret material masked before anything exists to leak. */
export function composeBrief(
	trigger: Trigger,
	opts: {
		itemTitle?: string | null;
		itemState?: string | null;
		maxLines?: number;
		repo?: string;
	} = {},
): string {
	const lines: string[] = [];
	lines.push(
		`[fleet co-supervisor ask] ${trigger.cls}${opts.repo ? ` · repo ${opts.repo}` : ""}`,
	);
	if (trigger.itemId)
		lines.push(
			`item: ${trigger.itemId}${opts.itemState ? ` (state ${opts.itemState})` : ""}${opts.itemTitle ? ` — ${opts.itemTitle}` : ""}`,
		);
	lines.push(`subject: ${trigger.subject}`);
	lines.push("evidence:");
	for (const l of trigger.detail.split("\n").filter(Boolean))
		lines.push(`- ${l}`);
	lines.push("ask:");
	lines.push(
		trigger.itemId
			? `reply with a per-item verdict for ${trigger.itemId}: actionable-next-step or needs-owner, one paragraph.`
			: "reply with one paragraph: is this fleet signal worth owner attention, and what is the next step?",
	);
	return lines
		.slice(0, opts.maxLines ?? 80)
		.map((l) => scrubOutbound(l.slice(0, LINE_CAP)))
		.join("\n");
}

// ─── wire + coordinator ──────────────────────────────────────────────────────

export interface ConsultWire {
	/** the W931 ingress POST /api/consult */
	postConsult: (
		body: Record<string, unknown>,
	) => Promise<{ status: number; json: Record<string, unknown> }>;
	/** the credentialed outbox pull (answers + consult traffic) */
	fetchOutbox: (
		sid: string,
		project: string,
	) => Promise<{ status: number; json: Record<string, unknown> }>;
	/** asker-side loop close: coord consult-reply --feedback */
	closeFeedback: (
		consult: string,
		feedback: string,
		evidence: string,
	) => Promise<void>;
	/** relay an answer to the originating item's owner (W861 drain) */
	relayAnswer: (
		consult: string,
		answer: string,
		itemId: string | null,
	) => Promise<"relayed" | "no-owner" | "skipped">;
}

const readToken = (path: string): string | null => {
	try {
		const t = readFileSync(path, "utf8").trim();
		return t === "" ? null : t;
	} catch {
		return null;
	}
};

/** The default board wire: fetch against the configured board base with the
 *  write-token header on every call (the outbox is a CREDENTIALED read). */
export function createBoardWire(
	config: ChatGptCoordConfig,
	project: string,
): ConsultWire {
	const token = readToken(config.writeTokenFile);
	const headers = {
		"content-type": "application/json",
		...(token ? { "x-klh-write-token": token } : {}),
	};
	const post = async (path: string, body: unknown) => {
		const res = await fetch(`${config.boardUrl}${path}`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
		return {
			status: res.status,
			json: (await res.json()) as Record<string, unknown>,
		};
	};
	return {
		postConsult: (body) => post("/api/consult", body),
		fetchOutbox: async (sid, project) => {
			const res = await fetch(
				`${config.boardUrl}/api/outbox/${encodeURIComponent(sid)}?project=${encodeURIComponent(project)}`,
				{ headers },
			);
			return {
				status: res.status,
				json: (await res.json()) as Record<string, unknown>,
			};
		},
		closeFeedback: async (consult, feedback, evidence) => {
			const p = Bun.spawnSync([
				process.execPath,
				join(suspendersBinDir(), "coord.ts"),
				"consult-reply",
				consult,
				"--feedback",
				feedback,
				"--evidence",
				evidence,
				"--as",
				config.askerSid,
			]);
			if (p.exitCode !== 0)
				throw new Error(
					`consult-reply failed: ${new TextDecoder().decode(p.stderr).slice(0, 200)}`,
				);
		},
		relayAnswer: async (consult, answer, itemId) => {
			if (!itemId) return "skipped";
			return relayToOwner(consult, answer, itemId, project, config.askerSid);
		},
	};
}

const suspendersBinDir = (): string => join(import.meta.dir, "..", "bin");

// the W861 drain: the answer lands where it was asked — the owning lane's
// inbox, via the supported coord message verb. Dead/absent owner = skipped
// (the consult row + feedback evidence stay the durable record).
const relayToOwner = async (
	consult: string,
	answer: string,
	itemId: string,
	project: string,
	askerSid: string,
): Promise<"relayed" | "no-owner" | "skipped"> => {
	let owner: string | null = null;
	let store: GovernorStore | null = null;
	try {
		store = openStore();
		const row = store
			.query("SELECT owner_sid FROM work_items WHERE id = ? AND project = ?")
			.get(itemId, project) as { owner_sid: string | null } | null;
		owner = row?.owner_sid ?? null;
	} catch {
		return "skipped";
	} finally {
		store?.close();
	}
	if (!owner || owner === askerSid) return "no-owner";
	// W1147: message's needle and text are positional — an option token in
	// the text slot publishes the option itself as the note body. Documented
	// order: message <target> "text" --as <sid>.
	const p = Bun.spawnSync([
		process.execPath,
		join(suspendersBinDir(), "coord.ts"),
		"message",
		owner,
		`consult ${consult} answered: ${answer.slice(0, 400)}`,
		"--as",
		askerSid,
	]);
	return p.exitCode === 0 ? "relayed" : "skipped";
};

export interface CoordRunResult {
	status: "disabled" | "paused" | "ran" | "error";
	asked: string[];
	deduped: string[];
	drained: { consult: string; relay: string }[];
	skippedTriggers: Trigger[];
	errors: string[];
}

export interface CoordinatorDeps {
	config: ChatGptCoordConfig;
	project: string;
	repo: string;
	statePath: string;
	wire: ConsultWire;
	/** injected store (tests); default openStore() — closed iff owned */
	store?: GovernorStore;
	itemInfo?: (itemId: string) => { title: string | null; state: string | null };
	now?: () => number;
	log?: (m: string) => void;
}

export function createChatGptCoordinator(
	deps: CoordinatorDeps,
): () => Promise<CoordRunResult> {
	const now = deps.now ?? Date.now;
	const log = deps.log ?? (() => {});
	return async (): Promise<CoordRunResult> => {
		const out: CoordRunResult = {
			status: "ran",
			asked: [],
			deduped: [],
			drained: [],
			skippedTriggers: [],
			errors: [],
		};
		if (!deps.config.enabled) return { ...out, status: "disabled" };
		if (existsSync(pausedMarker(deps.repo)))
			return { ...out, status: "paused" };
		const state = loadState(deps.statePath);
		const ownStore = deps.store === undefined;
		let store: GovernorStore | null = deps.store ?? null;
		try {
			if (store === null) store = openStore();
			const triggers = scanTriggers(store, {
				project: deps.project,
				config: deps.config,
				state,
				repo: deps.repo,
			});
			// ask phase: identity dedupe → bounded brief → W931 ingress POST
			for (const trigger of triggers) {
				const prev = state.sent[trigger.identity];
				if (prev && now() - prev.ts < deps.config.dedupeS * 1000) {
					out.deduped.push(trigger.identity);
					continue;
				}
				if (ikeaContaminated(trigger.subject, trigger.detail)) {
					out.skippedTriggers.push(trigger);
					continue;
				}
				const info = trigger.itemId
					? (deps.itemInfo?.(trigger.itemId) ?? { title: null, state: null })
					: { title: null, state: null };
				const brief = composeBrief(trigger, {
					itemTitle: info.title,
					itemState: info.state,
					maxLines: deps.config.briefMaxLines,
					repo: deps.repo,
				});
				const body: Record<string, unknown> = {
					project: deps.project,
					sid: deps.config.askerSid,
					q: brief.slice(0, 3800),
				};
				if (deps.config.target !== "") body.target = deps.config.target;
				else body.best = true;
				if (trigger.itemId) body.scope = trigger.itemId;
				const res = await deps.wire.postConsult(body);
				const consult =
					typeof res.json.consult === "string" ? res.json.consult : null;
				if (res.status === 200 && res.json.ok === true && consult) {
					state.sent[trigger.identity] = { ts: now(), consult };
					state.open[consult] = {
						identity: trigger.identity,
						itemId: trigger.itemId,
						ts: now(),
					};
					out.asked.push(consult);
					log(
						`CHATGPT-ASK ${trigger.cls} ${trigger.itemId ?? "-"} → ${consult}`,
					);
				} else {
					out.errors.push(
						`ask ${trigger.identity}: HTTP ${res.status} ${String(res.json.error ?? res.json.output ?? "").slice(0, 160)}`,
					);
				}
			}
		} catch (e) {
			out.errors.push(e instanceof Error ? e.message : String(e));
		} finally {
			if (ownStore) store?.close();
		}
		// drain phase: answered consults flow back to the item (W861), then the
		// asker closes the loop with consult-reply feedback
		for (const [consult, meta] of Object.entries(state.open)) {
			try {
				const ob = await deps.wire.fetchOutbox(
					deps.config.askerSid,
					deps.project,
				);
				if (ob.status !== 200) {
					out.errors.push(`outbox ${consult}: HTTP ${ob.status}`);
					continue;
				}
				const events = Array.isArray(ob.json.events)
					? (ob.json.events as { kind: string; payload: string | null }[])
					: [];
				const hit = events.find((ev) => {
					if (ev.kind !== "consult.answer") return false;
					const p = payloadOf(ev.payload);
					return p.consult === consult;
				});
				if (!hit) continue;
				const p = payloadOf(hit.payload);
				const answer = textOf(p.answer);
				const relay =
					answer !== ""
						? await deps.wire.relayAnswer(consult, answer, meta.itemId)
						: "skipped";
				await deps.wire.closeFeedback(
					consult,
					"resolved",
					`answer drained to ${meta.itemId ?? "no item"} (${relay}): ${answer.slice(0, 200)}`,
				);
				out.drained.push({ consult, relay });
				delete state.open[consult];
				log(`CHATGPT-DRAIN ${consult} ${relay}`);
			} catch (e) {
				out.errors.push(
					`drain ${consult}: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		}
		// gc the dedupe ledger past 2× window so the state file stays bounded
		const horizon = deps.config.dedupeS * 2000;
		for (const [id, v] of Object.entries(state.sent))
			if (now() - v.ts > horizon) delete state.sent[id];
		saveState(deps.statePath, state);
		return out;
	};
}
