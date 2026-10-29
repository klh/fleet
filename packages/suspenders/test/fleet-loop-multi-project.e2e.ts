// test/fleet-loop-multi-project.e2e.ts — fork E (hub-of-one): one fleet-loop
// controller supervises EVERY registered repo. Pins: fair round-robin lane
// dealing under the global ceiling (+ per-project sub-caps), the registry
// resolver + its coord verbs, one controller lease PER project with
// unchanged fence semantics (standby / handoff / drop), the child argv
// split (hub-wide sweeps ride the primary only), and a live two-repo watch
// whose per-project dispatch and leases surface in `work report --all`.
import { Database } from "bun:sqlite";
import { runCli, scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	currentControllerIdentity,
	observeControllerLease,
	requestControllerHandoff,
} from "../scripts/lib/controller-fence.ts";
import { allocateLaneTargets } from "../hooks/lib/fleet-loop/lane-allocation.ts";
import {
	projectChildArgs,
	projectsBoundary,
	projectTargets,
} from "../hooks/lib/fleet-loop/multi-project.ts";
import {
	listRegistry,
	registerProject,
	supervisedProjects,
	unregisterProject,
} from "../hooks/lib/fleet-loop/project-registry.ts";
import { projectIdentity } from "../hooks/lib/govdb/govdb.ts";

const LOOP = new URL("../hooks/bin/fleet-loop.ts", import.meta.url).pathname;
const WORK = new URL("../hooks/bin/work.ts", import.meta.url).pathname;
const COORD = new URL("../hooks/bin/coord.ts", import.meta.url).pathname;

// a governor-store face over an in-memory sqlite (lease + work_items only)
const memStore = () => {
	const db = new Database(":memory:");
	db.run("CREATE TABLE work_items (project TEXT, id TEXT, state TEXT)");
	return {
		local: true,
		query: (sql) => db.query(sql),
		run: (sql, ...params) => db.run(sql, ...params),
		transaction: (fn) => db.transaction(fn),
		close: () => db.close(),
		db,
	};
};

const proj = (key, extra = {}) => ({
	key,
	repo: `/r/${key}`,
	glob: "lane/*",
	main: "main",
	primary: false,
	...extra,
});

