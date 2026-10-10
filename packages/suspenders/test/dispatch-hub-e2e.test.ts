// test/dispatch-hub-e2e.test.ts — W357: multi-hub dispatch e2e. A repo
// .prefer hub=DESKTOP must pin REAL lane traffic to the hub the resolver
// walks to: the first ALIVE candidate wins (preference = candidate order),
// a dead candidate falls through to the next one (NAS serves when the
// DESKTOP candidate is down), a repo-declared one-off `hub-url=` outranks
// the global registry, and an all-dead resolution degrades to the local
// belt LOUDLY (surfaced note, never a silent wrong hub). Both "hubs" are
// live Bun.serve instances on 127.0.0.1 — resolveHub does real HTTP probes
// and dispatch pins real env; the resolution path itself is never mocked.
// The fallback case uses the GHOST label (hub-locate.test.ts convention):
// the mdns-guess step of the chain would hit the real desktop.local spoke
// on :4101 on a live dev machine, and the proof must not depend on LAN
// state. Pinning is asserted on every surface the lane actually sees:
// the executor's process env dump, the 0600 lane-settings file dispatch
// writes (settings env outranks the process env in the CLI), the lanes.json
// registry row, and the dispatch stdout note.
import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { laneSid } from "../hooks/lib/laneslug.ts";
import { projectIdentity } from "../hooks/lib/govdb.ts";

const HOME = mkdtempSync(join(tmpdir(), "claude-w357-hub-home-"));
const REPO = realpathSync(
	mkdtempSync(join(tmpdir(), "suspenders-w357-hub-repo-")),
);
const BIN = join(import.meta.dir, "..", "hooks", "bin");

// the two live hub stands-ins — DESKTOP and NAS, real HTTP on 127.0.0.1
const desktopHub = Bun.serve({
	port: 0,
	fetch: () => new Response("desktop hub ok"),
});
const nasHub = Bun.serve({
	port: 0,
	fetch: () => new Response("nas hub ok"),
});
const oneOffHub = Bun.serve({
	port: 0,
	fetch: () => new Response("repo one-off hub ok"),
});
const DESKTOP_URL = `http://127.0.0.1:${desktopHub.port}`;
const NAS_URL = `http://127.0.0.1:${nasHub.port}`;
const ONEOFF_URL = `http://127.0.0.1:${oneOffHub.port}`;

// fake executor: dumps its process env (the only proof of what the LANE
// actually saw), records its pid, and stays alive past the 1s launch check
const PIDFILE = join(HOME, "lane-pids");
const ENVFILE = join(HOME, "lane-env-dump");
const executor = join(HOME, "w357-executor");
writeFileSync(
	executor,
	`#!/bin/sh\nenv > "${ENVFILE}"\necho $$ >> "${PIDFILE}"\nexec /bin/sleep 30\n`,
);
chmodSync(executor, 0o700);

const env = {
	...process.env,
	HOME,
	SUSPENDERS_CLAUDE_BIN: executor,
	// dead buckle front by construction: hub-won cases never probe it (the
	// hub owns the base URL), and the fallback case must take the loud
	// belt-direct path deterministically
	SUSPENDERS_BUCKLE_FRONT: "http://127.0.0.1:1",
	SUSPENDERS_BELT_ENV: join(HOME, "belt.env"),
	// strip the runner's real base URL: pre-set env ALWAYS wins over lane
	// insertion (lib/insertion.ts fills unset vars only), so a leaked base
	// would silently veto the hub pin under test — while UNSET env makes
	// insertionCtx fall to its :4000 local-belt default, which is exactly
	// what the fallback case asserts
	ANTHROPIC_BASE_URL: undefined,
};
writeFileSync(join(HOME, "belt.env"), "BUCKLE_ADMIN_KEY=bksk_w357_scratch\n");

mkdirSync(join(HOME, ".claude", "hooks", "suspenders"), { recursive: true });
symlinkSync(BIN, join(HOME, ".claude", "hooks", "suspenders", "bin"), "dir");

