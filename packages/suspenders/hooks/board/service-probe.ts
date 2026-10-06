// hooks/board/service-probe.ts — W273: probe every monitored fleet service
// named in the recovery map. Classification is honest and small:
//   up       — configured check answered with HTTP 2xx
//   degraded — reachable but configured check failed (including redirects), agent
//              loaded but not running)
//   down     — nothing answered / agent not loaded
// Deps are injectable so tests drive it with stub probe results.
import {
	PROBED_SERVICES,
	type RecoveryEntry,
	recoveryFor,
} from "../lib/recovery-map.ts";
import { scrub } from "../lib/servicemon.ts";
import { observation, type Observation } from "../lib/observation.ts";
import {
	onDemandIdleObservation,
	readSupervisorSnapshot,
} from "./supervisor-snapshot.ts";

export type ServiceState = "up" | "degraded" | "down" | "idle";

export interface ServiceProbe {
	id: string;
	name: string;
	port: number;
	up: boolean;
	state: ServiceState;
	detail: string;
	probed_at: string;
	observation?: Observation;
}

export interface ProbeDeps {
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	// launchctl print gui/<uid>/<label> → exit code + stdout
	launchctl: (label: string) => Promise<{ code: number; out: string }>;
	now: () => Date;
	readSupervisor?: () => unknown;
}

const realLaunchctl = async (
	label: string,
): Promise<{ code: number; out: string }> => {
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	const p = Bun.spawn(["launchctl", "print", `gui/${uid}/${label}`], {
		stdout: "pipe",
		stderr: "ignore",
	});
	const out = await new Response(p.stdout).text();
	return { code: await p.exited, out };
};

export const realDeps: ProbeDeps = {
	fetch: (url, init) => fetch(url, init),
	launchctl: realLaunchctl,
	now: () => new Date(),
	readSupervisor: readSupervisorSnapshot,
};

const httpDetail = async (r: Response): Promise<string> => {
	const base = `HTTP ${r.status}`;
	try {
		const j = (await r.json()) as {
			uptime_s?: number;
			requests?: { total?: number };
		};
		if (typeof j?.uptime_s === "number")
			return `${base} · uptime ${Math.round(j.uptime_s)}s · ${j.requests?.total ?? 0} req`;
	} catch {}
	return base;
};

const probeOne = async (
	e: RecoveryEntry,
	deps: ProbeDeps,
): Promise<Omit<ServiceProbe, "id" | "name" | "probed_at">> => {
	const p = e.probe;
	if (p.kind === "launchd") {
		try {
			const { code, out } = await deps.launchctl(p.label);
			if (code !== 0)
				return {
					port: 0,
					up: false,
					state: "down",
					detail: `launchd agent ${p.label} not loaded`,
				};
			const st = out.match(/^\s*state = (\S+)/m)?.[1] ?? "unknown";
			const pid = out.match(/^\s*pid = (\d+)/m)?.[1];
			const last = out.match(/^\s*last exit code = (.+)$/m)?.[1]?.trim();
			if (st === "running")
				return {
					port: 0,
					up: true,
					state: "up",
					detail: `running${pid ? ` · pid ${pid}` : ""}`,
				};
			return {
				port: 0,
				up: false,
				state: "degraded",
				detail: `loaded but ${st}${last ? ` · last exit ${last}` : ""}`,
			};
		} catch (err) {
			return {
				port: 0,
				up: false,
				state: "down",
				detail: `launchctl failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}
	try {
		const r = await deps.fetch(`http://127.0.0.1:${p.port}${p.path}`, {
			signal: AbortSignal.timeout(1500),
			redirect: "manual",
		});
		const detail = await httpDetail(r);
		if (!r.ok)
			return {
				port: p.port,
				up: false,
				state: "degraded",
				detail: `${detail} · reachable, configured check failed`,
			};
		return { port: p.port, up: true, state: "up", detail };
	} catch (err) {
		const idleEvidence = onDemandIdleObservation(
			deps.readSupervisor?.(),
			p.port,
			deps.now().getTime(),
		);
		if (idleEvidence)
			return {
				port: p.port,
				up: false,
				state: "idle",
				observation: idleEvidence,
				detail:
					"On demand · not loaded; fresh supervisor probes confirm expected idle",
			};
		return {
			port: p.port,
			up: false,
			state: "down",
			detail: err instanceof Error ? err.message.slice(0, 80) : "unreachable",
		};
	}
};

export const probeService = async (
	id: string,
	deps: ProbeDeps = realDeps,
): Promise<ServiceProbe | null> => {
	const e = recoveryFor(id);
	if (!e) return null;
	const r = await probeOne(e, deps);
	const now = deps.now();
	const target =
		e.probe.kind === "http"
			? `http://127.0.0.1:${e.probe.port}${e.probe.path}`
			: e.probe.label;
	return {
		id: e.id,
		name: e.name,
		...r,
		detail: scrub(r.detail),
		probed_at: now.toISOString(),
		observation:
			r.observation ??
			observation(
				e.probe.kind === "http" ? "board-network-probe" : "launchctl",
				target,
				"local-machine",
				now.getTime(),
				30_000,
				e.probe.kind === "http" ? "http-check" : "process",
			),
	};
};

export const probeAll = async (
	deps: ProbeDeps = realDeps,
): Promise<ServiceProbe[]> =>
	(
		await Promise.all(PROBED_SERVICES.map((id) => probeService(id, deps)))
	).filter((p): p is ServiceProbe => p !== null);

// the wire shape for the board: probe result + its recovery entry
export const withRecovery = (
	p: ServiceProbe,
): ServiceProbe & { recovery: RecoveryEntry | null } => ({
	...p,
	recovery: recoveryFor(p.id),
});
