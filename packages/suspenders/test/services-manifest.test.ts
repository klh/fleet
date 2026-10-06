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
	renderTarget,
	substitute,
	usedPlaceholders,
	validateSpec,
	type RenderValues,
	type ServiceSpec,
} from "../scripts/install-services.ts";

const FIXTURE: RenderValues = {
	bun: "/usr/local/bin/bun-fixture",
	home: "/Users/fleet-fixture",
	prefix: "/Users/fleet-fixture/.claude/hooks/suspenders",
	repo: "/Volumes/fleet-fixture/packages/suspenders",
	beltUrl: "http://127.0.0.1:4100",
	beltToken: "fixture-belt-token",
};

// minimal plist-XML reader (no XML dep in the workspace): strips comments,
// tokenizes the value forms these units use, recursive-descent parses
// dict/array. Comments/whitespace/DOCTYPE ignored — field parsing only.
type PlistVal =
	| string
	| number
	| boolean
	| PlistVal[]
	| { [k: string]: PlistVal };

function decodeEntities(s: string): string {
	return s
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&amp;", "&");
}

function parsePlistXml(xml: string): { [k: string]: PlistVal } {
	const clean = xml.replace(/<!--[\s\S]*?-->/g, "");
	const tokenRe =
		/<plist[^>]*>|<\/plist>|<key>[\s\S]*?<\/key>|<string>[\s\S]*?<\/string>|<integer>[\s\S]*?<\/integer>|<true\/>|<false\/>|<array>|<\/array>|<dict>|<\/dict>/g;
	const tokens: string[] = [...clean.matchAll(tokenRe)].map((m) => m[0]);
	let i = 0;
	const peek = (): string | undefined => tokens[i];
	function parseValue(): PlistVal {
		const t = tokens[i];
		i += 1;
		if (t === undefined) throw new Error("plist truncated");
		if (t.startsWith("<string>")) return decodeEntities(t.slice(8, -9));
		if (t.startsWith("<integer>")) return Number.parseInt(t.slice(9, -10), 10);
		if (t === "<true/>") return true;
		if (t === "<false/>") return false;
		if (t === "<array>") {
			const arr: PlistVal[] = [];
			while (peek() !== "</array>") arr.push(parseValue());
			i += 1;
			return arr;
		}
		if (t === "<dict>") {
			const d: { [k: string]: PlistVal } = {};
			while (peek() !== "</dict>") {
				const kt = tokens[i];
				i += 1;
				if (kt === undefined || !kt.startsWith("<key>"))
					throw new Error(`expected <key>, got ${kt ?? "EOF"}`);
				const key = decodeEntities(kt.slice(5, -6));
				d[key] = parseValue();
			}
			i += 1;
			return d;
		}
		throw new Error(`unexpected plist token: ${t}`);
	}
	while (tokens[i] !== undefined && !tokens[i].startsWith("<plist")) i += 1;
	i += 1; // step past <plist ...>
	const root = parseValue();
	if (
		typeof root !== "object" ||
		Array.isArray(root) ||
		typeof root === "string" ||
		typeof root === "boolean" ||
		typeof root === "number"
	) {
		throw new Error("plist root is not a dict");
	}
	return root;
}

interface Flat {
	label: string;
	programArguments: string[];
	workingDirectory: string | null;
	environmentVariables: { [k: string]: string } | null;
	keepAlive: boolean;
	runAtLoad: boolean;
	startInterval: number | null;
	calendarHour: number | null;
	calendarMinute: number | null;
	throttleInterval: number | null;
	nice: number | null;
	standardOutPath: string;
	standardErrorPath: string;
}

function project(d: { [k: string]: PlistVal }): Flat {
	const cal = d.StartCalendarInterval;
	const calDict =
		typeof cal === "object" && cal !== null && !Array.isArray(cal)
			? cal
			: undefined;
	const env = d.EnvironmentVariables;
	return {
		label: d.Label as string,
		programArguments: d.ProgramArguments as string[],
		workingDirectory: (d.WorkingDirectory as string) ?? null,
		environmentVariables: (typeof env === "object" &&
		env !== null &&
		!Array.isArray(env)
			? env
			: null) as { [k: string]: string } | null,
		keepAlive: d.KeepAlive === true,
		runAtLoad: d.RunAtLoad === true,
		startInterval: (d.StartInterval as number) ?? null,
		calendarHour: (calDict?.Hour as number) ?? null,
		calendarMinute: (calDict?.Minute as number) ?? null,
		throttleInterval: (d.ThrottleInterval as number) ?? null,
		nice: (d.Nice as number) ?? null,
		standardOutPath: d.StandardOutPath as string,
		standardErrorPath: d.StandardErrorPath as string,
	};
}

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

	test("non-darwin targets die with the sibling-work pointer", () => {
		expect(() => renderTarget("linux", byName("board"), FIXTURE)).toThrow(
			/W488\.2/,
		);
		expect(() => renderTarget("win32", byName("board"), FIXTURE)).toThrow(
			/W488\.3/,
		);
	});
});
