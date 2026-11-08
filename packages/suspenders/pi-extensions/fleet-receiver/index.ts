// pi-extensions/fleet-receiver — W2863 face (a): the consult-plane
// WS-receiver for pi. pi has NO fleet hooks, so the receiver rides the plane
// only: it registers the pi session on coord (`pi-<pi-session-id>`), keeps
// its heartbeat fresh via the bootstrap UPSERT, tails the machine
// subscriber's per-session feed log (W303 machine mode), and injects
// targeted events (consult / message / consult.answer / NEED_DECISION
// addressed to this lane) into the pi agent as steer (mid-run) or followUp
// (idle) via pi.sendUserMessage — the injection pi's tabula-rasa witness
// run never got. Self-contained: node builtins + type-only pi imports, so
// the installed copy runs anywhere.
import { execFile, spawn, spawnSync } from "node:child_process";
import {
	closeSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { promisify } from "node:util";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const POLL_MS = Math.max(
	5000,
	Number(process.env.PI_FLEET_RCV_POLL_MS) || 15000,
);
const FEED_TIMEOUT_MS = 4000;
const TARGETED = new Set([
	"consult",
	"message",
	"consult.answer",
	"need_decision",
	"need-decision",
]);

// Feed lines render `#<id> <source8> <kind>  <field=value ...>` — parse the
// triple, keep the raw line as the content carrier.
export function parseFeedLine(
	line: string,
): { id: number; from: string; kind: string } | null {
	const m = /^#\s*(\d+)\s+(\S+)\s+([A-Za-z_.-]+)/.exec(line.trim());
	if (!m) return null;
	return { id: Number(m[1]), from: m[2], kind: m[3] };
}

export function isTargeted(kind: string): boolean {
	return TARGETED.has(kind);
}

// consult lines carry `consult=C###` in their field tail.
export function consultIdOf(line: string): string | null {
	const m = /\bconsult=(\S+)/.exec(line);
	return m ? m[1] : null;
}

export function composeInjection(line: string, sid: string): string {
	const head = parseFeedLine(line.trim());
	if (!head) return "";
	const consultId = consultIdOf(line);
	let reply = `\nAck after acting: coord ack ${head.id} --as ${sid}`;
	if (head.kind === "consult") {
		reply =
			`\nReply: coord consult-reply ${consultId ?? "C##"} "<answer>" --as ${sid}` +
			`\nAck after replying: coord ack ${head.id} --as ${sid}`;
	} else if (head.kind === "consult.answer") {
		reply = `\nRelay where asked; close the loop: coord consult-reply ${consultId ?? "C##"} --feedback resolved|failed --evidence ... --as ${sid}`;
	}
	return (
		`fleet consult-plane delivery (event #${head.id}, kind=${head.kind}, from ${head.from}):\n` +
		`  ${line.trim()}\n` +
		`Your lane id: ${sid}. Peers: coord targets.` +
		reply
	);
}

const exec = promisify(execFile);

// Plane-only: every coord touch rides the CLI. Empty string = coord miss
// (unreachable or missing) — the caller degrades, never throws.
async function runCoord(
	args: string[],
	cwd: string,
	timeoutMs: number,
): Promise<string> {
	try {
		const r = await exec("coord", args, {
			timeout: timeoutMs,
			encoding: "utf8",
			cwd,
			maxBuffer: 8 * 1024 * 1024,
		});
		return r.stdout;
	} catch {
		return "";
	}
}

// Self-contained machine-subscriber liveness probe (mirrors
// subscribe-attach.ts, duplicated BY DESIGN — the installed extension
// cannot import fleet internals).
export function machineSubscriberLive(home: string): boolean {
	let pid = 0;
	try {
		pid = Number(
			readFileSync(
				`${home}/.claude-insights/coord-subscribe-machine.pid`,
				"utf8",
			).trim(),
		);
	} catch {
		return false;
	}
	return machinePidAlive(pid);
}

function machinePidAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid < 2) return false;
	// node:child_process — the managed pi launcher runs Node, no Bun global
	const p = spawnSync("/bin/ps", ["-o", "command=", "-p", String(pid)], {
		stdout: "pipe",
		stderr: "ignore",
		encoding: "utf8",
	});
	return (
		p.status === 0 && /coord[.]ts subscribe --machine/.test(p.stdout ?? "")
	);
}

// Byte-cursor tail of the session feed log; returns NEW complete lines
// (any kind — the caller filters) since `cursor`, plus the new cursor.
// A missing file reads as empty-at-zero (receiver started before the feed).
export function readNewFeedLines(
	path: string,
	cursor: number,
): { lines: string[]; cursor: number } {
	let size = 0;
	try {
		size = statSync(path).size;
	} catch {
		return { lines: [], cursor: 0 };
	}
	const from = Math.min(cursor, size);
	const lines: string[] = [];
	try {
		const fd = openSync(path, "r");
		try {
			const buf = Buffer.alloc(size - from);
			readSync(fd, buf, 0, buf.length, from);
			for (const l of buf.toString("utf8").split("\n")) {
				const t = l.trim();
				if (t && parseFeedLine(t)) lines.push(t);
			}
		} finally {
			closeSync(fd);
		}
	} catch {
		return { lines: [], cursor };
	}
	return { lines, cursor: size };
}

// pi's stable per-session id — the receiver's coord identity rides it
// (`pi-<id>`), so a resumed pi session keeps its lane, name and feed.
export function piSessionId(ctx: ExtensionContext): string | null {
	try {
		const raw = ctx.sessionManager.getSessionId();
		return typeof raw === "string" && raw ? raw : null;
	} catch {
		return null;
	}
}

