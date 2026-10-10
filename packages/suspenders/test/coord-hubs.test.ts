// test/coord-hubs.test.ts — W356: `coord hubs` projects the hub topology
// from the two operator configs (hubs.json lookup + stack.yaml truth) with a
// health-probed candidate walk. Temp HOME + SUSPENDERS_HUBS_FILE/KLH_STACK
// redirects; every CLI run happens in a bun subprocess so the parent test
// process never opens the real governor.db (coord-events.test.ts recipe).
// The "alive" target is a real tiny Bun.serve() on 127.0.0.1 — no network
// beyond loopback.
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COORD = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
const home = mkdtempSync(join(tmpdir(), "suspenders-coord-hubs-test-"));
const HUBS = join(home, "hubs.json");
const STACK = join(home, "stack.yaml");

// one live target + one guaranteed-closed port (bind :0, observe, release)
const live = Bun.serve({ port: 0, fetch: () => new Response("ok") });
const liveUrl = `http://127.0.0.1:${live.port}`;
const closed = Bun.serve({ port: 0, fetch: () => new Response("ok") });
const closedPort = closed.port;
closed.stop(true);

afterAll(() => {
	live.stop(true);
	rmSync(home, { recursive: true, force: true });
});

// ASYNC spawn on purpose: this test process also HOSTS the probe target, and
// spawnSync would block the event loop the server needs to answer (proven by
// the 5-fail first run — children timed out against a sync-blocked parent)
const runCli = async (
	args: string[],
	env: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> => {
	const p = Bun.spawn(["bun", COORD, ...args], {
		env: {
			...process.env,
			HOME: home,
			SUSPENDERS_HUBS_FILE: HUBS,
			KLH_STACK: STACK,
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
	]);
	return { code: await p.exited, out, err };
};

// shared fixture: the SAME label declared in both configs (case-differing —
// the registry spells TESTHUB, the stack spells TestHub; stack wins as the
// truth) with a dead registry candidate + one live stack port
const writeFixture = (): void => {
	const hub = { candidates: [`http://127.0.0.1:${closedPort}`] };
	require("node:fs").writeFileSync(HUBS, JSON.stringify({ TESTHUB: hub }));
	require("node:fs").writeFileSync(
		STACK,
		`hubs:
  TestHub:
    host: 127.0.0.1
    buckle_port: ${closedPort}
    board_port: ${live.port}
`,
	);
};

describe("coord hubs — the hub topology read verb", () => {
	test("text mode merges both configs, probes every candidate", async () => {
		writeFixture();
		const p = await runCli(["hubs"]);
		expect(p.code).toBe(0);
		// case-merged into ONE row, spelled by stack.yaml (the truth)
		expect(p.out).toContain("TestHub");
		expect(p.out).not.toContain("TESTHUB —");
		expect(p.out).toContain(`✓ ${liveUrl} — stack.yaml board`);
		expect(p.out).toContain(`✗ http://127.0.0.1:${closedPort} — hubs.json`);

		expect(p.out).not.toContain("— down");
	});

	test("--json: winner + per-candidate evidence + source paths", async () => {
		writeFixture();
		const p = await runCli(["hubs", "--json"]);
		expect(p.code).toBe(0);
		const j = JSON.parse(p.out) as {
			hubs: {
				label: string;
				up: boolean;
				url: string | null;
				via: string | null;
				candidates: { url: string; source: string; up: boolean; ms: number }[];
			}[];
			sources: { registry: string; stack: string | null };
		};
		expect(j.hubs).toHaveLength(1);
		const h = j.hubs[0];
		expect(h.label).toBe("TestHub");
		expect(h.up).toBe(true);
		expect(h.url).toBe(liveUrl);
		expect(h.via).toBe("stack.yaml board");
		expect(h.candidates[0]).toEqual({
			url: `http://127.0.0.1:${closedPort}`,
			source: "hubs.json",
			up: false,
			ms: expect.any(Number),
		});
		expect(h.candidates.some((c) => c.up && c.url === liveUrl)).toBe(true);
		expect(j.sources.registry).toBe(HUBS);
		expect(j.sources.stack).toBe(STACK);
	});

	test("--label filters case-insensitively and probes only that hub", async () => {
		writeFixture();
		const p = await runCli(["hubs", "--label", "testhub"]);
		expect(p.code).toBe(0);
		expect(p.out).toContain("TestHub");
		expect(p.out).toContain(`✓ ${liveUrl}`);
		const second = await runCli(["hubs", "--label", "testhub", "--json"]);
		const j = JSON.parse(second.out) as { hubs: unknown[] };
		expect(j.hubs).toHaveLength(1);
	});

	test("unknown --label dies with the known set (exit 2)", async () => {
		writeFixture();
		const p = await runCli(["hubs", "--label", "ghost"]);
		expect(p.code).toBe(2);
		expect(p.err).toContain('hub "ghost" not in hubs.json or stack.yaml');
		expect(p.err).toContain("TestHub");
	});

	test("no configs at all: dim hint (exit 0), JSON reports empty + null stack", async () => {
		const p = await runCli(["hubs"], {
			SUSPENDERS_HUBS_FILE: join(home, "nope.json"),
			KLH_STACK: join(home, "nope.yaml"),
		});
		expect(p.code).toBe(0);
		expect(p.out).toContain("no hubs declared");
		const j = await runCli(["hubs", "--json"], {
			SUSPENDERS_HUBS_FILE: join(home, "nope.json"),
			KLH_STACK: join(home, "nope.yaml"),
		});
		const parsed = JSON.parse(j.out) as {
			hubs: unknown[];
			sources: { stack: string | null };
		};
		expect(parsed.hubs).toHaveLength(0);
		expect(parsed.sources.stack).toBeNull();
	});

	test("host user@ prefix is stripped for contact URLs", async () => {
		require("node:fs").writeFileSync(HUBS, JSON.stringify({}));
		require("node:fs").writeFileSync(
			STACK,
			`hubs:
  sshform:
    host: kube@127.0.0.1
    belt_port: ${live.port}
`,
		);
		const p = await runCli(["hubs", "--label", "sshform", "--json"]);
		const j = JSON.parse(p.out) as {
			hubs: { up: boolean; url: string | null }[];
		};
		expect(j.hubs[0]?.url).toBe(liveUrl);
	});
});
