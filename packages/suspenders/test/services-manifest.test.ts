// test/services-manifest.test.ts — W488.1 parity: every service in
// deploy/services.yaml renders FIELD-EQUIVALENT to the hand-written template
// plist it migrates (hooks/launchd/*.plist). Field-equivalence, not byte-
// equality: formatting differs. Both sides get the SAME fixture placeholder
// substitution before parsing, so a divergence in args, schedule keys, env,
// logs, cwd or Nice fails loudly. Also covers placeholder validation (used
// but undeclared / declared but unused / unresolvable tokens) and the
// install.sh-matching belt defaults.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	TEMPLATE_DIR,
	defaultRenderValues,
	loadManifest,
	renderDarwin,
	renderLinux,
	renderLinuxTimer,
	renderTarget,
	renderUnits,
	renderWin32,
	substitute,
	usedPlaceholders,
	validateSpec,
	type RenderValues,
	type ServiceSpec,
} from "../scripts/install-services.ts";
import { parsePlistXml, project } from "./plist-fields.ts";

const FIXTURE: RenderValues = {
	bun: "/usr/local/bin/bun-fixture",
	home: "/Users/fleet-fixture",
	prefix: "/Users/fleet-fixture/.claude/hooks/suspenders",
	repo: "/Volumes/fleet-fixture/packages/suspenders",
	beltUrl: "http://127.0.0.1:4100",
	beltToken: "fixture-belt-token",
};

const services = loadManifest();
const byName = (name: string): ServiceSpec => {
	const spec = services.find((s) => s.name === name);
	if (spec === undefined)
		throw new Error(`service ${name} missing from manifest`);
	return spec;
};

describe("services manifest (W488.1)", () => {
	test("manifest covers exactly the templated plists on disk", () => {
		const onDisk = readdirSync(TEMPLATE_DIR)
			.filter((f) => f.endsWith(".plist"))
			.map((f) => f.replace("com.suspenders.", "").replace(".plist", ""))
			.sort();
		expect(services.map((s) => s.name).sort()).toEqual(onDisk);
	});

	for (const spec of services) {
		test(`${spec.name}: manifest render is field-equivalent to the template plist`, () => {
			const templatePath = join(
				TEMPLATE_DIR,
				`com.suspenders.${spec.name}.plist`,
			);
			const templateXml = substitute(
				readFileSync(templatePath, "utf8"),
				FIXTURE,
			);
			const rendered = renderDarwin(spec, FIXTURE);
			expect(project(parsePlistXml(rendered))).toEqual(
				project(parsePlistXml(templateXml)),
			);
		});
	}

	test("fixture substitution reaches every placeholder class (fleet-loop carries five)", () => {
		const d = parsePlistXml(renderDarwin(byName("fleet-loop"), FIXTURE));
		const args = d.ProgramArguments as string[];
		expect(args[0]).toBe(FIXTURE.bun);
		expect(args).toContain(FIXTURE.repo);
		const env = d.EnvironmentVariables as { [k: string]: string };
		expect(env.HOME).toBe(FIXTURE.home);
		expect(env.ANTHROPIC_BASE_URL).toBe(FIXTURE.beltUrl);
		expect(env.ANTHROPIC_AUTH_TOKEN).toBe(FIXTURE.beltToken);
		expect(env.PATH).toBe(
			"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
		);
	});

	test("belt defaults match install.sh ($BELT_URL / $BELT_TOKEN with fallbacks)", () => {
		const prevUrl = process.env.BELT_URL;
		const prevToken = process.env.BELT_TOKEN;
		delete process.env.BELT_URL;
		delete process.env.BELT_TOKEN;
		try {
			const v = defaultRenderValues({
				bun: "b",
				home: "h",
				prefix: "p",
				repo: "r",
			});
			expect(v.beltUrl).toBe("http://127.0.0.1:4100");
			expect(v.beltToken).toBe("");
		} finally {
			if (prevUrl !== undefined) process.env.BELT_URL = prevUrl;
			if (prevToken !== undefined) process.env.BELT_TOKEN = prevToken;
		}
	});

	test("unresolvable placeholder in a rendered unit fails loudly (sed today leaves it in silently)", () => {
		const spec = byName("board");
		expect(() =>
			renderDarwin({ ...spec, bunEntry: "__MYSTERY__/x.ts" }, FIXTURE),
		).toThrow(/__MYSTERY__/);
	});

	test("placeholders used but not declared fail manifest validation", () => {
		const spec: ServiceSpec = {
			...byName("board"),
			placeholders: ["__BUN__", "__PREFIX__"],
		};
		expect(() => validateSpec(spec)).toThrow(/used but not declared/);
	});

	test("placeholders declared but never used fail manifest validation", () => {
		const spec: ServiceSpec = {
			...byName("board"),
			placeholders: ["__BUN__", "__HOME__", "__PREFIX__", "__REPO__"],
		};
		expect(() => validateSpec(spec)).toThrow(/declared but never used/);
	});

	test("envFile stays a PATH reference only", () => {
		const spec = byName("board");
		const withFile: ServiceSpec = {
			...spec,
			envFile: "__HOME__/.claude/local-llm/belt.env",
		};
		expect(() => validateSpec(withFile)).not.toThrow();
		expect(renderDarwin(withFile, FIXTURE)).toContain(FIXTURE.home);
		expect(usedPlaceholders(withFile)).toContain("__HOME__");
	});

	test("linux and win32 targets render (W488.2/W488.3 landed)", () => {
		expect(renderTarget("linux", byName("board"), FIXTURE)).toContain(
			"[Service]",
		);
		expect(renderTarget("win32", byName("board"), FIXTURE)).toContain(
			"<service>",
		);
	});
});