const feedLog = (sid: string): string =>
	`${process.env.HOME}/.claude-insights/coord-subscribe-${sid}.log`;

type ReceiverState = {
	cursor: number;
	sid: string;
	busy: boolean;
	lastInjectAt: number;
	lastError: string | null;
	wsLive: boolean;
};

// Tail the feed and inject every targeted line as steer (mid-run) or
// followUp (idle) — the delivery pi's witness run never got.
async function injectFeedLines(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	st: ReceiverState,
): Promise<void> {
	const { lines, cursor } = readNewFeedLines(feedLog(st.sid), st.cursor);
	st.cursor = cursor;
	for (const line of lines) {
		const head = parseFeedLine(line);
		if (!head || !isTargeted(head.kind)) continue;
		await injectOne(pi, ctx, st, line);
	}
}

async function injectOne(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	st: ReceiverState,
	line: string,
): Promise<void> {
	const text = composeInjection(line, st.sid);
	if (!text) return;
	try {
		await pi.sendUserMessage(text, {
			deliverAs: ctx.isIdle() ? "followUp" : "steer",
		});
		st.lastInjectAt = Date.now();
		st.lastError = null;
	} catch (e) {
		st.lastError = e instanceof Error ? e.message : String(e);
	}
}

// The heartbeat: pi has no fleet hooks, so the bootstrap UPSERT keeps the
// lane's hb fresh (a hb-stale pi row sweeps like any other).
async function heartbeat(st: ReceiverState, cwd: string): Promise<void> {
	await runCoord(
		["bootstrap", "--as", st.sid, "--role", "worker"],
		cwd,
		FEED_TIMEOUT_MS,
	);
}

async function receiverTick(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	st: ReceiverState,
): Promise<void> {
	if (st.busy || !st.sid) return;
	st.busy = true;
	try {
		await injectFeedLines(pi, ctx, st);
		st.wsLive = machineSubscriberLive(process.env.HOME ?? "");
		await heartbeat(st, ctx.cwd);
		renderStatus(ctx, st);
	} finally {
		st.busy = false;
	}
}

// Face (f) readiness: the status line carries the consult-plane face —
// ws liveness + last-injection age — plain string (theme adds colour in TUI).
function renderStatus(ctx: ExtensionContext, st: ReceiverState): void {
	if (!ctx.hasUI) return;
	const age = st.lastInjectAt
		? ` · last ${Math.round((Date.now() - st.lastInjectAt) / 1000)}s`
		: "";
	const bad = st.lastError ? " · err" : "";
	ctx.ui.setStatus(
		"fleet-rcv",
		`⚓ rcv ${st.wsLive ? "ws" : "ws✗"}${age}${bad}`,
	);
}

// No machine subscriber? Spawn THIS session's `coord subscribe --as <sid>`
// (the CLI self-cleans via the W494 staleness exit). node spawn — the
// managed pi launcher runs Node, no Bun global.
function ensureSubscriber(sid: string): ReturnType<typeof spawn> {
	return spawn("coord", ["subscribe", "--as", sid], {
		stdio: ["ignore", "ignore", "ignore"],
	});
}

// session_start body: identity → EOF cursor → register → subscriber ensure
// → poll loop. The bootstrap is AWAITED before the subscriber decision —
// deciding wsLive on an unawaited probe raced and double-subscribed.
// Returns the shutdown cleaner.
async function attachReceiver(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<(() => void) | null> {
	const raw = piSessionId(ctx);
	if (!raw) return null;
	const st = newReceiverState(`pi-${raw}`);
	// start at EOF: only events arriving from now on get injected — durable
	// late-join replay is W2866's mailbox semantics, not ours
	st.cursor = readNewFeedLines(feedLog(st.sid), 0).cursor;
	await runCoord(
		["bootstrap", "--as", st.sid, "--role", "worker"],
		ctx.cwd,
		FEED_TIMEOUT_MS,
	);
	st.wsLive = machineSubscriberLive(process.env.HOME ?? "");
	// expose the canonical resolved sid (raw → `pi-<raw>`) so peers stop
	// guessing between the SDK raw id and the prefixed plane id (W2875)
	const home = process.env.HOME;
	if (home) {
		try {
			writeFileSync(
				`${home}/.claude-insights/fleet-receiver-${raw}.sid`,
				st.sid,
			);
		} catch {}
	}
	const subProc = st.wsLive ? undefined : ensureSubscriber(st.sid);
	const timer = setInterval(() => {
		void receiverTick(pi, ctx, st);
	}, POLL_MS);
	return () => {
		clearInterval(timer);
		subProc?.kill();
	};
}

function newReceiverState(sid: string): ReceiverState {
	return {
		cursor: 0,
		sid,
		busy: false,
		lastInjectAt: 0,
		lastError: null,
		wsLive: false,
	};
}

// The receiver extension: identity → heartbeat → subscriber ensure → poll
// loop → cleanup. Everything degrades; nothing throws out of a handler.
// Pi 1.5 SDK hands session_start handlers (event, ctx) — ctx is the SECOND
// argument; the old single-arg binding never attached.
export default function fleetReceiver(pi: ExtensionAPI) {
	let cleanup: (() => void) | null = null;
	let disposed = false;
	pi.on("session_start", (_event, ctx) => {
		void attachReceiver(pi, ctx).then((c) => {
			if (disposed) c?.();
			else cleanup = c;
		});
	});
	pi.on("session_shutdown", () => {
		disposed = true;
		cleanup?.();
	});
}
