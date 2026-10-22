import {
	formatSessionLabel,
	llmShorthand,
	normalizeTool,
	parseSessionTags,
	slugifyLabelPart,
} from "../lib/addressing.ts";
import {
	forwardDirectEvent,
	foreignLaneMatch,
	type RelayDeliveryStatus,
	type RelayOutboxRow,
	normalizeHostLabel,
	queryRelayStatus,
	relayOutboxRecord,
	sidResolvesLocally,
} from "../lib/event-relay.ts";
import { localHubLabel, workEdgeToken } from "../lib/federation-work.ts";
import { loadLaneRegistry } from "../lib/lane-registry.ts";
import { hostname } from "node:os";
import { transcriptTail } from "../lib/transcript.ts";
import { broadcastNote, emitEvent, isLiveSession } from "./bus.ts";
import {
	arg,
	amber,
	CAPABILITIES,
	cyan,
	db,
	die,
	dim,
	green,
	projectIdentity,
	red,
} from "./shared.ts";

interface SessionRow {
	sid: string;
	project: string | null;
	role: string | null;
	parent_sid: string | null;
	worktree: string | null;
	hb: number;
	state: string;
	capabilities: string | null;
	transcript_path: string | null;
	actor: string | null;
	tags: string | null;
}

const DIRECT_MESSAGE_KIND = ["NO", "TE"].join("");

export interface SessionTarget {
	sid: string;
	label: string;
	hub: string;
	tool: string;
	sessionName: string;
	model: string | null;
	modelShorthand: string | null;
	project: string | null;
	role: string | null;
	parent_sid: string | null;
	worktree: string | null;
	actor: string | null;
	tags: Record<string, unknown>;
	capabilities: string[];
	hb: number;
}

const NAME_STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"adding",
	"build",
	"building",
	"bug",
	"by",
	"cli",
	"create",
	"creating",
	"feature",
	"fix",
	"fixing",
	"for",
	"from",
	"implement",
	"implementing",
	"in",
	"item",
	"lane",
	"of",
	"on",
	"session",
	"task",
	"the",
	"to",
	"update",
	"updating",
	"with",
	"work",
]);

const safeText = (value: string | null | undefined): string =>
	value?.trim() ?? "";

const factValue = (key: string): string | null =>
	(
		db.query("SELECT value FROM facts WHERE key = ?").get(key) as {
			value: string;
		} | null
	)?.value ?? null;

const targetRows = (now = Date.now()): SessionRow[] =>
	(
		db
			.query(
				"SELECT sid, project, role, parent_sid, worktree, hb, state, capabilities, transcript_path, actor, tags FROM sessions WHERE state = 'RUNNING' ORDER BY hb DESC, sid",
			)
			.all() as SessionRow[]
	).filter((row) => isLiveSession(row, now));

function readTranscriptModel(path: string | null | undefined): string | null {
	// W669.12 dedup: lib/transcript.ts owns byte-capped tail reads; the model
	// scan (reverse line JSON walk) stays local to coord addressing.
	const tail = path ? transcriptTail(path, 64 * 1024) : "";
	if (!tail) return null;
	for (const line of tail.split("\n").reverse()) {
		if (!line.includes('"model"')) continue;
		try {
			const parsed = JSON.parse(line) as {
				message?: { model?: string };
				model?: string;
			};
			const model =
				typeof parsed.message?.model === "string"
					? parsed.message.model
					: typeof parsed.model === "string"
						? parsed.model
						: null;
			if (safeText(model)) return model;
		} catch {}
	}
	return null;
}

function latestWorkItemName(sid: string): string | null {
	const row = db
		.query(
			"SELECT id, title FROM work_items WHERE owner_sid = ? AND state NOT IN ('DONE','CANCELLED','SUPERSEDED','FAILED') ORDER BY updated_at DESC LIMIT 1",
		)
		.get(sid) as { id: string; title: string | null } | null;
	if (!row) return null;
	const id = slugifyLabelPart(row.id, row.id.toLowerCase());
	const words = safeText(row.title)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.split(/\s+/)
		.filter(Boolean)
		.filter((word) => !NAME_STOPWORDS.has(word))
		.filter((word) => word !== id);
	const suffix = words.slice(-2).join("-");
	return suffix ? `${id}-${suffix}` : id;
}

function latestClaimName(sid: string): string | null {
	const rows = db
		.query(
			"SELECT intent FROM claims WHERE sid = ? AND intent IS NOT NULL ORDER BY ts DESC LIMIT 4",
		)
		.all(sid) as { intent: string | null }[];
	const claim = rows.find(
		(row) =>
			safeText(row.intent) &&
			!String(row.intent).startsWith("restored by monitor") &&
			String(row.intent) !== "work-graph",
	);
	return claim?.intent ? slugifyLabelPart(claim.intent, sid.slice(0, 8)) : null;
}

