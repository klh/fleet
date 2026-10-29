// hooks/lib/notify.ts — W695.2: notification fan-out core. Board-only bus
// events (NEED_DECISION, budget exhaustion, hub-down, lane-death) are mapped
// to a notification class, deduped, rate-limited per class, scrubbed and
// handed to channel adapters (notify-adapters.ts). Config is machine-level
// (~/.config/klh/notify.json, KLH_NOTIFY overrides) — the repo carries only
// examples/notify.example.json. Pure + injectable: no I/O except the loader.
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonConfEither } from "./kernel-conf.ts";
import { scrubRules } from "./scrub.ts";

export type NotifyClass =
	| "need-decision"
	| "budget"
	| "hub-down"
	| "lane-death"
	| "pulse";
export type ChannelName = "desktop" | "email" | "slack";

/** bus kind → notification class (the event source contract) */
export const KIND_CLASS: Record<string, NotifyClass> = {
	NEED_DECISION: "need-decision",
	"quota.exhausted": "budget",
	"credit.headroom.warn": "budget",
	"hub.down": "hub-down",
	"lane.dead": "lane-death",
};

export interface ClassPolicy {
	channels: ChannelName[];
	/** identical (class,key) suppressed inside this window */
	dedupe_s: number;
	/** at most `max` notifications per class per `per_s` window */
	rate_limit: { max: number; per_s: number };
}

export interface NotifyConfig {
	/** sid the subscription binds as — set to the coordinator sid to also
	 *  receive events directed at it (default: untargeted events only) */
	as: string;
	/** W822 fleet-pulse cadence — launchd StartInterval seconds; the
	 *  services.yaml default is overridden at render time (config-over-code) */
	pulse: { interval_s: number };
	channels: {
		desktop?: { enabled?: boolean };
		slack?: { webhook_url?: string; webhook_url_file?: string };
		email?: {
			env_file?: string;
			user_var?: string;
			pass_var?: string;
			from?: string;
			to?: string[];
			host?: string;
			port?: number;
		};
	};
	classes: Record<NotifyClass, ClassPolicy>;
}

const DEFAULT_POLICY: ClassPolicy = {
	channels: ["desktop"],
	dedupe_s: 3600,
	rate_limit: { max: 6, per_s: 3600 },
};

/** W822 fleet-pulse default cadence (4h) — notify.json pulse.interval_s wins. */
export const DEFAULT_PULSE_INTERVAL_S = 14400;

export const NOTIFY_PATH = (): string =>
	process.env.KLH_NOTIFY ?? join(homedir(), ".config", "klh", "notify.json");

const CLASSES: NotifyClass[] = [
	"need-decision",
	"budget",
	"hub-down",
	"lane-death",
	"pulse",
];

// positive-integer or default — a bad pulse.interval_s never breaks render
const pulseIntervalOf = (v: unknown): number =>
	typeof v === "number" && Number.isInteger(v) && v > 0
		? v
		: DEFAULT_PULSE_INTERVAL_S;

/** Merge a parsed yaml doc over the defaults; unknown keys ignored. */
export function normalizeConfig(raw: unknown): NotifyConfig {
	const r = (raw ?? {}) as Partial<NotifyConfig>;
	const pulseRaw = (r.pulse ?? {}) as { interval_s?: unknown };
	const classes = {} as Record<NotifyClass, ClassPolicy>;
	for (const c of CLASSES) {
		const o = (r.classes?.[c] ?? {}) as Partial<ClassPolicy>;
		classes[c] = {
			channels: o.channels ?? DEFAULT_POLICY.channels,
			dedupe_s: o.dedupe_s ?? DEFAULT_POLICY.dedupe_s,
			rate_limit: { ...DEFAULT_POLICY.rate_limit, ...(o.rate_limit ?? {}) },
		};
	}
	return {
		as: r.as ?? "notify",
		pulse: { interval_s: pulseIntervalOf(pulseRaw.interval_s) },
		channels: r.channels ?? {},
		classes,
	};
}