// scratch repo: one commit so worktree ops have a base
const g = (args: string[]): void => {
	const p = spawnSync("/usr/bin/git", args, { cwd: REPO, encoding: "utf8" });
	if (p.status !== 0)
		throw new Error(`git ${args.join(" ")} failed: ${p.stderr}`);
};
g(["init", "-b", "main"]);
g(["config", "user.email", "t@threads.dk"]);
g(["config", "user.name", "t"]);
writeFileSync(join(REPO, "README.md"), "w357 hub e2e");
g(["add", "-A"]);
g(["commit", "-m", "base"]);

const dispatchA = async (
	extra: Record<string, string | undefined>,
	...args: string[]
): Promise<{ out: string; err: string; code: number }> => {
	const p = Bun.spawn(
		[
			process.execPath,
			join(import.meta.dir, "..", "scripts", "dispatch-next.ts"),
			"--repo",
			REPO,
			...args,
		],
		{ cwd: REPO, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" },
	);
	const [out, err] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
	]);
	return { out, err, code: await p.exited };
};

const addItem = async (title: string): Promise<string> => {
	const p = Bun.spawnSync(
		[process.execPath, join(BIN, "work.ts"), "add", title],
		{ cwd: REPO, env: { ...env }, stdout: "pipe", stderr: "pipe" },
	);
	const id = (p.stdout.toString().match(/W\d+/) ?? [])[0] ?? "";
	expect(id).toBeTruthy();
	return id;
};

// reaper: never leave a sleep-30 lane behind between cases
const reapLanes = (): void => {
	try {
		for (const pid of readFileSync(PIDFILE, "utf8").trim().split("\n")) {
			try {
				process.kill(Number(pid));
			} catch {}
		}
	} catch {}
	rmSync(PIDFILE, { force: true });
	rmSync(ENVFILE, { force: true });
};

// one dispatch case: a .prefer with hub intent + a scratch hubs.json
// (SUSPENDERS_HUBS_FILE), a fresh item, the REAL dispatch-next.ts run.
// The executor's env dump is read back BEFORE the lanes are reaped — the
// reaper deletes the dump file, and the assertions need its content.
const dispatchHubCase = async (
	preferLines: string[],
	registryEntries: Record<string, { candidates: string[] }>,
	opts: { allowUngoverned?: boolean } = {},
): Promise<{
	id: string;
	sid: string;
	out: string;
	err: string;
	envDump: string;
}> => {
	writeFileSync(join(REPO, ".prefer"), `${preferLines.join("\n")}\n`);
	const regFile = join(HOME, "w357-hubs.json");
	writeFileSync(regFile, JSON.stringify(registryEntries));
	const id = await addItem("multi-hub dispatch e2e fixture");
	const res = await dispatchA(
		{ SUSPENDERS_HUBS_FILE: regFile },
		"--item",
		id,
		...(opts.allowUngoverned ? ["--allow-ungoverned"] : []),
	);
	const envDump = existsSync(ENVFILE) ? readFileSync(ENVFILE, "utf8") : "";
	reapLanes();
	return {
		id,
		sid: laneSid(id, projectIdentity(REPO)),
		out: res.out,
		err: res.err,
		envDump,
	};
};

// the pinning surfaces, read back per case
const laneSettings = (sid: string): { env: Record<string, string> } =>
	JSON.parse(
		readFileSync(join(REPO, ".fleet", `lane-settings-${sid}.json`), "utf8"),
	);
const laneRow = (sid: string): { hub?: string; agent?: string } => {
	const rows = JSON.parse(
		readFileSync(join(REPO, ".fleet", "lanes.json"), "utf8"),
	) as { sid: string; hub?: string; agent?: string }[];
	const row = rows.find((r) => r.sid === sid);
	expect(row).toBeDefined();
	return row as { sid: string; hub?: string; agent?: string };
};

afterAll(() => {
	reapLanes();
	desktopHub.stop(true);
	nasHub.stop(true);
	oneOffHub.stop(true);
	rmSync(HOME, { recursive: true, force: true });
	rmSync(REPO, { recursive: true, force: true });
});