// ---- linux/systemd (W488.2) verification WITHOUT systemd: structural INI
// checks — every unit parses, required keys present, placeholders resolved,
// keepalive -> Restart=always, interval/calendar -> timer units.

function parseIni(text: string): Record<string, Record<string, string>> {
	const out: Record<string, Record<string, string>> = {};
	let section = "";
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) {
			continue;
		}
		if (line.startsWith("[") && line.endsWith("]")) {
			section = line.slice(1, -1);
			out[section] ??= {};
			continue;
		}
		const eq = line.indexOf("=");
		if (eq === -1) throw new Error(`bad INI line: ${rawLine}`);
		const k = line.slice(0, eq).trim();
		const v = line.slice(eq + 1).trim();
		out[section] ??= {};
		out[section][k] = v;
	}
	return out;
}

const iniByName = (name: string): Record<string, Record<string, string>> =>
	parseIni(renderLinux(byName(name), FIXTURE));

describe("services manifest linux (W488.2)", () => {
	test("every service renders a systemd unit that parses as INI with required keys", () => {
		for (const spec of services) {
			const ini = parseIni(renderLinux(spec, FIXTURE));
			expect(ini.Unit?.Description).toBe(
				`fleet ${spec.name} (deploy/services.yaml)`,
			);
			expect(ini.Service?.ExecStart).toStartWith(`"${FIXTURE.bun}"`);
			expect(ini.Service?.StandardOutput).toStartWith("append:");
			expect(ini.Service?.StandardError).toStartWith("append:");
			expect(ini.Install?.WantedBy).toBe("default.target");
		}
	});

	test("ExecStart resolves every placeholder (no residual tokens in any unit)", () => {
		const residualRe = /__[A-Z][A-Z0-9_]*__/;
		for (const spec of services) {
			for (const u of renderUnits("linux", spec, FIXTURE)) {
				expect(u.body).not.toMatch(residualRe);
			}
		}
		expect(iniByName("fleet-loop").Service?.ExecStart).toContain(FIXTURE.repo);
	});

	test("keepalive maps to Restart=always; ThrottleInterval becomes RestartSec", () => {
		const board = iniByName("board").Service;
		expect(board?.Restart).toBe("always");
		expect(board?.RestartSec).toBe("5s");
		const relay = iniByName("consult-relay").Service;
		expect(relay?.Restart).toBe("always");
		expect(relay?.RestartSec).toBe("10s");
	});

	test("intervalSeconds renders a timer with OnBootSec + OnUnitActiveSec", () => {
		const timer = renderLinuxTimer(byName("fleet-monitor"));
		if (timer === null) throw new Error("fleet-monitor timer missing");
		const ini = parseIni(timer);
		expect(ini.Timer?.OnBootSec).toBe("900s");
		expect(ini.Timer?.OnUnitActiveSec).toBe("900s");
		expect(ini.Timer?.Unit).toBe("suspenders-fleet-monitor.service");
		expect(ini.Install?.WantedBy).toBe("timers.target");
	});

	test("calendar maps to OnCalendar + Persistent (db-backup daily 10:00)", () => {
		const timer = renderLinuxTimer(byName("db-backup"));
		if (timer === null) throw new Error("db-backup timer missing");
		const ini = parseIni(timer);
		expect(ini.Timer?.OnCalendar).toBe("*-*-* 10:00:00");
		expect(ini.Timer?.Persistent).toBe("true");
	});

	test("timer-backed services are Type=oneshot; residents Restart, never both", () => {
		expect(iniByName("db-backup").Service?.Type).toBe("oneshot");
		expect(iniByName("fleet-monitor").Service?.Type).toBe("oneshot");
		expect(iniByName("db-backup").Service?.Restart).toBeUndefined();
		expect(iniByName("harvest").Service?.Restart).toBeUndefined();
	});

	test("Nice maps to Nice= (llm-keepwarm 10)", () => {
		expect(iniByName("llm-keepwarm").Service?.Nice).toBe("10");
	});

	test("envFile renders EnvironmentFile (PATH only)", () => {
		const withFile: ServiceSpec = {
			...byName("board"),
			envFile: "__HOME__/.claude/local-llm/belt.env",
		};
		const ini = parseIni(renderLinux(withFile, FIXTURE));
		expect(ini.Service?.EnvironmentFile).toBe(
			`"${FIXTURE.home}/.claude/local-llm/belt.env"`,
		);
	});
});

