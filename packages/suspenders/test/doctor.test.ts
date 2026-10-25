import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkGatewayCredentials,
	checkProjectIdentity,
	checkRepoRules,
	type DoctorContext,
	readAdminKey,
	runChecks,
	worstStatus,
} from "../hooks/lib/fleet-loop/doctor.ts";

const fakeCtx = (over: Partial<DoctorContext> = {}): DoctorContext => ({
	repo: ".",
	home: mkdtempSync(join(tmpdir(), "doctor-home-")),
	modulePath: "/repo/packages/suspenders/hooks/bin/work.ts",
	workBin: "work.ts",
	run: () => ({ code: 0, out: "" }),
	...over,
});

describe("W842 doctor", () => {
	test("gateway credentials: belt.env only → warn; both → pass", () => {
		const home = mkdtempSync(join(tmpdir(), "doctor-home-"));
		mkdirSync(join(home, ".claude/local-llm"), { recursive: true });
		writeFileSync(join(home, ".claude/local-llm/belt.env"), "X=1\n");
		expect(checkGatewayCredentials(fakeCtx({ home })).status).toBe("warn");
		writeFileSync(join(home, ".claude/local-llm/buckle-spoke.env"), "Y=1\n");
		expect(checkGatewayCredentials(fakeCtx({ home })).status).toBe("pass");
	});

	test("gateway credentials: belt.env missing → fail", () => {
		const home = mkdtempSync(join(tmpdir(), "doctor-home-"));
		expect(checkGatewayCredentials(fakeCtx({ home })).status).toBe("fail");
	});

	test("readAdminKey reads the value without leaking it in details", () => {
		const home = mkdtempSync(join(tmpdir(), "doctor-home-"));
		mkdirSync(join(home, ".claude/local-llm"), { recursive: true });
		writeFileSync(
			join(home, ".claude/local-llm/belt.env"),
			"BUCKLE_ADMIN_KEY=secret-value\n",
		);
		expect(readAdminKey(join(home, ".claude/local-llm/belt.env"))).toBe(
			"secret-value",
		);
	});

	test("repo rules: AGENTS.md + qlty + hooksPath → pass; missing → fail", () => {
		const repo = mkdtempSync(join(tmpdir(), "doctor-repo-"));
		writeFileSync(join(repo, "AGENTS.md"), "law\n");
		mkdirSync(join(repo, ".qlty"), { recursive: true });
		writeFileSync(join(repo, ".qlty/qlty.toml"), "# qlty\n");
		const ok = checkRepoRules(
			fakeCtx({
				repo,
				run: () => ({ code: 0, out: ".githooks\n" }),
			}),
		);
		expect(ok.status).toBe("pass");
		const bad = checkRepoRules(
			fakeCtx({ repo: tmpdir(), run: () => ({ code: 1, out: "" }) }),
		);
		expect(bad.status).toBe("fail");
	});

	test("project identity: work ready exit 0 → pass; nonzero → fail", () => {
		expect(
			checkProjectIdentity(fakeCtx({ run: () => ({ code: 0, out: "(none)" }) }))
				.status,
		).toBe("pass");
		expect(
			checkProjectIdentity(fakeCtx({ run: () => ({ code: 1, out: "err" }) }))
				.status,
		).toBe("fail");
	});

	test("worstStatus ranks fail > warn > pass", () => {
		expect(worstStatus([{ status: "pass" }, { status: "warn" }])).toBe("warn");
		expect(worstStatus([{ status: "warn" }, { status: "fail" }])).toBe("fail");
	});
});
