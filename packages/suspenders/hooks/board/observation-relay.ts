import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { GovernorStore } from "../lib/govdb.ts";
import {
	laneObservationSnapshot,
	type LaneObservation,
} from "./lane-observations.ts";

interface RelayTarget {
	url: string;
	writeTokenFile: string;
	hubId?: string;
}
interface RelayConfig {
	localHub: string;
	targets: RelayTarget[];
}
export interface RelayStatus {
	enabled: boolean;
	busy: boolean;
	localHub: string | null;
	lastAttemptAt: number | null;
	lastSuccessAt: number | null;
	sent: number;
	failed: number;
	backlog: number;
	nextRetryAt: number | null;
	lastError: string | null;
}
const disabled = (): RelayStatus => ({
	enabled: false,
	busy: false,
	localHub: null,
	lastAttemptAt: null,
	lastSuccessAt: null,
	sent: 0,
	failed: 0,
	backlog: 0,
	nextRetryAt: null,
	lastError: null,
});
let currentStatus = disabled();
export function getObservationRelayStatus(): RelayStatus {
	return { ...currentStatus };
}

function identity(value: unknown): value is string {
	return (
		typeof value === "string" &&
		!!value.trim() &&
		value.length <= 128 &&
		!["all", "unknown"].includes(value) &&
		![...value].some(
			(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
		)
	);
}

/** No secrets in configuration: only operator identity and token file paths. */
export function readRelayConfig(path: string): RelayConfig | null {
	let body: string;
	try {
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > 32_768 || (stat.mode & 0o777) !== 0o600)
			throw new Error("Invalid relay configuration");
		body = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new Error("Unable to read relay configuration");
	}
	let input: unknown;
	try {
		input = JSON.parse(body);
	} catch {
		throw new Error("Invalid relay configuration");
	}
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new Error("Invalid relay configuration");
	const config = input as Record<string, unknown>;
	if (
		!identity(config.localHub) ||
		!Array.isArray(config.targets) ||
		config.targets.length > 8
	)
		throw new Error("Invalid relay configuration");
	const targets: RelayTarget[] = config.targets.map((value: unknown) => {
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("Invalid relay target");
		const target = value as Record<string, unknown>;
		if (
			typeof target.url !== "string" ||
			target.url.length > 2048 ||
			typeof target.writeTokenFile !== "string" ||
			target.writeTokenFile.length > 1024 ||
			!isAbsolute(target.writeTokenFile) ||
			(target.hubId !== undefined && !identity(target.hubId))
		)
			throw new Error("Invalid relay target");
		let url: URL;
		try {
			url = new URL(target.url);
		} catch {
			throw new Error("Invalid relay target");
		}
		if (
			url.protocol === "http:" &&
			!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
		)
			throw new Error("Remote relay targets require HTTPS");
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== "/"
		)
			throw new Error("Invalid relay target");
		return {
			url: url.origin,
			writeTokenFile: target.writeTokenFile,
			...(typeof target.hubId === "string" ? { hubId: target.hubId } : {}),
		};
	});
	if (new Set(targets.map((target) => target.url)).size !== targets.length)
		throw new Error("Duplicate relay targets");
	return { localHub: config.localHub, targets };
}

function readWriteToken(path: string): string {
	const stat = statSync(path);
	if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096)
		throw new Error("Token file must be private mode 600");
	const token = readFileSync(path, "utf8").trim();
	if (!token || /\s/.test(token)) throw new Error("Invalid token file");
	return token;
}

/** Local registration supplies activity; remote rows stay observation-only. */
export function relayCandidates(
	db: GovernorStore,
	localHub: string,
	now: number,
): LaneObservation[] {
	const local = db
		.query(
			`SELECT sid, project, hb FROM sessions WHERE hb <= ? AND hb > ? AND project IS NOT NULL AND state NOT IN ('CLOSED', 'IDLE', 'ZOMBIE') ORDER BY hb DESC, sid LIMIT 1000`,
		)
		.all(now + 5000, now - 300_000) as {
		sid: string;
		project: string;
		hb: number;
	}[];
	const own = local.map((session) => ({
		laneId: session.sid,
		project: session.project,
		originHub: localHub,
		peerHub: localHub,
		observedAt: session.hb,
		expiresAt: session.hb + 300_000,
		visitedHubs: [localHub],
	}));
	const remote = laneObservationSnapshot(db, null, now)
		.lanes.filter(
			(lane) =>
				!(lane.visitedHubs || []).includes(localHub) &&
				(lane.visitedHubs || []).length < 16 &&
				Math.min(lane.expiresAt, lane.observedAt + 300_000) > now,
		)
		.map((lane) => ({
			...lane,
			peerHub: localHub,
			expiresAt: Math.min(lane.expiresAt, lane.observedAt + 300_000),
			visitedHubs: [...(lane.visitedHubs || []), localHub],
		}));
	const deduped = new Map<string, LaneObservation>();
	for (const lane of [...own, ...remote]) {
		const key = JSON.stringify([lane.laneId, lane.project, lane.originHub]);
		const previous = deduped.get(key);
		if (!previous || lane.observedAt > previous.observedAt)
			deduped.set(key, lane);
	}
	return [...deduped.values()]
		.sort((a, b) => b.observedAt - a.observedAt)
		.slice(0, 1000);
}

interface RelayOptions {
	configPath?: string;
	fetch?: typeof fetch;
	now?: () => number;
	intervalMs?: number;
	autoStart?: boolean;
}