function sessionNameFor(row: SessionRow): string {
	const tags = parseSessionTags(row.tags);
	for (const name of [
		tags.session_name,
		tags.sessionName,
		tags.name,
		latestWorkItemName(row.sid),
		latestClaimName(row.sid),
	]) {
		if (typeof name === "string" && safeText(name))
			return slugifyLabelPart(name, row.sid.slice(0, 8));
	}
	const worktreeName = safeText(row.worktree).split("/").pop();
	if (worktreeName) return slugifyLabelPart(worktreeName, row.sid.slice(0, 8));
	return slugifyLabelPart(row.sid.slice(0, 8), "session");
}

function hubFor(row: SessionRow, tags: Record<string, unknown>): string {
	const tagged = [
		tags.hub,
		tags.hub_id,
		tags.hubId,
		tags.host,
		tags.host_id,
		tags.hostId,
	].find((value) => typeof value === "string" && safeText(value));
	if (typeof tagged === "string") return slugifyLabelPart(tagged, "local");
	const exec = factValue(`lane.${row.sid}.executor`);
	if (exec?.startsWith("llm:")) {
		const parts = exec.split(":");
		if (parts[1]) return slugifyLabelPart(parts[1], "local");
	}
	return "local";
}

function toolFor(row: SessionRow, tags: Record<string, unknown>): string {
	const explicit = [
		tags.tool,
		tags.cli,
		tags.dialect,
		tags.executor,
		tags.agent,
	].find((value) => typeof value === "string" && safeText(value));
	if (typeof explicit === "string") {
		const normalized = normalizeTool(explicit);
		if (normalized) return normalized;
	}
	const exec = factValue(`lane.${row.sid}.executor`);
	if (exec) {
		const normalized = normalizeTool(exec);
		if (normalized) return normalized;
	}
	const pathish =
		`${row.transcript_path ?? ""} ${row.worktree ?? ""}`.toLowerCase();
	if (pathish.includes("copilot")) return "copilot";
	if (pathish.includes("/.codex/") || pathish.includes("codex")) return "codex";
	if (pathish.includes("grok")) return "grok";
	return "claude";
}

function modelFor(
	row: SessionRow,
	tags: Record<string, unknown>,
): string | null {
	const tagged = [tags.model, tags.llm, tags.model_name, tags.modelName].find(
		(value) => typeof value === "string" && safeText(value),
	);
	if (typeof tagged === "string") return tagged;
	const fromFact = factValue(`lane.${row.sid}.model`);
	if (fromFact) return fromFact;
	return readTranscriptModel(row.transcript_path);
}

function toTarget(row: SessionRow): SessionTarget {
	const tags = parseSessionTags(row.tags);
	const hub = hubFor(row, tags);
	const tool = toolFor(row, tags);
	const sessionName = sessionNameFor(row);
	const model = modelFor(row, tags);
	return {
		sid: row.sid,
		label: formatSessionLabel({
			sid: row.sid,
			project: row.project,
			role: row.role,
			worktree: row.worktree,
			actor: row.actor,
			tags,
			capabilities: row.capabilities,
			parent_sid: row.parent_sid,
			transcript_path: row.transcript_path,
			hub,
			tool,
			sessionName,
			model,
		}),
		hub,
		tool,
		sessionName,
		model,
		modelShorthand: llmShorthand(model),
		project: row.project,
		role: row.role,
		parent_sid: row.parent_sid,
		worktree: row.worktree,
		actor: row.actor,
		tags,
		capabilities: safeText(row.capabilities)
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean),
		hb: row.hb,
	};
}

export function listLiveTargets(now = Date.now()): SessionTarget[] {
	return targetRows(now).map(toTarget);
}

function matchesNeedle(target: SessionTarget, needle: string): boolean {
	const q = needle.toLowerCase();
	return (
		target.label.toLowerCase().includes(q) ||
		target.sid.toLowerCase().includes(q)
	);
}

export function resolveTarget(needle: string, project?: string): SessionTarget {
	const live = listLiveTargets().filter(
		(target) => project === undefined || target.project === project,
	);
	const q = needle.replace(/^@/, "").toLowerCase();
	const exact = live.filter(
		(target) =>
			target.sid.toLowerCase() === q || target.label.toLowerCase() === q,
	);
	if (exact.length === 1) return exact[0];
	const prefix = live.filter((target) =>
		target.sid.toLowerCase().startsWith(q),
	);
	if (exact.length === 0 && prefix.length === 1) return prefix[0];
	const matches = live.filter((target) => matchesNeedle(target, q));
	if (matches.length === 1) return matches[0];
	if (matches.length === 0)
		die(
			`no live session target matching ${JSON.stringify(needle)}; no directed request delivered. Discover the exact recipient with coord fleet --json (lanes[].sid), then retry. Do not substitute a broadcast.`,
		);
	die(
		`ambiguous target ${JSON.stringify(needle)} — ${matches
			.map((target) => `${target.label} ${target.sid}`)
			.join(" | ")}`,
	);
}

