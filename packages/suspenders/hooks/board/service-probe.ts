// hooks/board/service-probe.ts — W273: probe every monitored fleet service
// named in the recovery map. Classification is honest and small:
//   up       — answered (<500; the :4000 shim answers 404 on unknown paths)
//   degraded — the process is there but failing (HTTP 5xx, launchd agent
//              loaded but not running)
//   down     — nothing answered / agent not loaded
// Deps are injectable so tests drive it with stub probe results.
import {
	PROBED_SERVICES,
	type RecoveryEntry,
	recoveryFor,
} from "../lib/recovery-map.ts";
import { scrub } from "../lib/servicemon.ts";

export type ServiceState = "up" | "degraded" | "down";

export interface ServiceProbe {
	id: string;
	name: string;
	port: number;
	up: boolean;
	state: ServiceState;
	detail: string;
	probed_at: string;
}

export interface ProbeDeps {
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	// launchctl print gui/<uid>/<label> → exit code + stdout
	launchctl: (label: string) => Promise<{ code: number; out: string }>;
	now: () => Date;
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
		});
		const detail = await httpDetail(r);
		if (r.status >= 500)
			return { port: p.port, up: false, state: "degraded", detail };
		return { port: p.port, up: true, state: "up", detail };
	} catch (err) {
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
	return {
		id: e.id,
		name: e.name,
		...r,
		detail: scrub(r.detail),
		probed_at: deps.now().toISOString(),
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
