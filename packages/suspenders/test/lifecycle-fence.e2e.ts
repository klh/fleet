// test/lifecycle-fence.test.ts — W576.7.1 through the REAL gate
// (bun hooks/gate.ts pre-bash), lane-identity fixtures per
// bash-hardening-gate.test.ts. HOME is isolated per run so the authority
// store, approvals and receipt paths resolve under the fixture root — the
// real governor.db, keys and services are never touched. Regressions pinned
// here: the W427 Bun copy of an active unit, the wrapped loader, direct
// launchctl, read-only inspection stays free, and the repo's own suite files
// stay runnable (launchctl-as-data FP guard).
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.setTimeout(30_000);

// Fixture root on the LOCAL volume (tmpdir), never the repo mount — the
// minter, the spawned gate and this test process are three separate
// processes sharing one SQLite file, and /Volumes/Sensitive has known
// cross-process file-view incoherence (W635). Local APFS keeps their
// views of the fixture governor.db coherent.
const tmp = mkdtempSync(join(tmpdir(), "lifecycle-fence-test-"));
const laneDir = join(tmp, "wt");
const home = join(tmp, "home");
test.beforeAll(() => {
	mkdirSync(join(laneDir, ".fleet"), { recursive: true });
	mkdirSync(home, { recursive: true });
});

const gateEnv = () => ({
	...process.env,
	HOME: home,
	PATH: `${join(process.execPath, "..")}:${process.env.PATH ?? ""}`,
});

type Decision = {
	hookSpecificOutput?: {
		permissionDecision?: string;
		permissionDecisionReason?: string;
	};
};

