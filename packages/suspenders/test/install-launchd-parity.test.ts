// test/install-launchd-parity.test.ts — W490.2: the registerLaunchd step's
// rendered plists are FIELD-EQUIVALENT to what install.sh's sed pass produces.
// The bash sed pass is re-implemented here with faithful per-line semantics
// (each -e pass replaces the FIRST occurrence per line — __HOME__ is the one
// global pass), applied over the same template plists with the SAME fixture
// substitutions the step passes (bun/home/prefix/belt belt ride env).
// Rendering rides the real install-services.ts subprocess — the exact
// mechanism the step uses — so parity covers the wiring, not just the
// emitter. Field-equivalence, not byte-equality: the emitter reformats.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import {
	TEMPLATE_DIR,
	defaultRenderValues,
} from "../scripts/install-services.ts";
import { parsePlistXml, project } from "./plist-fields.ts";

const SCRIPTS = join(import.meta.dir, "..", "scripts");
const FIXTURE = {
	bun: "/usr/local/bin/bun-fixture",
	home: "/Users/fleet-fixture",
	prefix: "/Users/fleet-fixture/.claude/hooks/suspenders",
	repo: "/Volumes/fleet-fixture/packages/suspenders",
	beltUrl: "http://127.0.0.1:4100",
	beltToken: "fixture-belt-token",
};

// install.sh (pre-W490.2): sed -e "s|__BUN__|$BUN_BIN|" -e "s|__HOME__|$HOME|g"
// -e "s|__PREFIX__|$PREFIX|" -e "s|__REPO__|$REPO_DIR|" -e
// "s|__BELT_URL__|${BELT_URL:-http://127.0.0.1:4100}|" -e
// "s|__BELT_TOKEN__|${BELT_TOKEN:-}|" — per line, each pass replaces its FIRST
// occurrence only; __HOME__ is the one global pass.
function sedPass(
	xml: string,
	v: {
		bun: string;
		home: string;
		prefix: string;
		repo: string;
		beltUrl: string;
		beltToken: string;
	},
): string {
	const passes: Array<[string, string, boolean]> = [
		["__BUN__", v.bun, false],
		["__HOME__", v.home, true],
		["__PREFIX__", v.prefix, false],
		["__REPO__", v.repo, false],
		["__BELT_URL__", v.beltUrl, false],
		["__BELT_TOKEN__", v.beltToken, false],
	];
	return xml
		.split("\n")
		.map((line) => {
			let out = line;
			for (const [token, value, isGlobal] of passes) {
				out = isGlobal
					? out.replaceAll(token, value)
					: out.replace(token, value);
			}
			return out;
		})
		.join("\n");
}

describe("registerLaunchd parity (W490.2)", () => {
	const outDir = mkdtempSync(join(tmpdir(), "w490-parity-"));

	test("install-services.ts renders the template file set via the step mechanism", async () => {
		await execa(
			"bun",
			[
				join(SCRIPTS, "install-services.ts"),
				"--target",
				"darwin",
				"--out",
				outDir,
				"--json",
				"--bun",
				FIXTURE.bun,
				"--home",
				FIXTURE.home,
				"--prefix",
				FIXTURE.prefix,
				"--repo",
				FIXTURE.repo,
			],
			{
				env: {
					...process.env,
					BELT_URL: FIXTURE.beltUrl,
					BELT_TOKEN: FIXTURE.beltToken,
				},
			},
		);
		const templates = readdirSync(TEMPLATE_DIR)
			.filter((f) => f.endsWith(".plist"))
			.sort();
		expect(readdirSync(outDir).sort()).toEqual(templates);
	});

	test("step render is field-equivalent to the sed pass for every template", () => {
		const templates = readdirSync(TEMPLATE_DIR)
			.filter((f) => f.endsWith(".plist"))
			.sort();
		for (const file of templates) {
			const templateXml = readFileSync(join(TEMPLATE_DIR, file), "utf8");
			const bashSide = project(parsePlistXml(sedPass(templateXml, FIXTURE)));
			const tsSide = project(
				parsePlistXml(readFileSync(join(outDir, file), "utf8")),
			);
			if (file === "com.suspenders.fleet-loop.plist") {
				// Canonical manifest explicitly adds target 6; legacy template predates that policy.
				const args = bashSide.programArguments;
				const position = args.indexOf("--glob");
				args.splice(position, 0, "--target", "6");
			}
			if (
				file === "com.suspenders.llm-keepwarm.plist" ||
				file === "com.suspenders.local-llm.plist"
			) {
				// W500 minimal-tier safety policy is canonical; old sed templates predate it.
				bashSide.environmentVariables = {
					...bashSide.environmentVariables,
					BELT_TIER: "minimal",
				};
			}
			expect(tsSide, file).toEqual(bashSide);
		}
		expect(templates.length).toBeGreaterThan(10);
	});

	test("step default substitutions resolve like install.sh (prefix env chain)", () => {
		process.env.SUSPENDERS_PREFIX = "/tmp/w490-prefix-fixture";
		try {
			const v = defaultRenderValues({ bun: "b", home: "h", repo: "r" });
			expect(v.prefix).toBe("/tmp/w490-prefix-fixture");
		} finally {
			delete process.env.SUSPENDERS_PREFIX;
		}
	});

	test("belt defaults match install.sh ($BELT_URL / $BELT_TOKEN fallbacks)", () => {
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
});
