// buckle-spoke-health.test.ts — W1278.2: outside-process probe + guarded
// recovery for the Buckle spoke. Stubs only — never touches real loopback
// :4101 or the machine's env files (home is a temp dir; kickstart records
// instead of launchctl).
import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkBuckleSpoke,
	probeSpoke,
	recoverBuckleSpoke,
	type SpokeDeps,
	startupFailureFromLog,
	tailOf,
} from "../hooks/lib/fleet-loop/buckle-spoke-health.ts";

const YAML_PATH = "~/upstreams.yaml";

const incidentLog = (): string =>
	`2026-10-25 10:31:02 booting buckle spoke...\n` +
	`upstreams: BUCKLE_UPSTREAMS=${YAML_PATH} is configured but missing — refusing to fall back to the committed ladder (W1123)\n`;

// stub deps over a temp HOME; kickstart records instead of launchctl
function stubDeps(opts: {
	up?: boolean;
	log?: string;
	files?: Record<string, string>;
	kick?: number;
}): SpokeDeps & { kicks: string[] } {
	const home = mkdtempSync(join(tmpdir(), "buckle-spoke-health-"));
	for (const [p, c] of Object.entries(opts.files ?? {})) {
		const full = join(home, p.replace(/^~\/?/, ""));
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, c);
	}
	const kicks: string[] = [];
	if (opts.log) {
		const lp = join(home, ".claude-insights", "buckle-spoke.log");
		mkdirSync(join(lp, ".."), { recursive: true });
		writeFileSync(lp, opts.log);
	}
	const under = (p: string): string => join(home, p.replace(/^~\/?/, ""));
	const dep: SpokeDeps = {
		home,
		fetch: () =>
			opts.up
				? Promise.resolve(new Response("{}", { status: 200 }))
				: Promise.reject(new Error("stub: dark")),
		readText: (p) => {
			try {
				return readFileSync(under(p), "utf8");
			} catch {
				return null;
			}
		},
		exists: (p) => existsSync(under(p)),
		writeFile: (p, content) => writeFileSync(under(p), content),
		kickstart: (label) => {
			kicks.push(label);
			return Promise.resolve(opts.kick ?? 0);
		},
	};
	return { ...dep, kicks };
}

describe("buckle spoke startup-failure classifier", () => {
	test("reads the W1123 refusal signature, last match wins", () => {
		const f = startupFailureFromLog(`${incidentLog()}${incidentLog()}`);
		expect(f?.configured).toBe(YAML_PATH);
		expect(startupFailureFromLog("all quiet in the log")).toBeNull();
	});

	test("tailOf bounds the read", () => {
		expect(tailOf("abcdef", 3)).toBe("def");
		expect(tailOf(null, 10)).toBe("");
	});
});

describe("probeSpoke", () => {
	test("2xx answers healthy, transport failure does not", async () => {
		expect(await probeSpoke(stubDeps({ up: true }))).toBe(true);
		expect(await probeSpoke(stubDeps({ up: false }))).toBe(false);
	});
});

describe("recoverBuckleSpoke", () => {
	test("never touches a healthy spoke", async () => {
		const d = stubDeps({ up: true, files: { "a.env": YAML_LINE } });
		const r = await recoverBuckleSpoke(d, d.home);
		expect(r.status).toBe("skip-healthy");
		expect(d.kicks).toEqual([]);
		rmHome(d);
	});
});

const YAML_LINE = `BUCKLE_UPSTREAMS=${YAML_PATH}`;
const envFile = (): Record<string, string> => ({
	"~/.claude/local-llm/belt.env": `SOME_KEY=redacted\n${YAML_LINE}\nOTHER=1`,
	"~/upstreams.json": "{}",
});

const rmHome = (deps: { home: string }): void => {
	rmSync(deps.home, { recursive: true, force: true });
};

describe("recoverBuckleSpoke, incident shape", () => {
	test("repoints the env line + kickstarts once", async () => {
		const d = stubDeps({ log: incidentLog(), files: envFile() });
		const r = await recoverBuckleSpoke(d, d.home);
		expect(r.status).toBe("recovered");
		expect(d.kicks).toEqual(["com.suspenders.buckle-spoke"]);
		const after = String(d.readText("~/.claude/local-llm/belt.env"));
		expect(after).toContain("BUCKLE_UPSTREAMS=~/upstreams.json");
		expect(after).toContain("SOME_KEY=redacted");
		expect(after).toContain("OTHER=1");
		rmHome(d);
	});

	test("json missing → unrecoverable, no kick, env untouched", async () => {
		const d = stubDeps({ log: incidentLog() });
		const r = await recoverBuckleSpoke(d, d.home);
		expect(r.status).toBe("unrecoverable");
		expect(d.kicks).toEqual([]);
		rmHome(d);
	});

	test("hold under .fleet/reclaim-paused", async () => {
		const d = stubDeps({ log: incidentLog(), files: envFile() });
		mkdirSync(join(d.home, ".fleet"), { recursive: true });
		writeFileSync(join(d.home, ".fleet", "reclaim-paused"), "");
		const r = await recoverBuckleSpoke(d, d.home);
		expect(r.status).toBe("hold-paused");
		expect(d.kicks).toEqual([]);
		rmHome(d);
	});
});

describe("checkBuckleSpoke", () => {
	test("read-only pass alerts, fix pass recovers", async () => {
		const d = stubDeps({ log: incidentLog(), files: envFile() });
		const ro = await checkBuckleSpoke(
			{ fix: false, home: d.home, repo: d.home },
			d,
		);
		expect(ro.issues).toHaveLength(1);
		expect(ro.fixed).toEqual([]);
		const fx = await checkBuckleSpoke(
			{ fix: true, home: d.home, repo: d.home },
			d,
		);
		expect(fx.issues).toEqual([]);
		expect(fx.fixed[0]).toContain("recovered");
		rmHome(d);
	});

	test("healthy spoke is silent on both passes", async () => {
		const d = stubDeps({ up: true, files: envFile() });
		const r = await checkBuckleSpoke(
			{ fix: true, home: d.home, repo: d.home },
			d,
		);
		expect(r.issues).toEqual([]);
		expect(r.fixed).toEqual([]);
		expect(d.kicks).toEqual([]);
		rmHome(d);
	});

	test("down without the signature alerts, never repairs", async () => {
		const d = stubDeps({ files: envFile() });
		const r = await checkBuckleSpoke(
			{ fix: true, home: d.home, repo: d.home },
			d,
		);
		expect(r.issues[0]).toContain("not answering");
		expect(r.fixed).toEqual([]);
		expect(d.kicks).toEqual([]);
		rmHome(d);
	});
});
