// test/helpers/board-fixture-core.ts — W1275.1: the runtime-agnostic kernel
// under test/helpers/board-fixture.ts (bun:test suites) and e2e/harness.ts
// (Playwright GUI specs) — the W1275 fixture-kit dedupe. Deliberately
// bun:test-free: the e2e specs ride @playwright/test on the same module
// graph, and a bun:test import would poison them. Bodies moved verbatim from
// board-fixture.ts / e2e/harness.ts; both faces re-export from here.
// Let the OS choose an unused loopback port; fixed test ports can silently
// attach to a board left by another run and use its unrelated write token.
export function unusedPort(): number {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(),
	});
	const port = server.port;
	server.stop(true);
	return port;
}

// Keep a bounded 16k tail of a spawned board's startup output — the
// did-not-start error carries it. Verbatim move of the drain pair from
// board-fixture.ts / e2e/harness.ts.
export function boardStartupTail(...streams: ReadableStream<Uint8Array>[]): {
	output(): string;
} {
	let output = "";
	const drain = async (stream: ReadableStream<Uint8Array>) => {
		for await (const chunk of stream)
			output = `${output}${new TextDecoder().decode(chunk)}`.slice(-16_384);
	};
	for (const s of streams) void drain(s);
	return {
		output: () => output,
	};
}

// The shared did-the-board-come-up poll — verbatim move of the identical
// loops in board-fixture.ts / e2e/harness.ts (the throw message stays
// per-caller via msg; tries is per-caller too).
export async function waitBoardUp(
	base: string,
	output: () => string,
	msg: (base: string, out: string) => string,
	tries = 100,
): Promise<void> {
	for (let i = 0; i < tries; i++) {
		try {
			if (
				(
					await fetch(`${base}/api/data`, {
						signal: AbortSignal.timeout(500),
					})
				).ok
			)
				return;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(msg(base, output()));
}
