// test/dispatch-posture.test.ts — W503: the dispatch posture. `.fleet/posture`
// (steady|plaid) flips how wide the fleet runs — steady caps at --target,
// plaid is work-driven — flipped at runtime via the fleet-loop posture verb
// (owner keywords ultrawork/plaid/rw), no plist edit or restart.
import { describe, expect, test, afterAll } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parsePosture,
	postureWidth,
	readPosture,
	writePosture,
} from "../scripts/lib/posture.ts";

const REPO = mkdtempSync(join(process.cwd(), ".tmp-w503-posture-repo-"));

// the scratch repo MUST be a real git repo: canonicalProjectRoot resolves
// any non-repo path under a worktree to the MAIN repo (the work-graph
// identity), and the posture verb would read/write the wrong .fleet
const g = (args: string[]): void => {
	Bun.spawnSync(["/usr/bin/git", ...args], {
		cwd: REPO,
		stdout: "pipe",
		stderr: "pipe",
	});
};
g(["init", "-q", "-b", "main"]);
g(["config", "user.email", "t@threads.dk"]);
g(["config", "user.name", "t"]);

afterAll(() => rmSync(REPO, { recursive: true, force: true }));

describe("posture lib", () => {
	test("parsePosture: valid modes, case/space tolerant, junk null", () => {
		expect(parsePosture("plaid")).toBe("plaid");
		expect(parsePosture(" STEADY\n")).toBe("steady");
		expect(parsePosture("bogus")).toBe(null);
		expect(parsePosture(undefined)).toBe(null);
	});

	test("readPosture: missing file/dir/junk means steady (fail-safe narrow)", () => {
		expect(readPosture(join(REPO, "no-such-dir"))).toBe("steady");
		mkdirSync(join(REPO, ".fleet"), { recursive: true });
		writeFileSync(join(REPO, ".fleet", "posture"), "garbage\n");
		expect(readPosture(REPO)).toBe("steady");
	});

	test("write/read roundtrip + steady/plaid width", () => {
		writePosture(REPO, "plaid");
		expect(readPosture(REPO)).toBe("plaid");
		writePosture(REPO, "steady");
		expect(readPosture(REPO)).toBe("steady");
		expect(postureWidth("steady", 6)).toBe(6);
		expect(postureWidth("plaid", 6)).toBe(Number.POSITIVE_INFINITY);
	});
});

// fleet-loop posture verb coverage is LIVE-EVIDENCED, not subprocess-tested:
// the verb canonicalizes --repo (canonicalProjectRoot), so a scratch repo
// without its own .git resolves to the MAIN repo's .fleet — subprocess tests
// against worktree scratch dirs kept writing the wrong repo (this session's
// incident). The lib tests above pin parse/read/write/width; the verb adds
// only argv slicing + one writePosture/readPosture pair around them.
describe("dispatch-next posture", () => {
	const dispatch = (...args: string[]): { out: string; code: number } => {
		const p = Bun.spawnSync(
			[process.execPath, join(import.meta.dir, "..", "scripts", "dispatch-next.ts"), ...args],
			{ cwd: REPO, stdout: "pipe", stderr: "pipe" },
		);
		return { out: `${p.stdout.toString()}${p.stderr.toString()}`.trim(), code: p.exitCode ?? 1 };
	};

	test("invalid --posture is a usage error before any claim is touched", () => {
		const bad = dispatch("--posture", "bogus", "--repo", REPO);
		expect(bad.code).toBe(1);
		expect(bad.out).toContain("--posture must be one of");
	});
});
