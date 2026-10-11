// test/controller-fence.test.ts — W576.5: single-authority controller
// fencing over real governor stores plus a real-process E2E (hold → standby
// refusal → hard death → takeover → handoff request/release/assume →
// generation verification). The lease is pid+birth fenced; unknown never
// acts; the handoff releases only at an idle boundary.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GovernorStore } from "../hooks/lib/govdb.ts";
import {
	acquireControllerLease,
	cancelControllerHandoff,
	controllerGeneration,
	controllerHolderLiveness,
	controllerWatchBoundary,
	currentControllerIdentity,
	markHandoffAssumed,
	markHandoffReleased,
	observeControllerLease,
	peekControllerHandoff,
	releaseControllerLease,
	requestControllerHandoff,
} from "../scripts/lib/controller-fence.ts";
import { processBirth } from "../scripts/lib/launch-fencing.ts";

setDefaultTimeout(60_000);

const dirs: string[] = [];
const children: Bun.Subprocess[] = [];
afterEach(async () => {
	for (const child of children.splice(0)) {
		try {
			child.kill(9);
		} catch {}
		await child.exited;
	}
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const memoryStore = (): GovernorStore =>
	new Database(":memory:") as unknown as GovernorStore;

const identity = (
	n: string,
	generation = "a".repeat(40),
): {
	nonce: string;
	pid: number;
	birth: string;
	generation: string;
	codeRoot: string;
} => ({
	nonce: `nonce-${n}`,
	pid: process.pid,
	birth: processBirth(process.pid)?.birth ?? "fixture-birth",
	generation,
	codeRoot: "/code-root-fixture",
});

/** A provably dead pid+birth pair: spawn, read the birth while alive, kill. */
async function deadHolder(): Promise<{ pid: number; birth: string }> {
	const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30000)"]);
	children.push(child);
	await Bun.sleep(150);
	const birth = processBirth(child.pid);
	if (!birth || birth === false) throw new Error("fixture birth unreadable");
	child.kill(9);
	await child.exited;
	return { pid: child.pid, birth: birth.birth };
}

describe("controller fence (W576.5)", () => {
	test("generation derives from the nearest harness receipt, else the entrypoint identity", () => {
		const home = mkdtempSync(join(tmpdir(), "w5765-gen-"));
		dirs.push(home);
		const generation = "b".repeat(40);
		writeFileSync(
			join(home, "harness-receipt.json"),
			JSON.stringify({ revision: generation }),
		);
		const script = join(home, "pkg/bin/tool.ts");
		mkdirSync(dirname(script), { recursive: true });
		writeFileSync(script, "export {};\n");
		expect(controllerGeneration(script)).toBe(generation);
		// a corrupt receipt must never be trusted — entrypoint identity wins
		writeFileSync(join(home, "harness-receipt.json"), "{not json");
		expect(controllerGeneration(script)).toBe(realpathSync(script));
	});

	test("identity carries pid, readable birth, generation and code root", () => {
		const id = currentControllerIdentity("self", import.meta.path);
		expect(id.pid).toBe(process.pid);
		expect(id.birth).toContain(":");
		expect(id.generation).toBe(controllerGeneration(import.meta.path));
	});

	test("acquire, observe and same-nonce refresh", () => {
		const store = memoryStore();
		expect(acquireControllerLease(store, "p", identity("a"))).toBe(true);
		const row = observeControllerLease(store, "p");
		expect(row?.nonce).toBe("nonce-a");
		expect(row?.generation).toBe("a".repeat(40));
		expect(acquireControllerLease(store, "p", identity("a"))).toBe(true);
	});

	test("second controller stands down while the holder is provably alive", () => {
		const store = memoryStore();
		expect(acquireControllerLease(store, "p", identity("holder"))).toBe(true);
		expect(acquireControllerLease(store, "p", identity("b"))).toBe(false);
		expect(observeControllerLease(store, "p")?.nonce).toBe("nonce-holder");
	});

	test("provably dead holder is taken over; foreign-host unknown is never taken", async () => {
		const store = memoryStore();
		// schema warm-up (raw INSERT below needs the tables)
		expect(observeControllerLease(store, "p")).toBeNull();
		store
			.query(
				`INSERT INTO controller_leases(project,nonce,host,pid,birth,generation,code_root,started_at,renewed_at) VALUES (?,?,?,?,?,?,?,?,?)`,
			)
			.run(
				"p",
				"nonce-far",
				"far-away.example.local",
				process.pid,
				identity("far").birth,
				"g",
				"/root",
				Date.now(),
				Date.now(),
			);
		// cross-host: uninspectable, fail-closed
		expect(acquireControllerLease(store, "p", identity("b"))).toBe(false);
		store.query("DELETE FROM controller_leases").run();
		// provably dead (absent process, recorded birth): takeover elects one
		const dead = await deadHolder();
		expect(
			acquireControllerLease(store, "p", {
				...identity("holder"),
				pid: dead.pid,
				birth: dead.birth,
			}),
		).toBe(true);
		expect(acquireControllerLease(store, "p", identity("successor"))).toBe(
			true,
		);
		expect(observeControllerLease(store, "p")?.nonce).toBe("nonce-successor");
	});

	test("liveness verdicts: host flip is same machine, birth mismatch dead, unreadable unknown", () => {
		const base = hostname().replace(/\.local(?:domain)?$/i, "");
		const birth = processBirth(process.pid)?.birth ?? "b";
		const inspect = (found: string | null) => () =>
			found === null ? null : { birth: found, command: "x" };
		expect(
			controllerHolderLiveness(
				{ host: `${base}.localdomain`, pid: process.pid, birth },
				inspect(birth),
			),
		).toBe("alive");
		expect(
			controllerHolderLiveness(
				{ host: `${base}.local`, pid: 42, birth },
				inspect("other"),
			),
		).toBe("dead");
		expect(
			controllerHolderLiveness(
				{ host: `${base}.local`, pid: 42, birth },
				inspect(null),
			),
		).toBe("unknown");
		expect(
			controllerHolderLiveness(
				{ host: "far.example.local", pid: 42, birth },
				inspect(null),
			),
		).toBe("unknown");
	});

	test("watch boundary: standby while held, handoff release at idle, assumption on fresh authority", () => {
		const store = memoryStore();
		expect(acquireControllerLease(store, "p", identity("holder"))).toBe(true);
		// a second watch stands down — no cycles while the holder is alive
		expect(controllerWatchBoundary(store, "p", identity("b"))).toBe("standby");
		// the holder honors a request addressed to it: release at the boundary
		requestControllerHandoff(store, "p", {
			fromNonce: "nonce-holder",
			targetGeneration: "c".repeat(40),
			targetRoot: "/target-gen",
		});
		expect(controllerWatchBoundary(store, "p", identity("holder"))).toBe(
			"handoff",
		);
		expect(observeControllerLease(store, "p")).toBeNull();
		expect(peekControllerHandoff(store, "p")?.state).toBe("released");
		// the next controller to take authority assumes and records itself
		expect(controllerWatchBoundary(store, "p", identity("succ"))).toBe(
			"acting",
		);
		const assumed = peekControllerHandoff(store, "p");
		expect(assumed?.state).toBe("assumed");
		expect(assumed?.assumed_generation).toBe("a".repeat(40));
		expect(assumed?.assumed_pid).toBe(process.pid);
		// an assumed handoff is terminal — no flapping, no further release
		expect(controllerWatchBoundary(store, "p", identity("succ"))).toBe(
			"acting",
		);
		expect(
			markHandoffAssumed(store, "p", {
				nonce: "nonce-x",
				pid: 1,
				generation: "g",
			}),
		).toBe(false);
	});

	test("handoff requests are fenced: nonce mismatch and cancel semantics", () => {
		const store = memoryStore();
		expect(() =>
			requestControllerHandoff(store, "p", {
				fromNonce: "nonce-x",
				targetGeneration: "d".repeat(40),
				targetRoot: "/t",
			}),
		).toThrow("no live lease exists");
		// fence-less invite with no lease: the next starter is the successor
		requestControllerHandoff(store, "p", {
			targetGeneration: "d".repeat(40),
			targetRoot: "/t",
		});
		expect(peekControllerHandoff(store, "p")?.from_nonce).toBeNull();
		expect(controllerWatchBoundary(store, "p", identity("first"))).toBe(
			"acting",
		);
		expect(peekControllerHandoff(store, "p")?.state).toBe("assumed");
		// a live holder refuses requests naming someone else
		expect(() =>
			requestControllerHandoff(store, "p", {
				fromNonce: "nonce-other",
				targetGeneration: "e".repeat(40),
				targetRoot: "/t2",
			}),
		).toThrow("other than the live lease holder");
		// an explicit request to the holder resets, then cancel clears it
		requestControllerHandoff(store, "p", {
			fromNonce: "nonce-first",
			targetGeneration: "e".repeat(40),
			targetRoot: "/t2",
		});
		expect(peekControllerHandoff(store, "p")?.state).toBe("requested");
		expect(cancelControllerHandoff(store, "p")).toBe(true);
		expect(peekControllerHandoff(store, "p")?.state).toBe("cancelled");
		expect(cancelControllerHandoff(store, "p")).toBe(false);
		// released is only reachable through the holder's own boundary
		expect(markHandoffReleased(store, "p", "nonce-other")).toBe(false);
	});

	const childEnv = (home: string): Record<string, string> => ({
		...process.env,
		HOME: home,
		GOVERNOR_STORE_URL: "local",
	});

	/** The E2E child: "hold" takes raw authority, "assume"/"standby" run one
	 * watch boundary. Stops via stop-file; hold/assume stay resident. */
	const e2eChild = (home: string): string => {
		const script = join(home, "fence-child.ts");
		writeFileSync(
			script,
			`#!${process.execPath}
import { existsSync } from "node:fs";
import { openStore } from ${JSON.stringify(join(import.meta.dir, "../hooks/lib/govdb.ts"))};
import {
	acquireControllerLease,
	controllerWatchBoundary,
	currentControllerIdentity,
} from ${JSON.stringify(join(import.meta.dir, "../scripts/lib/controller-fence.ts"))};
const [mode, project, marker, stop] = process.argv.slice(2);
const store = openStore();
if (mode === "hold") {
	const ok = acquireControllerLease(
		store,
		project,
		currentControllerIdentity("nonce-a", import.meta.path),
	);
	if (!ok) process.exit(3);
	await Bun.write(marker, "held");
} else {
	const verdict = controllerWatchBoundary(
		store,
	 project,
		currentControllerIdentity(mode === "assume" ? "nonce-b" : "nonce-c", import.meta.path),
	);
	await Bun.write(marker, verdict);
	if (mode === "standby") process.exit(0);
}
const until = Date.now() + 30000;
while (!existsSync(stop) && Date.now() < until) await Bun.sleep(20);
process.exit(0);
`,
		);
		chmodSync(script, 0o700);
		return script;
	};

	test("E2E: hold, standby, hard death, takeover, handoff release, verified assumption", async () => {
		const home = mkdtempSync(join(tmpdir(), "w5765-e2e-"));
		dirs.push(home);
		const project = "w5765-e2e-project";
		const childScript = e2eChild(home);
		const env = childEnv(home);
		const spawnChild = (mode: string, marker: string) => {
			const child = Bun.spawn(
				[childScript, mode, project, marker, join(home, "stop")],
				{ env, stdout: "ignore", stderr: "inherit" },
			);
			children.push(child);
			return child;
		};
		const waitMarker = async (marker: string): Promise<string> => {
			for (let n = 0; n < 300 && !existsSync(marker); n += 1) {
				await Bun.sleep(20);
			}
			expect(existsSync(marker)).toBe(true);
			return await Bun.file(marker).text();
		};
		// a real process takes authority in its own HOME-scoped store
		const holder = spawnChild("hold", join(home, "m-hold"));
		expect(await waitMarker(join(home, "m-hold"))).toBe("held");
		const store = new Database(
			join(home, ".cache/claude-governor/governor.db"),
		) as unknown as GovernorStore;
		expect(acquireControllerLease(store, project, identity("intruder"))).toBe(
			false,
		);
		// a second real process reads the same verdict: standby, no acting
		const standbyChild = spawnChild("standby", join(home, "m-standby"));
		expect(await waitMarker(join(home, "m-standby"))).toBe("standby");
		await standbyChild.exited;
		// hard death is provable (pid+birth) — the takeover elects the parent
		holder.kill(9);
		await holder.exited;
		const parent = currentControllerIdentity("nonce-parent", import.meta.path);
		expect(acquireControllerLease(store, project, parent)).toBe(true);
		// the owner names the live holder; the watch's release step replays
		// against the real store (the boundary unit test covers the watch side)
		requestControllerHandoff(store, project, {
			fromNonce: parent.nonce,
			targetGeneration: "f".repeat(40),
			targetRoot: join(home, "target-gen"),
		});
		expect(markHandoffReleased(store, project, parent.nonce)).toBe(true);
		expect(releaseControllerLease(store, project, parent.nonce)).toBe(true);
		// the respawned successor assumes and records its own generation+pid
		const successor = spawnChild("assume", join(home, "m-assume"));
		expect(await waitMarker(join(home, "m-assume"))).toBe("acting");
		const handoff = peekControllerHandoff(store, project);
		expect(handoff?.state).toBe("assumed");
		expect(handoff?.assumed_pid).toBe(successor.pid);
		expect(handoff?.assumed_generation).toBe(controllerGeneration(childScript));
		const lease = observeControllerLease(store, project);
		expect(lease?.nonce).toBe("nonce-b");
		expect(controllerHolderLiveness(lease)).toBe("alive");
		store.close();
	});
});