/** null when no notify.json exists — the daemon idles, never errors. */
export function loadNotifyConfig(
	path: string = NOTIFY_PATH(),
): NotifyConfig | null {
	let raw: unknown;
	try {
		raw = readJsonConfEither(path);
	} catch {
		return null;
	}
	return normalizeConfig(raw);
}

export interface BusEvent {
	id: number;
	ts: number;
	source: string;
	kind: string;
	scope: string | null;
	payload: string | null;
}

export interface Notification {
	cls: NotifyClass;
	key: string;
	title: string;
	body: string;
}

const payloadOf = (ev: BusEvent): Record<string, unknown> => {
	try {
		return ev.payload
			? (JSON.parse(ev.payload) as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
};

/** Mask key material + home paths before anything leaves the machine. */
export function scrubOutbound(text: string): string {
	let out = text;
	// rules carry /g regexes; denylist rules (machine-local) ride along
	for (const r of scrubRules()) out = out.replace(r.re, "[redacted]");
	return out.replace(/\/Users\/[^/\s'"]+/g, "~");
}

/** Event → notification (null = not a notify kind). Dedupe key = class +
 *  the subject (work item scope, else sid/target, else the note itself). */
export function classify(ev: BusEvent): Notification | null {
	const cls = KIND_CLASS[ev.kind];
	if (!cls) return null;
	const p = payloadOf(ev);
	const note = String(p.note ?? p.reason ?? p.detail ?? "").trim();
	const subject = String(
		ev.scope ?? p.sid ?? p.target ?? (note.slice(0, 80) || ev.source),
	);
	const title = `[fleet] ${ev.kind} ${subject}`;
	const body = scrubOutbound(note || `${ev.kind} from ${ev.source}`);
	return {
		cls,
		key: `${cls}:${ev.kind}:${subject}`,
		title: scrubOutbound(title),
		body,
	};
}

export type Sender = (n: Notification) => Promise<void>;

export interface NotifyResult {
	status: "sent" | "ignored" | "deduped" | "rate-limited" | "no-channel";
	channels?: Record<string, "ok" | string>;
}

export interface NotifierDeps {
	config: NotifyConfig;
	/** one sender per configured channel; absent channel = skipped + counted */
	senders: Partial<Record<ChannelName, Sender>>;
	now?: () => number;
}

/** Stateful (in-memory) dedupe + per-class sliding-window rate limit. A
 *  failing channel is isolated: its error lands in the result, the others
 *  still deliver, and nothing throws into the subscribe loop. */
export function createNotifier(deps: NotifierDeps) {
	const now = deps.now ?? Date.now;
	const lastSent = new Map<string, number>();
	const windows = new Map<NotifyClass, number[]>();
	const stats = { sent: 0, deduped: 0, rateLimited: 0, skipped: 0 };
	async function handle(ev: BusEvent): Promise<NotifyResult> {
		const n = classify(ev);
		if (!n) return { status: "ignored" };
		const policy = deps.config.classes[n.cls];
		const t = now();
		const prev = lastSent.get(n.key);
		if (prev !== undefined && t - prev < policy.dedupe_s * 1000) {
			stats.deduped++;
			return { status: "deduped" };
		}
		const { max, per_s } = policy.rate_limit;
		const win = (windows.get(n.cls) ?? []).filter((x) => t - x < per_s * 1000);
		windows.set(n.cls, win);
		if (win.length >= max) {
			stats.rateLimited++;
			return { status: "rate-limited" };
		}
		const active = policy.channels.filter((c) => deps.senders[c]);
		stats.skipped += policy.channels.length - active.length;
		if (!active.length) return { status: "no-channel" };
		win.push(t);
		lastSent.set(n.key, t);
		const channels: Record<string, string> = {};
		await Promise.all(
			active.map(async (c) => {
				try {
					await deps.senders[c]?.(n);
					channels[c] = "ok";
				} catch (e) {
					channels[c] = e instanceof Error ? e.message : String(e);
				}
			}),
		);
		stats.sent++;
		return { status: "sent", channels };
	}
	return { handle, stats };
}

/** kinds the subscribe filter needs (server-side narrowing). */
export const subscribedKinds = (): string[] => Object.keys(KIND_CLASS);
