// src/ports.ts — freePort() + waitUp() (W1135.1.3): the audited loopback
// port-reservation and 100x100ms readiness-poll idioms, verbatim
// (test/profile.test.ts freePort; test/helpers/board-fixture.ts waitUp).
export const freePort = async (): Promise<number> => {
	const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const p = s.port;
	s.stop(true);
	return p;
};

export interface WaitUpOpts {
	/** Poll attempts before giving up (default 100). */
	tries?: number;
	/** Sleep between attempts (default 100ms). */
	intervalMs?: number;
}

/** Poll `url` until a fetch answers ok — 100x100ms by default (the audited
 *  readiness idiom), 500ms per-attempt abort. Throws after the last try. */
export async function waitUp(
	url: string,
	opts: WaitUpOpts = {},
): Promise<void> {
	const tries = opts.tries ?? 100;
	const intervalMs = opts.intervalMs ?? 100;
	for (let i = 0; i < tries; i++) {
		try {
			if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return;
		} catch {}
		await Bun.sleep(intervalMs);
	}
	throw new Error(`service did not come up on ${url}`);
}
