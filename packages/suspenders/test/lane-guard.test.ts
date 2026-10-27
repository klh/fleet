// test/lane-guard.test.ts — W1141 lane guard: conf grammar (inert posture),
// egress hostname matching, receive-pack command parsing, the credential-
// layer push verdict, credential verification, and the trailer gate.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	egressAuthorityHost,
	egressHostAllowed,
	laneClaimBranch,
	loadLaneGuardConf,
	mintLanePushIdentity,
	parseReceivePackCommands,
	pushRefVerdict,
	trailerVerdict,
	verifyPushCredential,
	wireLanePushScope,
} from "../hooks/lib/lane-guard.ts";

const withEnv = (k: string, v: string | undefined, fn: () => void): void => {
	const prev = process.env[k];
	if (v === undefined) delete process.env[k];
	else process.env[k] = v;
	try {
		fn();
	} finally {
		if (prev === undefined) delete process.env[k];
		else process.env[k] = prev;
	}
};

const pkt = (s: string): string =>
	(s.length + 4).toString(16).padStart(4, "0") + s;

const receivePackBody = (cmds: string[]): Uint8Array =>
	new TextEncoder().encode(
		`${cmds.map(pkt).join("")}0000PACK${"\u0000".repeat(12)}`,
	);

describe("lane-guard conf (W1141)", () => {
	test("absent conf → inert; SUSPENDERS_LANE_GUARD=0 → disabled; parse failure → inert", () => {
		withEnv("SUSPENDERS_LANE_GUARD", "/nonexistent/w1141.json", () => {
			expect(loadLaneGuardConf()).toBeNull();
		});
		withEnv("SUSPENDERS_LANE_GUARD", "0", () => {
			expect(loadLaneGuardConf()).toBeNull();
		});
		withEnv("SUSPENDERS_LANE_GUARD", join(tmpdir(), "w1141-no-dir-x"), () => {
			expect(loadLaneGuardConf()).toBeNull();
		});
	});

	test("a conf file parses", () => {
		const f = join(mkdtempSync(join(tmpdir(), "w1141-conf-")), "g.json");
		writeFileSync(
			f,
			JSON.stringify({
				push: { mode: "enforce" },
				egress: { allow: ["*.local", "github.com"] },
				trailers: "enforce",
			}),
		);
		withEnv("SUSPENDERS_LANE_GUARD", f, () => {
			const conf = loadLaneGuardConf();
			expect(conf?.push?.mode).toBe("enforce");
			expect(conf?.egress?.allow).toEqual(["*.local", "github.com"]);
			expect(conf?.trailers).toBe("enforce");
		});
	});
});

describe("egress host matching", () => {
	const allow = ["127.0.0.1", "::1", "*.local", "github.com"];

	test("exact, wildcard, ip, trailing dot, case; deny default", () => {
		expect(egressHostAllowed("github.com", allow)).toBe(true);
		expect(egressHostAllowed("GITHUB.com.", allow)).toBe(true);
		expect(egressHostAllowed("belt.local", allow)).toBe(true);
		expect(egressHostAllowed("a.b.local", allow)).toBe(true);
		expect(egressHostAllowed("127.0.0.1", allow)).toBe(true);
		expect(egressHostAllowed("evil.example", allow)).toBe(false);
		expect(egressHostAllowed("notgithub.com", allow)).toBe(false);
		expect(egressHostAllowed("github.com.evil.example", allow)).toBe(false);
		expect(egressHostAllowed("", allow)).toBe(false);
	});

	test("authority host extraction strips the port", () => {
		expect(egressAuthorityHost("belt.local:443")).toBe("belt.local");
		expect(egressAuthorityHost("127.0.0.1:8080")).toBe("127.0.0.1");
	});
});

describe("receive-pack parsing + push verdict", () => {
	const shaA = `0${"a".repeat(39)}`;
	const shaB = `0${"b".repeat(39)}`;
	const ref = "refs/heads/suspenders/W9999";

	test("laneClaimBranch mirrors the worktree-provision branch", () => {
		expect(laneClaimBranch("W1141")).toBe("suspenders/W1141");
	});

	test("parses commands, tolerates capabilities + shallow lines", () => {
		const body = receivePackBody([
			`${shaA} ${shaB} ${ref}\u0000report-status-v2 atomic`,
			`shallow ${shaB}`,
		]);
		const cmds = parseReceivePackCommands(body);
		expect(cmds).toHaveLength(1);
		expect(cmds?.[0]?.refname).toBe(ref);
	});

	test("unparseable body → null (the proxy refuses rather than guesses)", () => {
		expect(
			parseReceivePackCommands(new TextEncoder().encode("nope")),
		).toBeNull();
		expect(parseReceivePackCommands(new Uint8Array(0))).toBeNull();
	});

	test("own branch allowed; main, sibling branch, tag, deletion refused", () => {
		const v = (refname: string, del = false) =>
			pushRefVerdict(
				parseReceivePackCommands(
					receivePackBody([
						`${shaA} ${del ? "0".repeat(40) : shaB} ${refname}`,
					]),
				) ?? [],
				"suspenders/W9999",
			);
		expect(v(ref).ok).toBe(true);
		expect(v("refs/heads/main").ok).toBe(false);
		expect(v("refs/heads/suspenders/W8888").ok).toBe(false);
		expect(v("refs/tags/v1").ok).toBe(false);
		expect(v(ref, true).ok).toBe(false);
		expect(v(ref).why).toBeUndefined();
	});
});

