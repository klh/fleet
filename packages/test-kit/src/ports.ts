// src/ports.ts — freePort() + waitUp() (W1135.1.3): the audited loopback
// port-reservation and 100x100ms readiness-poll idioms, verbatim
// (test/profile.test.ts freePort; test/helpers/board-fixture.ts waitUp).

/** Bun types Server.port as optional (unix-socket servers have none); a TCP
 *  bind always reports one, so absence is a broken invariant — throw. */
export const boundPort = (p: number | undefined): number => {
	if (p === undefined) throw new Error("boundPort: server bound no TCP port");
	return p;
};

export const freePort = async (): Promise<number> => {
	const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const p = boundPort(s.port);
	s.stop(true);
	return p;
};

/** Sync variant for module-scope const initializers that cannot await
 *  (the unusedPort idiom — test/helpers/board-fixture.ts, verbatim). */
export const freePortSync = (): number => {
	const s = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(),
	});
	const p = boundPort(s.port);
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
