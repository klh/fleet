// test/launchd-launcher.e2e.ts — W2470.2: the ONE generic launchd launcher.
// Rendering half: every confEnv manifest service renders an env-less plist
// whose ProgramArguments route through __PREFIX__/bin/launchd-launcher.ts —
// the unit keeps its own paths/args (launchd never reads fleet conf); only
// the env VALUES centralize into the machine settings' fleet_loop.launchd_env
// rows, applied at START time over the launcher's HOME/PATH/CA baseline.
// Runtime half: the launcher applies the conf row (KLH_SETTINGS fixture),
// execs an unknown service on the baseline alone, and fails closed on a
// malformed settings file — never silently running a service under the
// wrong environment.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { runCli } from "@klh/test-kit";
import {
	defaultRenderValues,
	loadManifest,
	renderDarwin,
	type RenderValues,
	substitute,
} from "../scripts/install/install-services.ts";
import { parsePlistXml } from "./plist-fields.ts";

const LAUNCHER = join(
	import.meta.dir,
	"..",
	"hooks",
	"bin",
	"launchd-launcher.ts",
);
const FIXTURE: RenderValues = {
	bun: "/usr/local/bin/bun-fixture",
	home: "/var/fleet-home-fixture",
	prefix: "/var/fleet-home-fixture/.claude/hooks/suspenders",
	repo: "/Volumes/fleet-fixture/packages/suspenders",
	beltUrl: "http://127.0.0.1:4100",
	beltToken: "fixture-belt-token",
};
// The safe cutover set: services whose env is pure plumbing (HOME/PATH).
// Services whose env carries REAL VALUES (fleet-loop credentials, board
// GOVERNOR_STORE_URL, store-server port, knowledge-api/worker __REPO__
// roots, the envFile-sourced spoke/swarm units) stay on the render-time
// dict until their values have conf homes.
const CUTOVER = [
	"local-dns",
	"local-bar",
	"cloud-gateway",
	"lane-guard",
	"consult-relay",
	"notify",
	"fleet-pulse",
	"claude-insights",
].sort();

test.describe("W2470.2 launchd launcher — rendering", () => {
	test("manifest cutover set is exactly the safe plumbing-env services", () => {
		const names = loadManifest()
			.filter((s) => s.confEnv === true)
			.map((s) => s.name)
			.sort();
		expect(names).toEqual(CUTOVER);
	});

	test("every confEnv service renders an env-less plist routed through the launcher", () => {
		const values = defaultRenderValues({ ...FIXTURE });
		for (const spec of loadManifest().filter((s) => s.confEnv === true)) {
			const d = parsePlistXml(renderDarwin(spec, values));
			expect(d.EnvironmentVariables, spec.name).toBeUndefined();
			const args = d.ProgramArguments as string[];
			const entry = substitute(spec.bunEntry, values);
			expect(args, spec.name).toEqual([
				values.bun,
				`${values.prefix}/bin/launchd-launcher.ts`,
				spec.name,
				"--",
				entry,
				...spec.args.map((a) => substitute(a, values)),
			]);
		}
	});

	test("services with real VALUES keep the render-time env dict", () => {		const values = defaultRenderValues({ ...FIXTURE });
		for (const name of [
			"fleet-loop",
			"board",
			"store-server",
			"knowledge-api",
			"knowledge-worker",
		]) {
			const spec = loadManifest().find((s) => s.name === name);
			expect(spec, name).toBeDefined();
			const d = parsePlistXml(renderDarwin(spec, values));
			expect(d.EnvironmentVariables, name).toBeDefined();
			expect(d.ProgramArguments, name).not.toContain("launchd-launcher.ts");
		}
	});
});

// ---- runtime: the launcher itself, spawned as launchd would ----
interface ChildOut {
	confRow: string | null;
	inherited: string | null;
	baselinePathHasSbin: boolean;
	ca: string | null;
	args: string[];
}

function probeEntry(dir: string): string {
	const entry = join(dir, "probe.ts");
	writeFileSync(
		entry,
		'console.log(JSON.stringify({confRow:process.env.LAUNCHD_ENV_PROBE??null,inherited:process.env.INHERITED_PROBE??null,baselinePathHasSbin:(process.env.PATH??"").split(":").includes("/usr/sbin"),ca:process.env.NODE_EXTRA_CA_CERTS??null,args:process.argv.slice(2)}));',
	);
	return entry;
}

