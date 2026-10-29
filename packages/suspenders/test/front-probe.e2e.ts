// test/front-probe.test.ts — W1124.43: the attributable buckle-front probe.
// Real-HTTP cases for every verdict kind (slow status / unreachable / auth
// / abort) plus the configured bound and the preserved `string | null`
// contract. Real sockets on 127.0.0.1 ephemeral ports — no stub fetch.
import { expect, test } from "./pw";
import {
	frontTimeoutBound,
	probeBuckleFront,
	probeBuckleFrontVerdict,
} from "../hooks/lib/board/front-probe.ts";
import { probeBuckleFront as laneProbe } from "../hooks/lib/lanes/lane.ts";
import { probeFrontDecision } from "../scripts/lib/governance-decide.ts";

/** One real server on an ephemeral loopback port; returns its base URL and
 *  a stop that closes live connections (finally-safe). */
const serve = (
	handler: (req: Request) => Response | Promise<Response>,
): { url: string; stop: () => void } => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: handler,
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		stop: () => server.stop(true),
	};
};

/** Run one probe with SUSPENDERS_BUCKLE_FRONT_TIMEOUT_MS set, restoring the
 *  env var afterwards (assertions run before the restore). */
const withBound = async (
	bound: string,
	run: (boundMs: number) => Promise<void>,
): Promise<void> => {
	const prev = process.env.SUSPENDERS_BUCKLE_FRONT_TIMEOUT_MS;
	process.env.SUSPENDERS_BUCKLE_FRONT_TIMEOUT_MS = bound;
	try {
		await run(frontTimeoutBound());
	} finally {
		if (prev === undefined)
			delete process.env.SUSPENDERS_BUCKLE_FRONT_TIMEOUT_MS;
		else process.env.SUSPENDERS_BUCKLE_FRONT_TIMEOUT_MS = prev;
	}
};

test.describe("frontTimeoutBound (configured bound)", () => {
	test("unset env = 600 (the W1 default, no blanket raise)", () => {
		const prev = process.env.SUSPENDERS_BUCKLE_FRONT_TIMEOUT_MS;
		delete process.env.SUSPENDERS_BUCKLE_FRONT_TIMEOUT_MS;
		try {
			expect(frontTimeoutBound()).toBe(600);
		} finally {
			if (prev !== undefined)
				process.env.SUSPENDERS_BUCKLE_FRONT_TIMEOUT_MS = prev;
		}
	});

	test("numeric env rides, clamped into 100..10000; garbage falls back", () => {
		const cases: Array<[string, number]> = [
			["1200", 1200],
			["50", 100],
			["99999", 10_000],
			["250.7", 251],
			["abc", 600],
			["", 600],
			[" 800 ", 800],
		];
		const prev = process.env.SUSPENDERS_BUCKLE_FRONT_TIMEOUT_MS;
		try {
			for (const [raw, want] of cases) {
				process.env.SUSPENDERS_BUCKLE_FRONT_TIMEOUT_MS = raw;
				expect(frontTimeoutBound()).toBe(want);
			}
		} finally {
			if (prev === undefined)
				delete process.env.SUSPENDERS_BUCKLE_FRONT_TIMEOUT_MS;
			else process.env.SUSPENDERS_BUCKLE_FRONT_TIMEOUT_MS = prev;
		}
	});
});