// An exact, already-registered SID survives a CLI stop/resume gap. Keep its
// directed note in the durable inbox for the next SessionStart. Names and
// prefixes still require a live match so an old label cannot misroute work.
function resolveMessageTarget(needle: string): {
	target: SessionTarget;
	deferred: boolean;
} {
	const sid = needle.replace(/^@/, "");
	const row = db
		.query(
			"SELECT sid, project, role, parent_sid, worktree, hb, state, capabilities, transcript_path, actor, tags FROM sessions WHERE sid = ? COLLATE NOCASE",
		)
		.get(sid) as SessionRow | null;
	if (row && (row.state !== "RUNNING" || !isLiveSession(row)))
		return { target: toTarget(row), deferred: true };
	return { target: resolveTarget(needle), deferred: false };
}

export async function cmdTargets(rest: string[]): Promise<void> {
	const filter = arg("--filter")?.toLowerCase() ?? null;
	const wantJson = rest.includes("--json");
	// W619 capability-filtered discovery (swarm-comms-research item 5):
	// --cap <c> keeps only live targets advertising c on sessions.capabilities —
	// the A2A Agent-Card skill read, in-process.
	const cap = arg("--cap");
	if (cap && !CAPABILITIES.includes(cap))
		die(`unknown capability: ${cap} — vocabulary: ${CAPABILITIES.join(",")}`);
	let targets = listLiveTargets();
	if (cap)
		targets = targets.filter((target) => target.capabilities.includes(cap));
	if (filter)
		targets = targets.filter(
			(target) =>
				target.label.toLowerCase().includes(filter) ||
				target.sid.toLowerCase().includes(filter),
		);
	if (wantJson) {
		console.log(JSON.stringify(targets, null, 2));
		return;
	}
	if (!targets.length) {
		console.log(dim("(no live targets)"));
		return;
	}
	const width = Math.max(...targets.map((target) => target.label.length));
	console.log(`${"LABEL".padEnd(width)}  SID`);
	for (const target of targets)
		console.log(`${cyan(target.label.padEnd(width))}  ${target.sid}`);
}

export async function cmdMessage(rest: string[]): Promise<void> {
	// W1147: needle and text are RAW positional slots — the malformed
	// `message <target> --as <sid> "text"` order published the option token
	// itself as the note body and silently dropped the real text. The
	// verb-kit parser is order-free on flags, so it cannot reject this shape
	// while preserving the documented order — reject option tokens here,
	// before resolving a target or emitting any event.
	const misplacedFlag = (value: string | undefined): boolean =>
		value !== undefined &&
		["--as", "--all", "--note", "--help", "-h"].includes(
			value.split("=", 1)[0],
		);
	const badToken =
		misplacedFlag(rest[0]) && rest[0] !== "--all"
			? rest[0]
			: misplacedFlag(rest[1])
				? rest[1]
				: null;
	if (badToken)
		die(
			`option token ${JSON.stringify(badToken)} in a message positional slot — needle and text are positional: coord message <target> "text" [--as sid] | coord message --all "text" [--as sid]; flags ride AFTER the text`,
		);
	const source = arg("--as") ?? "unknown";
	const all = rest[0] === "--all";
	if (all) {
		const text = rest[1];
		if (!text) die('usage: message --all "text" [--as sid]');
		const sent = broadcastNote(text, source);
		console.log(
			`${green("✓")} ${dim(`message broadcast ${sent.id} → ${sent.targets} live session(s)`)}`,
		);
		return;
	}
	const needle = rest[0];
	const text = rest[1];
	if (!needle || !text)
		die('usage: message <target-label-sid-or-substring> "text" [--as sid]');
	// W1061 cross-hub forwarding: an exact SID that matches no live local
	// session may be a live lane on a peer hub (the lane registry stamps
	// `host`). Forward instead of queueing locally — a directed event in THIS
	// store for a foreign lane is a black hole: the lane reads its own hub's
	// store. Local routing keeps the existing behavior untouched.
	const relay = await maybeForwardToForeignLane(needle, text, source);
	if (relay) {
		for (const line of relay) console.log(line);
		return;
	}
	const { target, deferred } = resolveMessageTarget(needle);
	const id = emitEvent({
		kind: DIRECT_MESSAGE_KIND,
		note: text,
		source,
		to: target.sid,
	});
	console.log(
		`${green("✓")} ${dim(`message queued #${id} → ${target.label} @${target.sid.slice(0, 8)}`)}`,
	);
	console.log(
		dim(
			deferred
				? "This exact session is inactive; the message is queued until it resumes and remains unaccepted until it acknowledges it."
				: "A queued message does not wake an idle CLI session. It is shown on its next turn and remains unaccepted until that session acknowledges it.",
		),
	);
}

