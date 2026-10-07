// Observation only: this module never launches, signals or adopts a process.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { connect } from "node:net";
import { endpointPassed } from "./health.ts";
import { observation } from "./observation.ts";

export interface ObservedTarget {
	name: string;
	port: number;
	kind: "router" | "specialist" | "gateway" | "ondemand" | "external";
	owned: boolean;
	healthPath: string;
	probeHeaders?: () => Record<string, string>;
	okStatus?: number[];
}
type Verdict = "up" | "down" | "degraded" | "unknown";
export interface ChildEvidence {
	pid: number | null;
	alive: boolean;
	restarts: number;
}

/** A refused TCP connection proves absence; timeout/error leaves it unknown. */
export async function probeObservedTarget(t: ObservedTarget): Promise<Verdict> {
	const tcp = await new Promise<"connected" | "refused" | "unknown">(
		(resolve) => {
			const socket = connect({ port: t.port, host: "127.0.0.1" });
			const done = (result: "connected" | "refused" | "unknown") => {
				socket.destroy();
				resolve(result);
			};
			socket.setTimeout(2000, () => done("unknown"));
			socket.once("connect", () => done("connected"));
			socket.once("error", (error: NodeJS.ErrnoException) =>
				done(error.code === "ECONNREFUSED" ? "refused" : "unknown"),
			);
		},
	);
	if (tcp !== "connected") return tcp === "refused" ? "down" : "unknown";
	try {
		const response = await fetch(`http://127.0.0.1:${t.port}${t.healthPath}`, {
			headers: t.probeHeaders?.(),
			signal: AbortSignal.timeout(2000),
			redirect: "manual",
		});
		if (t.okStatus) {
			await response.body?.cancel();
			return t.okStatus.includes(response.status) ? "up" : "degraded";
		}
		return (await endpointPassed(response)) ? "up" : "degraded";
	} catch {
		return "unknown";
	}
}

export function serveObserver(
	file: string,
	intervalMs: number,
	probe: (target: ObservedTarget) => Promise<Verdict> = probeObservedTarget,
	now: () => number = Date.now,
) {
	const previous = new Map<
		number,
		{ state: string; since: string; lastOk: string | null }
	>();
	return async (
		targets: ObservedTarget[],
		children: ReadonlyMap<number, ChildEvidence> = new Map(),
	) => {
		const rows = await Promise.all(
			targets.map(async (target) => {
				let verdict: Verdict;
				try {
					verdict = await probe(target);
				} catch {
					verdict = "unknown";
				}
				const stamp = now();
				const child = target.owned ? children.get(target.port) : undefined;
				const state =
					verdict === "down"
						? child?.alive
							? "starting"
							: target.kind === "ondemand"
								? "idle"
								: "down"
						: verdict;
				const old = previous.get(target.port);
				const since =
					old?.state === state ? old.since : new Date(stamp).toISOString();
				const lastOk =
					verdict === "up"
						? new Date(stamp).toISOString()
						: (old?.lastOk ?? null);
				previous.set(target.port, { state, since, lastOk });
				return {
					name: target.name,
					port: target.port,
					kind: target.kind,
					owned: target.owned,
					state,
					since,
					lastOk,
					lastProbe: new Date(stamp).toISOString(),
					alert: state !== "up" && state !== "idle",
					pid: child?.alive ? child.pid : null,
					restarts: child?.restarts ?? null,
					restartsLastWindow: null,
					nextRetryAt: null,
					lastError:
						verdict === "up" ? null : `outside-process probe: ${verdict}`,
					observation: observation(
						"local-llm-serve",
						`127.0.0.1:${target.port}`,
						"local-machine",
						stamp,
						intervalMs * 3,
						"http-check",
					),
				};
			}),
		);
		const stamp = now();
		const doc = {
			version: 1,
			source: "local-llm-serve",
			supervisorPid: process.pid,
			updated: new Date(stamp).toISOString(),
			intervalMs,
			targets: rows,
		};
		mkdirSync(dirname(file), { recursive: true });
		const temporary = `${file}.${process.pid}.next`;
		writeFileSync(temporary, JSON.stringify(doc), { mode: 0o600 });
		renameSync(temporary, file);
		return doc;
	};
}