test.describe("probeBuckleFrontVerdict (real HTTP)", () => {
	test("ok: a 2xx /status answers the front URL inside the bound", async () => {
		const s = serve(() => new Response('{"ok":true}', { status: 200 }));
		try {
			const v = await probeBuckleFrontVerdict(s.url);
			expect(v.ok).toBe(true);
			expect(v.kind).toBe("ok");
			expect(v.front).toBe(s.url);
			expect(v.status).toBe(200);
			expect(v.ms).toBeGreaterThanOrEqual(0);
			expect(v.note).toBe("");
		} finally {
			s.stop();
		}
	}, 10_000);

	test("slow status: a front slower than the bound = timeout, attributed to the bound", async () => {
		await withBound("100", async (boundMs) => {
			const s = serve(async () => {
				await Bun.sleep(400);
				return new Response(null, { status: 200 });
			});
			try {
				const v = await probeBuckleFrontVerdict(s.url);
				expect(v.ok).toBe(false);
				expect(v.kind).toBe("timeout");
				expect(v.front).toBeNull();
				expect(v.ms).toBeGreaterThanOrEqual(boundMs);
				expect(v.note).toContain(`bound ${boundMs}ms`);
			} finally {
				s.stop();
			}
		});
	}, 10_000);

	test("unreachable: a refused connection = unreachable, not timeout", async () => {
		const s = serve(() => new Response("gone"));
		const port = new URL(s.url).port;
		s.stop();
		const v = await probeBuckleFrontVerdict(`http://127.0.0.1:${port}`);
		expect(v.ok).toBe(false);
		expect(v.kind).toBe("unreachable");
		expect(v.status).toBe(0);
		expect(v.note).toContain("unreachable");
	}, 10_000);

	test("auth: a 401 /status is a status answer — the front IS up", async () => {
		const s = serve(() => new Response("denied", { status: 401 }));
		try {
			const v = await probeBuckleFrontVerdict(s.url);
			expect(v.ok).toBe(false);
			expect(v.kind).toBe("status");
			expect(v.status).toBe(401);
			expect(v.front).toBeNull();
			expect(v.note).toContain("HTTP 401");
		} finally {
			s.stop();
		}
	}, 10_000);

	test("abort: a caller signal cancels the probe without miscounting as timeout", async () => {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), 50);
		const s = serve(async () => {
			await Bun.sleep(5_000);
			return new Response(null, { status: 200 });
		});
		try {
			const v = await probeBuckleFrontVerdict(s.url, ac.signal);
			expect(v.kind).toBe("abort");
			expect(v.ms).toBeLessThan(600);
		} finally {
			clearTimeout(timer);
			s.stop();
		}
	}, 10_000);

	test("redirect: a 30x answer is status, never ok (manual redirect)", async () => {
		const s = serve(
			() => new Response(null, { status: 302, headers: { location: "/x" } }),
		);
		try {
			const v = await probeBuckleFrontVerdict(s.url);
			expect(v.kind).toBe("status");
			expect(v.status).toBe(302);
		} finally {
			s.stop();
		}
	}, 10_000);
});

test.describe("probeBuckleFront (the preserved W1 contract)", () => {
	test("2xx answers the front URL; non-2xx answers null", async () => {
		const up = serve(() => new Response("ok", { status: 200 }));
		try {
			expect(await probeBuckleFront(up.url)).toBe(up.url);
			expect(await laneProbe(up.url)).toBe(up.url);
		} finally {
			up.stop();
		}
		const auth = serve(() => new Response("denied", { status: 401 }));
		try {
			expect(await probeBuckleFront(auth.url)).toBeNull();
		} finally {
			auth.stop();
		}
	}, 10_000);
});

test.describe("probeFrontDecision attribution (W1124.43)", () => {
	test("strict refusal carries the probe verdict note", () => {
		const d = probeFrontDecision(false, "strict", "timeout after 612ms");
		expect(d.mode).toBe("refuse");
		if (d.mode === "refuse")
			expect(d.why).toContain("probe: timeout after 612ms");
	});

	test("solo belt-direct note carries the probe verdict note", () => {
		const d = probeFrontDecision(false, "solo", "HTTP 401 in 3ms");
		expect(d.mode).toBe("belt-direct");
		if (d.mode === "belt-direct")
			expect(d.note).toContain("probe: HTTP 401 in 3ms");
	});

	test("no attribution = the W422.17 wording, byte-unchanged", () => {
		expect(probeFrontDecision(false, "strict").mode).toBe("refuse");
		expect(probeFrontDecision(false, "solo").mode).toBe("belt-direct");
		expect(probeFrontDecision(true, "strict").mode).toBe("ungoverned-override");
	});
});
