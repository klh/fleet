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
import { INSTALL_CONTRACT } from "../scripts/install/install-contract.ts";
import {
	retireBuckleUpstreamsEnv,
	wireBeltRowSettings,
} from "../scripts/lib/belt-row-settings.ts";
import {
	BELT_UPSTREAM_KEY_VAR,
	ensureBeltUpstreamKey,
	readBeltEnvVar,
	verifyBeltPeerWiring,
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

	test("W2760 belt row: lands in settings.json, idempotent, fail closed", () => {
		const home = tmp();
		const settings = join(home, "settings.json");
		// absent file seeds settings.json with the authenticated row
		expect(wireBeltRowSettings(settings).status).toBe("wired");
		let doc = JSON.parse(readFileSync(settings, "utf8")) as {
			upstreams: { groups: Record<string, unknown[]> };
		};
		expect(doc.upstreams.groups.belt?.length).toBe(1);
		expect(wireBeltRowSettings(settings).status).toBe("kept");
		// operator sections are preserved
		const withRows = join(home, "settings2.json");
		writeFileSync(
			withRows,
			JSON.stringify({ upstreams: { groups: { "glm-local": [{}] } } }),
			{ mode: 0o600 },
		);
		expect(wireBeltRowSettings(withRows).status).toBe("wired");
		doc = JSON.parse(readFileSync(withRows, "utf8"));
		expect(Object.keys(doc.upstreams.groups).sort()).toEqual([
			"belt",
			"glm-local",
		]);
		// unparseable bytes are refused — never guesses over operator content
		const broken = join(home, "broken.json");
		writeFileSync(broken, "{nope", { mode: 0o600 });
		expect(wireBeltRowSettings(broken).status).toBe("failed");
		scrub();
	});

	test("W2760 retire: BUCKLE_UPSTREAMS pins drop from env files, idempotent", () => {
		const home = tmp();
		const beltEnv = writeBeltEnv(home, "A=1\nBUCKLE_UPSTREAMS=/tmp/x.yaml\n");
		expect(retireBuckleUpstreamsEnv(beltEnv).status).toBe("wired");
		expect(readFileSync(beltEnv, "utf8")).toBe("A=1\n");
		expect(retireBuckleUpstreamsEnv(beltEnv).status).toBe("kept");
		const dupes = writeBeltEnv(
			home,
			"BUCKLE_UPSTREAMS=/a\nBUCKLE_UPSTREAMS=/b\n",
		);
		expect(retireBuckleUpstreamsEnv(dupes).status).toBe("failed");
		expect(retireBuckleUpstreamsEnv(join(home, "absent.env")).status).toBe(
			"kept",
		);
		scrub();
	});

	test("W2760 verifyBeltPeerWiring: parity probe over the settings law home", () => {
		const home = tmp();
		const beltEnv = writeBeltEnv(home, "A=1\n", 0o644);
		const settings = join(home, "settings.json");
		const before = verifyBeltPeerWiring(
			{ beltEnvPath: beltEnv, overridePath: settings },
			{},
		);
		expect(before.ok).toBe(false);
		expect(before.reasons.length).toBe(3);
		ensureBeltUpstreamKey(beltEnv);
		wireBeltRowSettings(settings);
		retireBuckleUpstreamsEnv(beltEnv);
		const after = verifyBeltPeerWiring(
			{ beltEnvPath: beltEnv, overridePath: settings },
			{},
		);
		expect(after.ok).toBe(true);
		scrub();
	});
});
