// admission.ts — per-port in-flight bound for the router shim. rapid-mlx
// batches internally, but unbounded concurrency on one port pushes unified
// memory into swap; past the cap the shim answers 429 + Retry-After so the
// gateway ladder falls through to its next hop instead of queueing blindly.
// W504: caps are PER PROVIDER — registry rows carry `maxInflight` for the
// big backends, BELT_PORT_CAPS ("8903:1,8901:2") overrides per port.

export const DEFAULT_MAX_INFLIGHT = 4;
export const DEFAULT_RETRY_AFTER_S = 2;

const envInt = (v: string | undefined, dflt: number): number => {
	const n = Number(v);
	return Number.isInteger(n) && n > 0 ? n : dflt;
};

/** Parse a "8903:2,8901:3" caps table; malformed/zero entries are dropped,
 *  never fatal — a bad knob must not take the router down. */
export function parsePortCaps(v: string | undefined): Record<number, number> {
	const out: Record<number, number> = {};
	for (const part of (v ?? "").split(",")) {
		const m = part.trim().match(/^(\d{2,5}):(\d{1,3})$/);
		if (!m) continue;
		const cap = Number(m[2]);
		if (cap >= 1) out[Number(m[1])] = cap;
	}
	return out;
}

export interface Admission {
	/** Take a slot on `port`; returns a release fn, or null when full. */
	tryAcquire(port: number): (() => void) | null;
	inflight(port: number): number;
	/** Effective cap for `port`: per-port override, else the global max. */
	capOf(port: number): number;
	readonly max: number;
	readonly retryAfterS: number;
}

export function createAdmission(
	max = envInt(process.env.BELT_MAX_INFLIGHT, DEFAULT_MAX_INFLIGHT),
	retryAfterS = envInt(process.env.BELT_RETRY_AFTER_S, DEFAULT_RETRY_AFTER_S),
	caps: Record<number, number> = parsePortCaps(process.env.BELT_PORT_CAPS),
): Admission {
	const counts = new Map<number, number>();
	return {
		max,
		retryAfterS,
		inflight: (port) => counts.get(port) ?? 0,
		capOf: (port) => caps[port] ?? max,
		tryAcquire(port) {
			const n = counts.get(port) ?? 0;
			if (n >= (caps[port] ?? max)) return null;
			counts.set(port, n + 1);
			let released = false;
			return () => {
				if (released) return;
				released = true;
				const left = (counts.get(port) ?? 1) - 1;
				if (left > 0) counts.set(port, left);
				else counts.delete(port);
			};
		},
	};
}

/** Anthropic-shaped overload error with the Retry-After header. */
export function overloaded(port: number, a: Admission): Response {
	return Response.json(
		{
			type: "error",
			error: {
				type: "overloaded_error",
				message: `router: :${port} at max in-flight (${a.capOf(port)}); retry after ${a.retryAfterS}s`,
			},
		},
		{ status: 429, headers: { "retry-after": String(a.retryAfterS) } },
	);
}

/** Run `fn` holding a slot on `port`; 429 when the port is full. */
export async function admit(
	a: Admission,
	port: number,
	fn: () => Promise<Response>,
): Promise<Response> {
	const release = a.tryAcquire(port);
	if (!release) return overloaded(port, a);
	try {
		return await fn();
	} finally {
		release();
	}
}