// W1061 — resolve the needle against the lane registry's FOREIGN rows and
// forward through the hub relay when it names one uniquely. Returns the
// rendered handoff lines when handled (caller prints and returns), or null
// when the needle is not a foreign lane (local resolution proceeds).
async function maybeForwardToForeignLane(
	needle: string,
	text: string,
	source: string,
): Promise<string[] | null> {
	let registry: { sid: string; host?: string }[] = [];
	try {
		registry = loadLaneRegistry(process.cwd());
	} catch {
		return null; // registry missing/unreadable — local resolution decides
	}
	const hit = foreignLaneMatch(registry, needle, hostname());
	if (!hit) return null;
	if (hit.kind === "ambiguous") {
		die(
			`ambiguous registry match for ${JSON.stringify(needle)} — ${hit.sids.join(" | ")}`,
		);
	}
	// Owner correction (inbox #51066): the registry host stamp records the
	// dispatching coordinator, not the store the lane reads. An exact sid
	// present in THIS store's sessions table is a store co-tenant — local
	// resolution decides, forwarding would strand the event.
	if (sidResolvesLocally(db, hit.sid)) return null;
	const result = await forwardDirectEvent({
		db,
		host: hit.host,
		targetSid: hit.sid,
		note: text,
		sourceSid: source,
		kind: DIRECT_MESSAGE_KIND,
		project: projectIdentity(),
		originHub: localHubLabel(),
	});
	if (!result.ok)
		die(
			`foreign lane @${hit.sid.slice(0, 8)} on host ${hit.host}: ${result.why} — not queued locally (a directed event in this store never reaches a foreign lane); re-run when the hub resolves, or coord emit --to ${hit.sid} for a local record`,
		);
	return [
		`${green("✓")} ${dim(`message forwarded → ${result.hub} lane @${hit.sid.slice(0, 8)} delivery ${result.deliveryId}`)}`,
		dim(
			`receipt face: coord delivery ${result.deliveryId} — remote SEEN/ACCEPTED lands there`,
		),
	];
}

// W1061 — the cross-hub receipt face: one delivery id → the hub's live
// QUEUED/SEEN/ACCEPTED state. Tokens never ride the outbox row; they resolve
// through the same per-label chain the forward used.
export async function cmdDelivery(rest: string[]): Promise<void> {
	const raw = rest[0]?.replace(/^#/, "");
	if (!raw) die("usage: delivery <delivery-id> [--json]");
	const id = raw.toLowerCase();
	const row = relayOutboxRecord(db, id);
	if (!row) die(`no relay delivery ${raw.slice(0, 8)} in this store's outbox`);
	if (row.state === "FAILED") {
		console.log(
			`${red("✖")} delivery ${row.delivery_id.slice(0, 8)} FAILED → @${row.target_sid.slice(0, 8)}${row.why ? ` — ${row.why}` : ""}`,
		);
		return;
	}
	const token = workEdgeToken(
		normalizeHostLabel(row.hub),
		{ label: row.hub, url: row.url, via: row.via },
		process.env,
	);
	const status = await queryRelayStatus({
		url: row.url,
		token,
		deliveryId: row.delivery_id,
	});
	if (!status.ok) {
		console.log(
			`${amber("●")} delivery ${row.delivery_id.slice(0, 8)} SENT via ${row.hub} (${row.via}) — receipt unreadable: ${status.why}`,
		);
		return;
	}
	renderDelivery(row, status.status, rest.includes("--json"));
}

function renderDelivery(
	row: RelayOutboxRow,
	status: RelayDeliveryStatus,
	asJson: boolean,
): void {
	if (asJson) {
		console.log(JSON.stringify({ ...status, hub: row.hub, via: row.via }));
		return;
	}
	const glyph =
		status.state === "ACCEPTED"
			? green("✓")
			: status.state === "SEEN"
				? green("●")
				: amber("●");
	console.log(
		`${glyph} #${status.eventId} ${row.kind} ${status.state} → @${status.target.slice(0, 8)} via ${row.hub}`,
	);
}