test.describe("fleet-loop multi-project supervision (fork E) @unit", () => {
	test("lane dealing: global ceiling, round-robin, sub-caps, never shrinks", () => {
		const a = allocateLaneTargets(
			[
				{ key: "A", live: 1, ready: 5 },
				{ key: "B", live: 0, ready: 5 },
				{ key: "C", live: 0, ready: 0 },
			],
			4,
			0,
		);
		// 3 free slots dealt A,B,A (C has no demand)
		expect(Object.fromEntries(a.targets)).toEqual({ A: 3, B: 1, C: 0 });
		// rotation moves the first deal: B,A,B
		const r = allocateLaneTargets(
			[
				{ key: "A", live: 1, ready: 5 },
				{ key: "B", live: 0, ready: 5 },
			],
			4,
			1,
		);
		expect(Object.fromEntries(r.targets)).toEqual({ A: 2, B: 2 });
		// sub-cap bounds a project; leftover stays idle
		const c = allocateLaneTargets(
			[
				{ key: "A", live: 0, ready: 9, cap: 1 },
				{ key: "B", live: 0, ready: 1 },
			],
			6,
			0,
		);
		expect(Object.fromEntries(c.targets)).toEqual({ A: 1, B: 1 });
		expect(c.idle).toBe(4);
		// over-ceiling live lanes are never shrunk, nothing new is dealt
		const o = allocateLaneTargets(
			[
				{ key: "A", live: 5, ready: 3 },
				{ key: "B", live: 0, ready: 3 },
			],
			4,
			0,
		);
		expect(Object.fromEntries(o.targets)).toEqual({ A: 5, B: 0 });
	});

	test("registry: resolver dedupes by identity, skips missing/disabled; verbs edit 0600 conf", () => {
		const a = scratchWorld({ prefix: "forkE-a-" });
		const b = scratchWorld({ prefix: "forkE-b-" });
		const dir = mkdtempSync(join(tmpdir(), "forkE-conf-"));
		const conf = join(dir, "stack.json");
		try {
			const primary = { repo: a.repo, glob: "suspenders/*", main: "main" };
			const r = supervisedProjects(primary, [
				{ path: a.repo, lane_target: 2 },
				{ path: b.repo, ladder: "git merge --no-ff {branch}" },
				{ path: join(dir, "nope") },
				{ path: b.repo, enabled: false },
			]);
			expect(r.projects.map((p) => p.primary)).toEqual([true, false]);
			expect(r.projects[0]?.cap).toBe(2); // registry row on the primary = sub-cap
			expect(r.projects[1]?.key).toBe(projectIdentity(b.repo));
			expect(r.projects[1]?.glob).toBe("suspenders/*"); // inherits primary glob
			expect(r.projects[1]?.ladder).toBe("git merge --no-ff {branch}");
			expect(r.issues.join(" ")).toContain("missing");

			writeFileSync(conf, JSON.stringify({ hubs: {}, version: "v0" }));
			expect(registerProject({ path: b.repo }, { path: conf })).toBe("added");
			expect(
				registerProject({ path: b.repo, lane_target: 1 }, { path: conf }),
			).toBe("updated");
			const rows = listRegistry(conf);
			expect(rows.length).toBe(1);
			expect(rows[0]?.lane_target).toBe(1);
			const raw = JSON.parse(readFileSync(conf, "utf8"));
			expect(raw.version).toBe("v0"); // other conf keys survive
			expect(statSync(conf).mode & 0o777).toBe(0o600);
			expect(unregisterProject(b.repo, { path: conf })).toBe(true);
			expect(listRegistry(conf)).toEqual([]);

			// the coord verb face over the same registry (KLH_STACK pins the conf)
			const env = { ...a.env, KLH_STACK: conf };
			const reg = runCli(
				COORD,
				["project", "register", b.repo, "--lane-target", "2"],
				{ cwd: a.repo, env },
			);
			expect(reg.code, reg.err).toBe(0);
			const ls = runCli(COORD, ["project", "list", "--json"], {
				cwd: a.repo,
				env,
			});
			expect(ls.code, ls.err).toBe(0);
			expect(JSON.parse(ls.out)[0]?.lane_target).toBe(2);
			const bad = runCli(
				COORD,
				["project", "register", b.repo, "--lane-target", "-1"],
				{ cwd: a.repo, env },
			);
			expect(bad.code).not.toBe(0);
		} finally {
			a.clean();
			b.clean();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("one lease per project: second controller standbys; handoff releases all; drop on deregister", () => {
		const s = memStore();
		const me = currentControllerIdentity("nonce-a", LOOP);
		const other = currentControllerIdentity("nonce-b", LOOP);
		const projects = [proj("P1", { primary: true }), proj("P2")];
		const first = projectsBoundary(s, projects, me);
		expect(first.acting.map((p) => p.key)).toEqual(["P1", "P2"]);
		expect(observeControllerLease(s, "P1")?.nonce).toBe("nonce-a");
		expect(observeControllerLease(s, "P2")?.nonce).toBe("nonce-a");
		// a second controller (alive holder) acts on nothing
		const second = projectsBoundary(s, projects, other);
		expect(second.acting).toEqual([]);
		expect(second.standby.length).toBe(2);
		// deregistering P2 drops its lease at the next boundary
		const shrunk = projectsBoundary(s, [projects[0]], me);
		expect(shrunk.dropped).toEqual(["P2"]);
		expect(observeControllerLease(s, "P2")).toBe(null);
		// an owner handoff on any project releases every lease
		projectsBoundary(s, projects, me);
		requestControllerHandoff(s, "P2", {
			fromNonce: "nonce-a",
			targetGeneration: "g2",
			targetRoot: "/next",
		});
		const h = projectsBoundary(s, projects, me);
		expect(h.handoff?.key).toBe("P2");
		expect(observeControllerLease(s, "P1")).toBe(null);
		expect(observeControllerLease(s, "P2")).toBe(null);
		s.close();
	});

	test("targets from live claims + READY; dispatch-held repos take no free slots", () => {
		const s = memStore();
		const add = (p, id, state) =>
			s.db.run("INSERT INTO work_items VALUES (?,?,?)", p, id, state);
		add("P1", "W1", "CLAIMED");
		for (const id of ["W2", "W3", "W4"]) add("P1", id, "READY");
		for (const id of ["W1", "W2", "W3"]) add("P2", id, "READY");
		for (const id of ["W1", "W2"]) add("P3", id, "READY");
		const acting = [proj("P1"), proj("P2"), proj("P3")];
		const t = projectTargets(s, acting, 4, 0, (p) => p.key === "P3");
		expect(Object.fromEntries(t)).toEqual({ P1: 3, P2: 1, P3: 0 });
		s.close();
	});

	test("child argv: primary keeps the controller argv; registered repos are --project-only", () => {
		const argv = [
			"watch",
			"--repo",
			"/x/fleet",
			"--agent",
			"codex",
			"--log",
			"/x/loop.log",
		];
		const primary = projectChildArgs(
			proj("P1", { primary: true, repo: "/x/fleet" }),
			argv,
			"/x/fleet/packages/suspenders",
			3,
		);
		expect(primary).toEqual([
			"once",
			"--repo",
			"/x/fleet/packages/suspenders",
			"--agent",
			"codex",
			"--log",
			"/x/loop.log",
			"--lane-target",
			"3",
		]);
		// back-compat: single-repo mode passes no lane target at all
		expect(
			projectChildArgs(proj("P1", { primary: true }), argv, "/c", undefined),
		).not.toContain("--lane-target");
		const reg = projectChildArgs(
			proj("P2", { dispatch: "bun d.ts", ladder: "git merge {branch}" }),
			argv,
			"/c",
			1,
		);
		expect(reg).toEqual([
			"once",
			"--repo",
			"/r/P2",
			"--glob",
			"lane/*",
			"--main",
			"main",
			"--ladder",
			"git merge {branch}",
			"--dispatch-cmd",
			"bun d.ts",
			"--agent",
			"codex",
			"--project-only",
			"--lane-target",
			"1",
		]);
	});

	test("live watch over two repos: per-project leases, dealt dispatch targets, report --all", async () => {
		test.setTimeout(120_000);
		const a = scratchWorld({ prefix: "forkE-live-a-" });
		const b = scratchWorld({ prefix: "forkE-live-b-" });
		const conf = join(a.home, "stack.json");
		const dispatchLog = join(a.home, "dispatch.log");
		writeFileSync(
			conf,
			JSON.stringify({
				hubs: {},
				fleet_loop: { lane_target: 3, projects: [{ path: b.repo }] },
			}),
		);
		const env = {
			...a.env,
			KLH_STACK: conf,
			SUSPENDERS_MAINTENANCE: "0",
			SUSPENDERS_TRANSPORT_PROBE: "0",
		};
		let watch = null;
		try {
			for (const repo of [a.repo, b.repo])
				for (const t of ["one", "two", "three"]) {
					const r = runCli(WORK, ["add", `${t} task`], { cwd: repo, env });
					expect(r.code, r.err).toBe(0);
				}
			watch = Bun.spawn(
				[
					"bun",
					LOOP,
					"watch",
					"--repo",
					a.repo,
					"--glob",
					"lane/autow*",
					"--every",
					"1",
					"--dispatch-cmd",
					`echo "$(pwd -P)" >> ${dispatchLog}`,
				],
				{ cwd: a.repo, env, stdout: "ignore", stderr: "ignore" },
			);
			const realA = projectIdentity(a.repo).replace(/\/\.git$/, "");
			const realB = projectIdentity(b.repo).replace(/\/\.git$/, "");
			const deadline = Date.now() + 90_000;
			let lines = [];
			while (Date.now() < deadline) {
				lines = existsSync(dispatchLog)
					? readFileSync(dispatchLog, "utf8").trim().split("\n")
					: [];
				if (
					lines.some((l) => l.startsWith(realA)) &&
					lines.some((l) => l.startsWith(realB))
				)
					break;
				await Bun.sleep(250);
			}
			// cycle 1 deals A,B,A from the global ceiling of 3 (READY 3 each)
			expect(lines.find((l) => l.startsWith(realA))).toBe(
				`${realA} --target 2`,
			);
			expect(lines.find((l) => l.startsWith(realB))).toBe(
				`${realB} --target 1`,
			);
			// two controller leases, one per project, held by the watch
			const report = runCli(WORK, ["report", "--all", "--format", "json"], {
				cwd: a.repo,
				env,
			});
			expect(report.code, report.err).toBe(0);
			const controllers = JSON.parse(report.out).controllers;
			const byProject = Object.fromEntries(
				controllers.map((c) => [c.project, c]),
			);
			for (const key of [projectIdentity(a.repo), projectIdentity(b.repo)]) {
				expect(byProject[key]?.state).toBe("alive");
				expect(byProject[key]?.pid).toBe(watch.pid);
				expect(byProject[key]?.last_cycle_ms_ago).not.toBe(null);
			}
		} finally {
			watch?.kill(9);
			await watch?.exited;
			a.clean();
			b.clean();
		}
	});
});