const spawnGate = (event: string, input: object): Decision => {
	const pf = join(tmp, `payload-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(pf, JSON.stringify(input));
	try {
		const r = Bun.spawnSync(
			["bun", join(import.meta.dir, "..", "hooks", "gate.ts"), event],
			{
				env: gateEnv(),
				stdin: Bun.file(pf),
				stdout: "pipe",
				stderr: "pipe",
				cwd: join(import.meta.dir, ".."),
			},
		);
		const out = r.stdout.toString();
		try {
			return JSON.parse(out) as Decision;
		} catch {
			// a crashed gate must never masquerade as an allow — surface stderr
			throw new Error(
				`gate did not emit JSON (exit ${r.exitCode}): ${r.stderr.toString().slice(0, 400)}`,
			);
		}
	} finally {
		rmSync(pf, { force: true });
	}
};

// lane identity: this test process is the registry ancestor (real pid in the
// fixture lanes.json); the ghost pid resolves no lane = owner-class session.
const LANES = join(laneDir, ".fleet", "lanes.json");
const writeLanes = (entries: unknown[]) =>
	writeFileSync(LANES, JSON.stringify(entries));
const laneEntry = () => [
	{
		sid: "autow57671",
		item: "W576.7.1",
		pid: process.pid,
		branch: "suspenders/W576.7.1",
		worktree: laneDir,
	},
];
const ghostEntry = () => [
	{
		sid: "ghost",
		item: "G",
		pid: 99999999,
		branch: "x",
		worktree: laneDir,
	},
];

const bash = (command: string, who: "lane" | "owner") => {
	writeLanes(who === "lane" ? laneEntry() : ghostEntry());
	const d = spawnGate("pre-bash", {
		tool_name: "Bash",
		tool_input: { command },
		cwd: laneDir,
		session_id: "lc-fence-lane",
		transcript_path: "/nonexistent.jsonl",
	});
	return {
		decision: d.hookSpecificOutput?.permissionDecision ?? "allow",
		reason: d.hookSpecificOutput?.permissionDecisionReason ?? "",
	};
};

// authority grants go through the REAL minter. cwd must be OUTSIDE the fleet
// root (no .fleet up-walk → owner-class shell); the self-grant test instead
// uses the fixture lane dir to resolve as a lane and get refused.
const ownerCwd = mkdtempSync(join(tmpdir(), "lc-minter-"));
const minter = (args: string[], cwd = ownerCwd) => {
	const r = Bun.spawnSync(
		[
			process.execPath,
			join(import.meta.dir, "..", "hooks", "bin", "lifecycle-authority.ts"),
			...args,
		],
		{ env: gateEnv(), stdout: "pipe", stderr: "pipe", cwd },
	);
	return r;
};

// the store under the FIXTURE home, opened directly — never the real
// governor.db, and never via openGovernorDb() (whose module-level REG pins
// the REAL home at first require, before the swap could matter).
const govdb = () => {
	const db = new Database(join(home, ".cache/claude-governor/governor.db"));
	db.run("PRAGMA busy_timeout=5000");
	return db;
};

const W427 = `import {copyFileSync} from "node:fs";
copyFileSync("/tmp/src.plist", process.env.HOME + "/Library/LaunchAgents/com.suspenders.buckle-spoke.plist");
`;

test.beforeAll(() => {
	writeFileSync(join(laneDir, "w427.ts"), W427);
});

test.describe("W576.7.1 service lifecycle fence", () => {
	test("W427 Bun copy: lane copyFileSync of an active unit → typed refusal", () => {
		const r = bash("bun w427.ts", "lane");
		expect(r.decision).toBe("deny");
		expect(r.reason).toContain("lifecycle-fence");
		expect(r.reason).toContain("lifecycle authority");
	});

	test("W427 Bun copy: owner-class session stays supported", () => {
		const r = bash("bun w427.ts", "owner");
		expect(r.decision).toBe("allow");
	});

	test("granted wildcard authority admits the W427 copy and audits the use", () => {
		const g = minter(["grant", "--sid", "autow57671", "--scope", "*"]);
		expect(g.exitCode).toBe(0);
		const r = bash("bun w427.ts", "lane");
		expect(r.decision).toBe("allow");
		const db = govdb();
		const kinds = db
			.query("SELECT kind FROM events WHERE kind='service-lifecycle'")
			.all();
		expect(kinds.length).toBeGreaterThan(0);
		db.close();
	});

	test("expired grant refuses again", () => {
		const db = govdb();
		db.run(
			"INSERT INTO service_lifecycle_grants(sid,scope,nonce,granted_by,expires_at) VALUES (?,?,?,?,?) ON CONFLICT(sid,scope) DO UPDATE SET expires_at=excluded.expires_at",
			"autow57671",
			"*",
			"expired",
			"owner",
			Date.now() - 1000,
		);
		db.close();
		const r = bash("bun w427.ts", "lane");
		expect(r.decision).toBe("deny");
	});

	test("label-scoped grant: matching label passes, other label refuses", () => {
		const g = minter([
			"grant",
			"--sid",
			"autow57671",
			"--scope",
			"com.suspenders.board",
		]);
		expect(g.exitCode).toBe(0);
		const ok = bash(
			"launchctl bootstrap gui/501 $HOME/Library/LaunchAgents/com.suspenders.board.plist",
			"lane",
		);
		expect(ok.decision).toBe("allow");
		const other = bash(
			"launchctl bootstrap gui/501 $HOME/Library/LaunchAgents/com.suspenders.reasoner.plist",
			"lane",
		);
		expect(other.decision).toBe("deny");
		expect(other.reason).toContain("lifecycle-fence");
	});

	test("direct launchctl bootstrap/bootout refuse (lifecycle-typed, not two-person)", () => {
		writeLanes(laneEntry());
		const r1 = bash(
			"launchctl bootstrap gui/501 $HOME/Library/LaunchAgents/com.suspenders.unassigned.plist",
			"lane",
		);
		expect(r1.decision).toBe("deny");
		expect(r1.reason).toContain("lifecycle-fence");
		const r2 = bash(
			"launchctl bootout gui/501/com.suspenders.unassigned",
			"lane",
		);
		expect(r2.decision).toBe("deny");
		expect(r2.reason).toContain("lifecycle-fence");
	});

	test("wrapped loader (load-launchd.sh) needs authority", () => {
		const r = bash(
			`bash ${join(import.meta.dir, "..", "scripts", "load-launchd.sh")} x.plist x.log`,
			"lane",
		);
		expect(r.decision).toBe("deny");
		expect(r.reason).toContain("lifecycle-fence");
	});

	test("read-only inspection stays free", () => {
		const r1 = bash(
			'bun -e \'const {readFileSync}=require("node:fs");readFileSync(process.env.HOME + "/Library/LaunchAgents/com.suspenders.board.plist","utf8")\'',
			"lane",
		);
		expect(r1.decision).toBe("allow");
		const r2 = bash("launchctl print gui/501/com.suspenders.board", "lane");
		expect(r2.decision).toBe("allow");
	});

	test("repo suite files stay runnable (launchctl-as-data FP guard)", () => {
		const r1 = bash(
			`bun test ${join(import.meta.dir, "blast-radius.test.ts")}`,
			"lane",
		);
		expect(r1.decision).toBe("allow");
		const r2 = bash(
			`bun test ${join(import.meta.dir, "install-activation-receipt.test.ts")}`,
			"lane",
		);
		expect(r2.decision).toBe("allow");
	});

	test("python shutil copy of an active unit refuses", () => {
		const src = `import shutil, os
shutil.copy("/tmp/src.plist", os.environ["HOME"] + "/Library/LaunchAgents/com.suspenders.board.plist")
`;
		writeFileSync(join(laneDir, "w427.py"), src);
		const r = bash("python3 w427.py", "lane");
		expect(r.decision).toBe("deny");
		expect(r.reason).toContain("lifecycle-fence");
	});

	test("minter refuses a lane self-grant and revokes cleanly", () => {
		// this test process IS the lane ancestor in the fixture — running the
		// minter with cwd=laneDir resolves it as the lane → refusal
		const self = minter(["grant", "--sid", "x", "--scope", "*"], laneDir);
		expect(self.exitCode).toBe(1);
		const rv = minter(["revoke", "--sid", "autow57671"]);
		expect(rv.exitCode).toBe(0);
		const db = govdb();
		const left = db
			.query("SELECT 1 FROM service_lifecycle_grants WHERE sid='autow57671'")
			.get();
		expect(left).toBeNull();
		db.close();
	});
});
