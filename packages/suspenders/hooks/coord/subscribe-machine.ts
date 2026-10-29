// hooks/coord/subscribe-machine.ts — `coord subscribe --machine` (hub-of-one
// phase 5): ONE WebSocket per machine instead of one per session and one per
// subagent. The store-server's `as=*` filter hands this socket every event;
// it fans each one out exactly as the per-session subscriber would have:
//   - targeted event → append to coord-subscribe-<target>.log (the file the
//     push gate already tails), wake the native Claude session, chain the
//     Codex direct delivery
//   - untargeted event → append ONCE to coord-subscribe-_all.log; the push
//     gate tails it beside the session's own log (offset per lane)
// On every (re)connect it replays the durable pause/resume control for each
// RUNNING session — the per-session subscriber's catch-up, for all of them.
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { signalClaudeDirectEvent } from "../lib/executors/claude-wake.ts";
import { resolveStoreHttpBase } from "../lib/govdb/govdb.ts";
import {
	MACHINE_ALL_LOG_ID,
	coordSubscribeLog,
	machineSubscribePid,
	machineSubscribePidFile,
} from "../lib/lanes/subscribe-attach.ts";
import { formatEventLine, subscriberPendingControl } from "./bus.ts";
import { db, type Ev } from "./shared.ts";
import { queueCodexDelivery } from "./subscribe-delivery.ts";

function appendLine(id: string, line: string): void {
	const log = coordSubscribeLog(id);
	try {
		mkdirSync(dirname(log), { recursive: true });
		appendFileSync(log, `${line}\n`, { mode: 0o600 });
	} catch (e) {
		console.error(`coord subscribe --machine: append ${id} failed: ${e}`);
	}
}

function catchUpControls(): void {
	const live = db
		.query("SELECT sid FROM sessions WHERE state = 'RUNNING'")
		.all() as { sid: string }[];
	for (const { sid } of live) {
		const pending = subscriberPendingControl(sid);
		if (pending) signalClaudeDirectEvent(pending, sid);
	}
}

export async function cmdSubscribeMachine(): Promise<void> {
	const bound = resolveStoreHttpBase();
	if (!bound) {
		console.log(
			"(no HTTP store bound — machine subscribe needs GOVERNOR_STORE_URL; per-session subscribe keeps the poll fallback)",
		);
		return;
	}
	// one per HOME: a second subscriber (racing session starts) steps aside
	const other = machineSubscribePid();
	if (other && other !== process.pid) {
		console.log(`(machine subscriber already live: pid ${other})`);
		return;
	}
	const pidFile = machineSubscribePidFile();
	mkdirSync(dirname(pidFile), { recursive: true });
	writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 });
	const params = new URLSearchParams({ as: "*" });
	if (bound.token) params.set("token", bound.token);
	const url = `${bound.base.replace(/^http/, "ws")}/subscribe?${params}`;
	// one ordering chain per target: a later consult never overtakes an
	// earlier direct message for the same session
	const chains = new Map<string, Promise<void>>();
	let backoff = 500;
	const connect = (): void => {
		const ws = new WebSocket(url);
		ws.addEventListener("open", () => {
			backoff = 500;
			try {
				catchUpControls();
			} catch {
				console.error("coord subscribe --machine: control catch-up failed");
				ws.close();
			}
		});
		ws.addEventListener("message", (e) => {
			const event = JSON.parse(String(e.data)) as Ev & {
				target?: string | null;
			};
			const line = formatEventLine(event);
			const target = event.target ?? null;
			if (!target) {
				appendLine(MACHINE_ALL_LOG_ID, line);
				return;
			}
			appendLine(target, line);
			signalClaudeDirectEvent({ ...event, target }, target);
			chains.set(
				target,
				queueCodexDelivery(
					chains.get(target) ?? Promise.resolve(),
					event,
					target,
				),
			);
		});
		ws.addEventListener("close", () => {
			setTimeout(connect, backoff);
			backoff = Math.min(backoff * 2, 10_000);
		});
		ws.addEventListener("error", () => ws.close());
	};
	connect();
	// lives for the machine's session — until its HOME's pidfile stops naming
	// it (HOME removed, or a newer subscriber took over): then step aside
	setInterval(() => {
		let owner = "";
		try {
			owner = readFileSync(pidFile, "utf8").trim();
		} catch {}
		if (owner !== String(process.pid)) process.exit(0);
	}, 30_000);
	await new Promise<void>(() => {});
}