describe("multi-hub dispatch e2e (W357): .prefer hub= candidates walk", () => {
	test("prefer DESKTOP: first ALIVE candidate wins over NAS (preference = candidate order)", async () => {
		const { id, sid, out, envDump } = await dispatchHubCase(["hub=DESKTOP"], {
			DESKTOP: { candidates: [DESKTOP_URL, NAS_URL] },
		});
		expect(out).toContain("dispatched ");
		// the note names DESKTOP and the DESKTOP url, via the registry
		expect(out).toContain(`hub DESKTOP -> ${DESKTOP_URL} (registry hubs.json)`);
		// the 0600 lane settings pin the DESKTOP base (what claude merges)
		expect(laneSettings(sid).env.ANTHROPIC_BASE_URL).toBe(DESKTOP_URL);
		// the lane process env carries the label + how the hub was found
		expect(envDump).toContain("SUSPENDERS_HUB=DESKTOP");
		expect(envDump).toContain("SUSPENDERS_HUB_VIA=registry hubs.json");
		// the lane registry row carries hub + the [DESKTOP] agent label
		const row = laneRow(sid);
		expect(row.hub).toBe("DESKTOP");
		expect(row.agent?.startsWith("[DESKTOP]")).toBe(true);
		// fixture hygiene: the item really was dispatched (claim left on it)
		expect(out).toContain(id);
	}, 90_000);

	test("failover: dead DESKTOP candidate falls through to the live NAS candidate", async () => {
		const { sid, out, envDump } = await dispatchHubCase(["hub=DESKTOP"], {
			DESKTOP: { candidates: ["http://127.0.0.1:1", NAS_URL] },
		});
		expect(out).toContain("dispatched ");
		expect(out).toContain(`hub DESKTOP -> ${NAS_URL} (registry hubs.json)`);
		expect(laneSettings(sid).env.ANTHROPIC_BASE_URL).toBe(NAS_URL);
		expect(envDump).toContain("SUSPENDERS_HUB=DESKTOP");
		expect(laneRow(sid).hub).toBe("DESKTOP");
	}, 90_000);

	test("repo one-off hub-url outranks the global registry (most specific intent wins)", async () => {
		const { sid, out, envDump } = await dispatchHubCase(
			["hub=DESKTOP", `hub-url=${ONEOFF_URL}`],
			{ DESKTOP: { candidates: [NAS_URL] } },
		);
		expect(out).toContain("dispatched ");
		expect(out).toContain(`hub DESKTOP -> ${ONEOFF_URL} (prefer hub-url)`);
		expect(laneSettings(sid).env.ANTHROPIC_BASE_URL).toBe(ONEOFF_URL);
		expect(envDump).toContain("SUSPENDERS_HUB_VIA=prefer hub-url");
	}, 90_000);

	test("unreachable fallback: all candidates dead -> loud local-belt note, hub env absent, belt base pinned", async () => {
		// GHOST label (hub-locate.test.ts convention): the resolver's
		// mdns-guess step would otherwise hit the real desktop.local spoke
		// on a live dev machine — the null-proof must not depend on LAN state
		const { id, sid, out, envDump } = await dispatchHubCase(
			["hub=GHOST"],
			{ GHOST: { candidates: ["http://127.0.0.1:1"] } },
			{ allowUngoverned: true },
		);
		expect(out).toContain("dispatched ");
		// surfaced, never silent — the NOTE names the label and the fallback
		expect(out).toContain(
			"NOTE — .prefer hub=GHOST unreachable; using local belt",
		);
		// the dead-front probe ride is disclosed (--allow-ungoverned path)
		expect(out).toContain("UNGOVERNED DISPATCH — operator override");
		// no hub env reaches the lane; the belt default base stands
		expect(envDump).not.toContain("SUSPENDERS_HUB=");
		expect(laneSettings(sid).env.ANTHROPIC_BASE_URL).toBe(
			"http://127.0.0.1:4000",
		);
		// the worktree brief carries the governance disclosure
		const wtBrief = readFileSync(
			join(REPO, ".worktrees", id, ".klh-brief.md"),
			"utf8",
		);
		expect(wtBrief).toContain("GOVERNANCE: UNGOVERNED DISPATCH");
	}, 120_000);
});