describe("push credentials", () => {
	test("mint → verify round-trip; wrong token and unknown sid fail", () => {
		const repo = mkdtempSync(join(tmpdir(), "w1141-tok-"));
		const ident = mintLanePushIdentity(repo, "autow9999-x", "W9999");
		const auth = `Basic ${btoa(`${ident.sid}:${ident.token}`)}`;
		expect(verifyPushCredential(auth, repo)?.branch).toBe("suspenders/W9999");
		expect(
			verifyPushCredential(`Basic ${btoa(`${ident.sid}:wrong`)}`, repo),
		).toBeNull();
		expect(verifyPushCredential("Basic dmltOm5vcGU=", repo)).toBeNull();
		expect(verifyPushCredential(null, repo)).toBeNull();
		rmSync(repo, { recursive: true, force: true });
	});
});

describe("trailer gate (W1141 transcript tracing)", () => {
	const lines = (rows: string[]): string => rows.join("\n");
	const runOf = (out: string) => (args: string[]) =>
		args[0] === "log" ? out : null;

	test("commits carrying the lane sid pass", () => {
		const out = lines([
			`0${"1".repeat(39)}\t0${"2".repeat(39)}\tautow1141-p98b319584008df14`,
		]);
		const v = trailerVerdict({
			repo: "/tmp/unused",
			baseline: `0${"0".repeat(39)}`,
			sha: `0${"3".repeat(39)}`,
			sid: "autow1141-p98b319584008df14",
			run: runOf(out) as never,
		});
		expect(v.ok).toBe(true);
		expect(v.note).toBeUndefined();
	});

	test("missing trailer → audit note; enforce → refusal; off → silent", () => {
		const out = lines([`0${"1".repeat(39)}\t0${"2".repeat(39)}\t`]);
		const base = {
			repo: "/tmp/unused",
			baseline: `0${"0".repeat(39)}`,
			sha: `0${"3".repeat(39)}`,
			sid: "autow1141-p98b319584008df14",
			run: runOf(out) as never,
		};
		withEnv("SUSPENDERS_TRAILER_GATE", "audit", () => {
			const a = trailerVerdict(base);
			expect(a.ok).toBe(true);
			expect(a.note).toContain("[audit]");
		});
		withEnv("SUSPENDERS_TRAILER_GATE", "enforce", () => {
			const e = trailerVerdict(base);
			expect(e.ok).toBe(false);
			expect(e.why).toContain("Fleet-Session");
		});
		withEnv("SUSPENDERS_TRAILER_GATE", "off", () => {
			expect(trailerVerdict(base).note).toBeUndefined();
		});
	});

	test("merge commits are exempt from the trailer requirement", () => {
		const out = lines([
			`0${"4".repeat(39)}\t0${"1".repeat(39)} 0${"2".repeat(39)}\t`,
		]);
		const v = trailerVerdict({
			repo: "/tmp/unused",
			baseline: `0${"0".repeat(39)}`,
			sha: `0${"5".repeat(39)}`,
			sid: "autow1141-p98b319584008df14",
			run: runOf(out) as never,
		});
		expect(v.ok).toBe(true);
		expect(v.note).toBeUndefined();
	});
});

describe("wireLanePushScope (take-time credential scoping)", () => {
	test("enforce pins a worktree-local scoped pushurl; audit wires nothing", () => {
		const repo = mkdtempSync(join(tmpdir(), "w1141-scope-"));
		const sh = (args: string[], cwd = repo) =>
			Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
		sh(["init", "-q", "-b", "main", "."]);
		sh([
			"-c",
			"user.email=t@local",
			"-c",
			"user.name=t",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"i",
		]);
		const wt = join(repo, "wt");
		sh(["worktree", "add", "-q", wt, "-b", "side"]);
		const conf = join(mkdtempSync(join(tmpdir(), "w1141-sc-")), "g.json");
		writeFileSync(conf, JSON.stringify({ push: { mode: "enforce" } }));
		withEnv("SUSPENDERS_LANE_GUARD", conf, () => {
			const ident = wireLanePushScope(repo, wt, "W9999", "autow9999-x");
			expect(ident?.branch).toBe("suspenders/W9999");
		});
		const url = sh(["config", "--worktree", "remote.origin.pushurl"], wt)
			.stdout.toString()
			.trim();
		expect(url.startsWith("http://autow9999-x:")).toBe(true);
		expect(url.endsWith("@127.0.0.1:7818/fleet.git")).toBe(true);
		writeFileSync(conf, JSON.stringify({ push: { mode: "audit" } }));
		withEnv("SUSPENDERS_LANE_GUARD", conf, () => {
			expect(wireLanePushScope(repo, wt, "W9998", "autow9998-y")).toBeNull();
		});
	});
});