// ---- win32/WinSW (W488.3) verification: tiny structural XML checks (same
// hand-rolled spirit as the plist parser above) — required elements per
// service, tag balance, schedule + secret mappings across all 12.

function xmlElementsBalanced(xml: string): void {
	const clean = xml.replace(/<!--[\s\S]*?-->/g, "");
	const stack: string[] = [];
	for (const m of clean.matchAll(/<\/?([a-z][a-z0-9]*)[^>]*>/g)) {
		const full = m[0];
		const name = m[1];
		if (full.startsWith("</")) {
			const top = stack.pop();
			if (top !== name) {
				throw new Error(`mismatched ${full} (open ${top ?? "EOF"})`);
			}
		} else if (!full.endsWith("/>")) {
			stack.push(name);
		}
	}
	if (stack.length > 0) throw new Error(`unclosed ${stack.join(" ")}`);
}

function xmlText(xml: string, tag: string): string | null {
	const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
	return m === null ? null : m[1];
}

const winByName = (name: string): string => renderWin32(byName(name), FIXTURE);

describe("services manifest win32 (W488.3)", () => {
	test("every service renders WinSW XML that balances with required elements", () => {
		for (const spec of services) {
			const xml = winByName(spec.name);
			xmlElementsBalanced(xml);
			expect(xmlText(xml, "id")).toBe(`suspenders-${spec.name}`);
			expect(xmlText(xml, "name")).toBe(`suspenders-${spec.name}`);
			expect(xmlText(xml, "executable")).toBe(FIXTURE.bun);
			expect(xmlText(xml, "arguments")).not.toBe("");
			expect(xmlText(xml, "logpath")).not.toBe("");
			expect(xml).toContain('<log mode="roll"/>');
			expect(xml).toContain("<startmode>Automatic</startmode>");
			expect(xml).toContain(
				"<stopparentprocessfirst>true</stopparentprocessfirst>",
			);
		}
	});

	test("no secret material leaks into any emitted XML (envFile stays a PATH reference)", () => {
		for (const spec of services) {
			const xml = winByName(spec.name);
			expect(xml).not.toContain("BUCKLE_ROOT_KEY");
			expect(xml.toLowerCase()).not.toContain("<envfile");
		}
		const withFile: ServiceSpec = {
			...byName("board"),
			envFile: "__HOME__/.claude/local-llm/belt.env",
		};
		const xml = renderWin32(withFile, {
			...FIXTURE,
			beltToken: "SENTINEL-SECRET-VALUE",
		});
		expect(xml).toContain(`${FIXTURE.home}/.claude/local-llm/belt.env`);
		expect(xml).not.toContain("SENTINEL-SECRET-VALUE");
	});

	test("keepalive maps to <onfailure action=restart>; scheduled services carry schtasks hints", () => {
		const board = winByName("board");
		expect(board).toContain('<onfailure action="restart" delay="5 sec"/>');
		const relay = winByName("consult-relay");
		expect(relay).toContain('<onfailure action="restart" delay="10 sec"/>');
		const backup = winByName("db-backup");
		expect(backup).not.toMatch(/^\s*<onfailure/m);
		expect(backup).toContain("/SC DAILY");
		expect(backup).toContain("/ST 10:00");
		expect(backup).toContain("/TN suspenders-db-backup");
		const monitor = winByName("fleet-monitor");
		expect(monitor).toContain("/SC MINUTE /MO 15");
		expect(monitor).toContain("/TN suspenders-fleet-monitor");
	});

	test("nice maps to <priority> (llm-keepwarm belownormal)", () => {
		expect(winByName("llm-keepwarm")).toContain(
			"<priority>belownormal</priority>",
		);
	});

	test("renderUnits file contract: primary + timer naming, all three targets", () => {
		const backupUnits = renderUnits("linux", byName("db-backup"), FIXTURE);
		expect(backupUnits.map((u) => u.file)).toEqual([
			"suspenders-db-backup.service",
			"suspenders-db-backup.timer",
		]);
		const boardUnits = renderUnits("linux", byName("board"), FIXTURE);
		expect(boardUnits.map((u) => u.file)).toEqual(["suspenders-board.service"]);
		const winUnits = renderUnits("win32", byName("board"), FIXTURE);
		expect(winUnits.map((u) => u.file)).toEqual(["suspenders-board.xml"]);
		const plistUnits = renderUnits("darwin", byName("board"), FIXTURE);
		expect(plistUnits.map((u) => u.file)).toEqual([
			"com.suspenders.board.plist",
		]);
	});

	test("fleet-loop env rides render-time substitution (belt URL, non-secret parity)", () => {
		const xml = winByName("fleet-loop");
		expect(xml).toContain(`value="${FIXTURE.beltUrl}"`);
	});
});
