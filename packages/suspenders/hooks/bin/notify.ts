#!/usr/bin/env bun
// hooks/bin/notify.ts — W695.2: resident notification fan-out. One WS
// subscription to the store's /subscribe push (never a poll loop when a
// store is bound); each notify-kind event runs through lib/notify.ts
// (classify → dedupe → per-class rate limit → scrub) into the channel
// adapters. Config: ~/.config/klh/notify.yaml (KLH_NOTIFY overrides); absent
// config = idle, never an error. launchd-safe: KeepAlive service, reconnect
// backoff inside, all failures isolated to a log line.
//   bun notify.ts [run]            resident daemon
//   bun notify.ts test [--channel c]  send one synthetic notification
//   bun notify.ts check            print resolved config + channels (no send)
import { homedir } from "node:os";
import {
	openStore,
	resolveProject,
	resolveStoreHttpBase,
} from "../lib/govdb.ts";
import {
	type BusEvent,
	type ChannelName,
	createNotifier,
	loadNotifyConfig,
	type NotifyConfig,
	subscribedKinds,
} from "../lib/notify.ts";
import { sendersFor } from "../lib/notify-adapters.ts";
import { firePulse, PULSE_STATE_PATH } from "../lib/pulse.ts";
import { fleetWarm, readMiningLines } from "../lib/cache-drilldown.ts";
import { defineVerb, runCli } from "../lib/verb-kit.ts";

const log = (m: string): void =>
	console.log(`${new Date().toISOString()} ${m}`);

function startSubscribe(
	cfg: NotifyConfig,
	onEvent: (ev: BusEvent) => void,
): boolean {
	const bound = resolveStoreHttpBase();
	if (!bound) return false;
	const params = new URLSearchParams({
		as: cfg.as,
		kinds: subscribedKinds().join(","),
	});
	if (bound.token) params.set("token", bound.token);
	const url = `${bound.base.replace(/^http/, "ws")}/subscribe?${params}`;
	let backoff = 500;
	const connect = (): void => {
		const ws = new WebSocket(url);
		ws.addEventListener("open", () => {
			backoff = 500;
			log("subscribed");
		});
		ws.addEventListener("message", (e) => {
			try {
				onEvent(JSON.parse(String(e.data)) as BusEvent);
			} catch {
				log("bad frame dropped");
			}
		});
		ws.addEventListener("close", () => {
			setTimeout(connect, backoff);
			backoff = Math.min(backoff * 2, 10_000);
		});
		ws.addEventListener("error", () => ws.close());
	};
	connect();
	return true;
}

// no HTTP store bound (local-dev SQLite): the bus table is the only source,
// so tail it from the current head — the same fallback coord subscribe takes
function startTail(onEvent: (ev: BusEvent) => void): void {
	const db = openStore();
	const kinds = subscribedKinds();
	const q = `SELECT id, ts, source, kind, scope, payload FROM events WHERE id > ? AND target IS NULL AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY id`;
	let cur =
		(db.query("SELECT MAX(id) AS m FROM events").get() as { m: number | null })
			.m ?? 0;
	log("no HTTP store bound — tailing events table");
	setInterval(() => {
		for (const ev of db.query(q).all(cur, ...kinds) as BusEvent[]) {
			cur = ev.id;
			onEvent(ev);
		}
	}, 2000);
}

function load(): NotifyConfig | null {
	try {
		return loadNotifyConfig();
	} catch (e) {
		log(`notify.yaml unreadable: ${e instanceof Error ? e.message : e}`);
		return null;
	}
}

async function run(): Promise<void> {
	const cfg = load();
	if (!cfg) {
		log("no notify.yaml — idle (see examples/notify.example.yaml)");
		await new Promise<void>(() => {});
		return;
	}
	const senders = sendersFor(cfg, homedir());
	log(`channels: ${Object.keys(senders).join(",") || "none"}`);
	const notifier = createNotifier({ config: cfg, senders });
	const onEvent = (ev: BusEvent): void => {
		void notifier
			.handle(ev)
			.then((r) =>
				log(
					`#${ev.id} ${ev.kind} → ${r.status} ${JSON.stringify(r.channels ?? {})}`,
				),
			)
			.catch(() => log(`#${ev.id} ${ev.kind} handler failed`));
	};
	if (!startSubscribe(cfg, onEvent)) startTail(onEvent);
	await new Promise<void>(() => {});
}

// W822: one digest per invocation — launchd com.suspenders.fleet-pulse fires
// this on StartInterval. cwd is __REPO__ (the pinned suspenders checkout), so
// resolveProject lands on the fleet graph; --fleet overrides for manual runs.
async function runPulse(fleetFlag: string | undefined): Promise<void> {
	const cfg = load();
	if (!cfg) {
		log("no notify.yaml — pulse idle");
		return;
	}
	const fleetRoot = fleetFlag
		? resolveProject(fleetFlag).root
		: resolveProject().root;
	const proj = resolveProject(fleetRoot).id;
	const res = await firePulse({
		config: cfg,
		senders: sendersFor(cfg, homedir()),
		store: openStore(),
		project: proj,
		fleetRoot,
		statePath: PULSE_STATE_PATH(),
		// W826: live ledger reads — warm-rate rides the heartbeat, mining
		// offenders are a delta section; both fail soft to absent
		warm: () => fleetWarm(),
		mining: () => readMiningLines(),
		log,
	});
	for (const [c, r] of Object.entries(res.channels)) log(`pulse ${c}: ${r}`);
}

async function sendTest(channel: string | null): Promise<number> {
	const cfg = load();
	if (!cfg) {
		log("no notify.yaml");
		return 1;
	}
	const senders = sendersFor(cfg, homedir());
	const names = (channel ? [channel] : Object.keys(senders)) as ChannelName[];
	let bad = 0;
	for (const c of names) {
		try {
			const s = senders[c];
			if (!s) throw new Error("channel not configured");
			await s({
				cls: "need-decision",
				key: "test",
				title: "[fleet] notify test",
				body: "notify.ts test notification",
			});
			log(`${c}: ok`);
		} catch (e) {
			bad++;
			log(`${c}: ${e instanceof Error ? e.message : e}`);
		}
	}
	return bad ? 1 : 0;
}

if (import.meta.main) {
	await runCli({
		prog: "notify",
		about: "notify — W695.2 board-event fan-out to desktop/email/Slack.",
		verbs: [
			defineVerb({
				name: "run",
				usage: "usage: notify [run] — resident subscribe daemon",
				run: () => run(),
			}),
			defineVerb({
				name: "test",
				usage: "usage: notify test [--channel desktop|email|slack]",
				flags: ["--channel"],
				run: (p) => sendTest(p.flag("--channel")),
			}),
			defineVerb({
				name: "pulse",
				usage:
					"usage: notify pulse [--fleet <dir>] — periodic fleet digest (launchd fleet-pulse)",
				flags: ["--fleet"],
				run: (p) => runPulse(p.flag("--fleet")),
			}),
			defineVerb({
				name: "check",
				usage: "usage: notify check — resolved config + live channels",
				run: () => {
					const cfg = load();
					const ch = cfg ? Object.keys(sendersFor(cfg, homedir())) : [];
					console.log(JSON.stringify({ configured: !!cfg, channels: ch }));
				},
			}),
		],
		defaultVerb: "run",
	});
}
