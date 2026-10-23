// w851-remotes-bake.test.ts — W851: the dashboard's initial payload carries
// the cached remotes snapshot (board usage-data pattern) and /api/remotes
// serves stale-while-revalidate. Proven against the LIVE server: hub rows
// baked into GET / as `var REMOTES_INIT=`, and a stale cache never blocks a
// poll on dead-host probes (serve stale + background revalidate).
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	freePort,
	scratchWorld,
	serveStub,
	waitUp,
} from "../../test-kit/src/index.ts";

setDefaultTimeout(30_000);

interface RemotesSnap {
	rows: { machine: string; ok: boolean }[];
	ts: string;
}

// OpenAI-shaped upstream the probe + catalog fetches hit instantly.
const stub = serveStub(() => Response.json({ data: [{ id: "qwen2.5:0.5b" }] }));

const { home, env, clean } = scratchWorld({ prefix: "fleet-w851-" });
mkdirSync(join(home, ".claude", "local-llm"), { recursive: true });
writeFileSync(
	join(home, ".claude", "local-llm", "remotes.json"),
	JSON.stringify({
		machines: [
			{
				name: "stubnas",
				host: "127.0.0.1",
				endpoints: [
					{
						port: stub.port,
						protocol: "openai",
						roles: ["general"],
						model: "qwen2.5:0.5b",
					},
				],
			},
		],
	}),
);

const port = await freePort();
const proc = Bun.spawn(
	[process.execPath, resolve(import.meta.dir, "../bin/dashboard.ts")],
	{
		env: {
			...env,
			BELT_PORT: String(port),
			// W155.3: scratch boots never pkill or re-advertise the live mdns face
			BELT_MDNS: "off",
			// W851: shrink the SWR window so the test can cross the TTL
			BELT_REMOTES_TTL_MS: "100",
		},
		stdout: "ignore",
		stderr: "ignore",
	},
);
const base = `http://127.0.0.1:${port}`;

async function waitReady(): Promise<void> {
	try {
		await waitUp(`${base}/health`, { tries: 100, intervalMs: 20 });
	} catch {
		throw new Error("dashboard failed to start");
	}
}

test("initial payload bakes the cached remotes snapshot (hub state at load)", async () => {
	await waitReady();
	// warm the cache through the public surface (cold call blocks on build)
	const first = (await (
		await fetch(`${base}/api/remotes`)
	).json()) as RemotesSnap;
	expect(first.rows.map((r) => r.machine)).toContain("stubnas");
	const page = await (await fetch(`${base}/`)).text();
	const m = page.match(/var REMOTES_INIT=(\{.*\});\n/);
	expect(m).not.toBeNull();
	if (!m) return;
	const baked = JSON.parse(m[1]) as RemotesSnap;
	expect(baked.ts).toBe(first.ts);
	expect(baked.rows.map((r) => r.machine)).toContain("stubnas");
});

test("stale cache serves instantly, background rebuild revalidates (SWR)", async () => {
	const snap1 = (await (
		await fetch(`${base}/api/remotes`)
	).json()) as RemotesSnap;
	await Bun.sleep(300); // TTL is 100ms — the cache is now stale
	const t0 = Date.now();
	const res = await fetch(`${base}/api/remotes`);
	const snap2 = (await res.json()) as RemotesSnap;
	// serve-stale: the response IS the old snapshot and it did not wait for
	// the rebuild (buildRemotes pays ~3s in dns-sd discovery alone)
	expect(snap2.ts).toBe(snap1.ts);
	expect(Date.now() - t0).toBeLessThan(2_000);
	// the background rebuild lands and the next poll serves fresh data
	await Bun.sleep(5_000);
	const snap3 = (await (
		await fetch(`${base}/api/remotes`)
	).json()) as RemotesSnap;
	expect(snap3.ts).not.toBe(snap1.ts);
});

afterAll(async () => {
	proc.kill();
	await proc.exited;
	stub.close();
	clean();
});