const conf = (launchdEnv: unknown): string => {
	const dir = mkdtempSync(join(tmpdir(), "w24702-launcher-"));
	const file = join(dir, "settings.json");
	writeFileSync(
		file,
		JSON.stringify({ fleet_loop: { launchd_env: launchdEnv } }),
	);
	return file;
};

test.describe("W2470.2 launchd launcher — runtime", () => {
	test("conf row applies over baseline; inherited env and argv pass through", () => {
		const dir = mkdtempSync(join(tmpdir(), "w24702-launcher-"));
		const entry = probeEntry(dir);
		const settings = conf({ "row-probe": { LAUNCHD_ENV_PROBE: "from-conf" } });
		const r = runCli(LAUNCHER, ["row-probe", "--", entry, "extra-arg"], {
			env: {
				KLH_SETTINGS: settings,
				INHERITED_PROBE: "inherited",
			},
		});
		expect(r.code, r.err).toBe(0);
		const parsed = JSON.parse(r.out) as ChildOut;
		expect(parsed.confRow).toBe("from-conf");
		expect(parsed.inherited).toBe("inherited");
		expect(parsed.baselinePathHasSbin).toBe(true);
		expect(parsed.args).toEqual(["extra-arg"]);
	});

	test("unknown service (no conf row) execs on the baseline alone", () => {
		const dir = mkdtempSync(join(tmpdir(), "w24702-launcher-"));
		const entry = probeEntry(dir);
		const r = runCli(LAUNCHER, ["unlisted", "--", entry], {
			env: { KLH_SETTINGS: conf({}) },
		});
		expect(r.code, r.err).toBe(0);
		const parsed = JSON.parse(r.out) as ChildOut;
		expect(parsed.confRow).toBe(null);
		expect(parsed.baselinePathHasSbin).toBe(true);
	});

	test("malformed settings fail closed before exec", () => {
		const dir = mkdtempSync(join(tmpdir(), "w24702-launcher-"));
		const entry = probeEntry(dir);
		const settings = conf({});
		writeFileSync(settings, "{not json");
		const r = runCli(LAUNCHER, ["row-probe", "--", entry], {
			env: { KLH_SETTINGS: settings },
		});
		expect(r.code).toBe(1);
		expect(r.err).toContain("settings unreadable");
		expect(r.out).toBe("");
	});

	test("invalid conf row shape fails closed (schema law, loud drift)", () => {
		const dir = mkdtempSync(join(tmpdir(), "w24702-launcher-"));
		const entry = probeEntry(dir);
		const r = runCli(LAUNCHER, ["row-probe", "--", entry], {
			env: { KLH_SETTINGS: conf({ "row-probe": { "lowercase-key": "v" } }) },
		});
		expect(r.code).toBe(1);
		expect(r.err).toContain("settings unreadable");
		expect(r.out).toBe("");
	});

	test("usage error exits 64 without reading settings", () => {
		const r = runCli(LAUNCHER, ["just-a-service"]);
		expect(r.code).toBe(64);
		expect(r.err).toContain("usage:");
	});

	test("NODE_EXTRA_CA_CERTS baseline picks up the local Caddy CA when present", () => {
		const dir = mkdtempSync(join(tmpdir(), "w24702-launcher-ca-"));
		const entry = probeEntry(dir);
		const ca = join(
			dir,
			"Library",
			"Application Support",
			"Caddy",
			"pki",
			"authorities",
			"local",
			"root.crt",
		);
		mkdirSync(join(ca, ".."), { recursive: true });
		writeFileSync(ca, "fixture CA");
		const r = runCli(LAUNCHER, ["ca-probe", "--", entry], {
			env: {
				KLH_SETTINGS: conf({}),
				HOME: dir,
				KLH_LOCAL_CA_FILE: undefined,
			},
		});
		expect(r.code, r.err).toBe(0);
		const parsed = JSON.parse(r.out) as ChildOut;
		expect(parsed.ca).toBe(ca);
	});
});