export function startObservationRelay(
	db: GovernorStore,
	options: RelayOptions = {},
) {
	const path =
		options.configPath ??
		process.env.SUSPENDERS_OBSERVATION_RELAYS ??
		join(homedir(), ".config", "klh", "observation-relays.json");
	const request = options.fetch ?? fetch;
	const clock = options.now ?? Date.now;
	const status = disabled();
	currentStatus = status;
	const sent = new Map<string, { signature: string; at: number }>();
	const retries = new Map<
		string,
		{ failures: number; until: number; error: string }
	>();
	let drainTimer: ReturnType<typeof setTimeout> | null = null;
	let batchOffset = 0;
	let stopped = false;
	async function tick(): Promise<void> {
		if (stopped || status.busy) return;
		if (drainTimer) {
			clearTimeout(drainTimer);
			drainTimer = null;
		}
		status.busy = true;
		try {
			const config = readRelayConfig(path);
			status.enabled = !!config && config.targets.length > 0;
			status.localHub = config?.localHub ?? null;
			if (!config || !status.enabled) {
				status.backlog = 0;
				status.nextRetryAt = null;
				status.lastError = null;
				return;
			}
			for (const url of retries.keys())
				if (!config.targets.some((target) => target.url === url))
					retries.delete(url);
			const now = clock();
			status.lastAttemptAt = now;
			const candidates = relayCandidates(db, config.localHub, now);
			const eligible: {
				target: RelayTarget;
				lane: LaneObservation;
				key: string;
				signature: string;
			}[] = [];
			for (const lane of candidates)
				for (const target of config.targets) {
					if (target.hubId && (lane.visitedHubs || []).includes(target.hubId))
						continue;
					const key = JSON.stringify([
						target.url,
						lane.laneId,
						lane.project,
						lane.originHub,
					]);
					const signature = JSON.stringify(lane);
					const previous = sent.get(key);
					if (
						!previous ||
						previous.signature !== signature ||
						now - previous.at >= 30_000
					)
						eligible.push({ target, lane, key, signature });
				}
			const runnable = eligible.filter(
				(job) => (retries.get(job.target.url)?.until ?? 0) <= now,
			);
			const start = runnable.length ? batchOffset % runnable.length : 0;
			const jobs = [
				...runnable.slice(start),
				...runnable.slice(0, start),
			].slice(0, 100);
			batchOffset = runnable.length
				? (start + jobs.length) % runnable.length
				: 0;
			const failedTargets = new Set<string>();
			const fail = (url: string, error: string) => {
				status.failed++;
				if (failedTargets.has(url)) return;
				failedTargets.add(url);
				const failures = (retries.get(url)?.failures ?? 0) + 1;
				retries.set(url, {
					failures,
					until:
						clock() + Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5)),
					error,
				});
			};
			let cursor = 0;
			await Promise.all(
				Array.from({ length: Math.min(4, jobs.length) }, async () => {
					while (cursor < jobs.length && !stopped) {
						const job = jobs[cursor++];
						if ((retries.get(job.target.url)?.until ?? 0) > clock()) continue;
						try {
							const token = readWriteToken(job.target.writeTokenFile);
							const response = await request(
								`${job.target.url}/api/lane-observations`,
								{
									method: "POST",
									headers: {
										"content-type": "application/json",
										"x-klh-write-token": token,
									},
									body: JSON.stringify(job.lane),
									signal: AbortSignal.timeout(3000),
									redirect: "error",
								},
							);
							await response.body?.cancel();
							if (!response.ok) {
								fail(job.target.url, `Relay rejected: HTTP ${response.status}`);
								continue;
							}
							sent.delete(job.key);
							sent.set(job.key, { signature: job.signature, at: now });
							while (sent.size > 8000) {
								const oldest = sent.keys().next().value;
								if (oldest !== undefined) sent.delete(oldest);
							}
							status.sent++;
							status.lastSuccessAt = clock();
							if (!failedTargets.has(job.target.url))
								retries.delete(job.target.url);
						} catch {
							fail(
								job.target.url,
								"Relay request or private token file unavailable",
							);
						}
					}
				}),
			);
			const remaining = eligible.filter(
				(job) =>
					sent.get(job.key)?.signature !== job.signature ||
					(sent.get(job.key)?.at ?? 0) < now - 30_000,
			);
			status.backlog = remaining.length;
			const blocked = remaining
				.map((job) => retries.get(job.target.url))
				.filter((retry) => !!retry && retry.until > clock());
			status.nextRetryAt = blocked.length
				? Math.min(...blocked.map((retry) => retry?.until ?? Infinity))
				: null;
			status.lastError = blocked[0]?.error ?? null;
			if (remaining.length && !stopped) {
				const delay = remaining.some(
					(job) => (retries.get(job.target.url)?.until ?? 0) <= clock(),
				)
					? 0
					: Math.max(1, (status.nextRetryAt ?? clock() + 1000) - clock());
				drainTimer = setTimeout(() => {
					drainTimer = null;
					void tick();
				}, delay);
				drainTimer.unref();
			}
		} catch {
			status.enabled = false;
			status.lastError = "Relay configuration or local evidence unavailable";
		} finally {
			status.busy = false;
		}
	}
	const interval = Math.min(
		30_000,
		Math.max(1000, options.intervalMs ?? 10_000),
	);
	const timer =
		options.autoStart === false
			? null
			: setInterval(() => {
					void tick();
				}, interval);
	timer?.unref();
	if (options.autoStart !== false) void tick();
	return {
		tick,
		status: (): RelayStatus => ({ ...status }),
		stop: () => {
			stopped = true;
			if (timer) clearInterval(timer);
			if (drainTimer) clearTimeout(drainTimer);
		},
	};
}
