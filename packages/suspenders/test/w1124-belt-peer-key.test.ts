// test/w1124-belt-peer-key.test.ts — W1124.2: the authenticated
// Buckle→Belt peer key, installer face. Regression: the fresh-install
// mint seam mints ONE 0600 key into belt.env, stays idempotent, fails
// closed on missing/duplicate state, and never leaks the value through
// the result surface. Restart-order face: seedLocalLlm precedes
// registerLaunchd and both peer-riding plists source belt.env pre-exec.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTALL_CONTRACT } from "../scripts/install-contract.ts";
import {
	BELT_UPSTREAM_KEY_VAR,
	ensureBeltUpstreamKey,
	readBeltEnvVar,
} from "../scripts/lib/belt-upstream-key.ts";
import { parsePlistXml } from "./plist-fields.ts";

setDefaultTimeout(120_000);

const dirs: string[] = [];
const tmp = (): string => {
	const base = join(process.env.HOME ?? tmpdir(), ".cache", "w1124-tests");
	mkdirSync(base, { recursive: true });
	const dir = mkdtempSync(join(base, "peer-key-"));
	dirs.push(dir);
	return dir;
};
const writeBeltEnv = (home: string, body: string, mode = 0o600): string => {
	const p = join(home, "belt.env");
	writeFileSync(p, body, { mode });
	return p;
};
const scrub = (): void => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
};
const LAUNCHD_DIR = join(import.meta.dir, "../hooks/launchd");
const plistSourcesBeltEnvPreExec = (label: string): boolean => {
	const raw = readFileSync(join(LAUNCHD_DIR, `${label}.plist`), "utf8");
	const doc = parsePlistXml(raw) as { ProgramArguments?: string[] };
	const args = doc.ProgramArguments ?? [];
	const envIdx = args.findIndex((a) => a?.endsWith("/belt.env"));
	const execIdx = args.indexOf("__BUN__");
	return envIdx !== -1 && execIdx !== -1 && envIdx < execIdx;
};

describe("W1124.2 belt peer key (installer face)", () => {
	test("fresh-install mint: appended once, 0600, prior bytes preserved", () => {
		const home = tmp();
		const beltEnv = writeBeltEnv(
			home,
			"ANTHROPIC_BASE_URL=http://127.0.0.1:4100\n",
		);
		const res = ensureBeltUpstreamKey(beltEnv);
		expect(res.status).toBe("minted");
		expect(res.fingerprint).toMatch(/^[0-9a-f]{12}$/);
		const body = readFileSync(beltEnv, "utf8");
		expect(body.startsWith("ANTHROPIC_BASE_URL=http://127.0.0.1:4100\n")).toBe(
			true,
		);
		const hits = body
			.split("\n")
			.filter((l) => l.startsWith(`${BELT_UPSTREAM_KEY_VAR}=`));
		expect(hits.length).toBe(1);
		expect(readBeltEnvVar(beltEnv, BELT_UPSTREAM_KEY_VAR)?.length).toBe(48);
		expect(statSync(beltEnv).mode & 0o777).toBe(0o600);
		expect(JSON.stringify(res)).not.toContain(
			readBeltEnvVar(beltEnv, BELT_UPSTREAM_KEY_VAR) ?? "unreachable",
		);
		scrub();
	});

	test("idempotent: second run keeps the value byte-for-byte", () => {
		const home = tmp();
		const beltEnv = writeBeltEnv(home, "A=1\n");
		const first = ensureBeltUpstreamKey(beltEnv);
		const bytes = readFileSync(beltEnv, "utf8");
		const second = ensureBeltUpstreamKey(beltEnv);
		expect(first.status).toBe("minted");
		expect(second.status).toBe("kept");
		expect(second.fingerprint).toBe(first.fingerprint);
		expect(readFileSync(beltEnv, "utf8")).toBe(bytes);
		scrub();
	});

	test("fail closed: missing file, duplicate assignment, bad mint shape", () => {
		const home = tmp();
		expect(ensureBeltUpstreamKey(join(home, "absent.env")).status).toBe(
			"failed",
		);
		const beltEnv = writeBeltEnv(
			home,
			`${BELT_UPSTREAM_KEY_VAR}=a\n${BELT_UPSTREAM_KEY_VAR}=b\n`,
		);
		expect(ensureBeltUpstreamKey(beltEnv).status).toBe("failed");
		const bad = join(home, "bad.env");
		writeFileSync(bad, "B=2\n", { mode: 0o600 });
		const res = ensureBeltUpstreamKey(bad, { mint: () => "short" });
		expect(res.status).toBe("failed");
		expect(readFileSync(bad, "utf8")).toBe("B=2\n");
		scrub();
	});

	test("empty-value line is backfilled (kept would ride an open router)", () => {
		const home = tmp();
		const beltEnv = writeBeltEnv(home, `${BELT_UPSTREAM_KEY_VAR}=\n`);
		const res = ensureBeltUpstreamKey(beltEnv);
		expect(res.status).toBe("minted");
		expect(readBeltEnvVar(beltEnv, BELT_UPSTREAM_KEY_VAR)?.length).toBe(48);
		scrub();
	});

	test("restart order: seedLocalLlm precedes registerLaunchd; plists source belt.env pre-exec", () => {
		const names = INSTALL_CONTRACT.steps.map((s) => s.name);
		expect(names.indexOf("seedLocalLlm")).toBeLessThan(
			names.indexOf("registerLaunchd"),
		);
		expect(plistSourcesBeltEnvPreExec("com.suspenders.belt-swarm")).toBe(true);
		expect(plistSourcesBeltEnvPreExec("com.suspenders.buckle-spoke")).toBe(
			true,
		);
		expect(
			existsSync(join(LAUNCHD_DIR, "com.suspenders.belt-swarm.plist")),
		).toBe(true);
	});
});
