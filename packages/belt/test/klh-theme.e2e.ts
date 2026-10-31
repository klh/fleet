// klh-theme.test.ts — W281, W2269.1.1 cutover: belt wears the shared klh
// theme, single-sourced as @klh/kernel src/kernel.theme.module.ts. The former
// bin/klh-theme.ts vendored copy is retired — the dashboard imports the
// kernel module and the flat deploy homes rewrite the spec at publish time
// (W1475 flatten). The page test boots the real dashboard on a free port
// (mDNS off, scratch HOME) and checks the served HTML: tokens in <head>, one
// klh·fleet strip, the theme gear, and no private palette left behind.
import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	FLEET_NAV_CSS,
	FLEET_NAV_JS,
	fleetNav,
	KLH_THEME_VERSION,
	THEME_HEAD,
	THEME_SETTINGS_CSS,
	THEME_SETTINGS_JS,
} from "@klh/kernel/src/kernel.theme.module.ts";

const RETIRED = join(import.meta.dir, "..", "bin", "klh-theme.ts");
const CANON = join(
	import.meta.dir,
	"..",
	"..",
	"kernel",
	"src",
	"kernel.theme.module.ts",
);
const PIN = {
	version: "1.4.4",
	sha256: "56c7010e59219346b2ecb901468df03999f04e2269abfe41f578605cbba7123c",
};

const sha256 = (bytes: Uint8Array | string): string =>
	createHash("sha256").update(bytes).digest("hex");

const count = (hay: string, needle: string): number =>
	hay.split(needle).length - 1;

test.describe("klh theme single-source (W2269.1.1)", () => {
	test("pinned: version + sha256 of the kernel theme module @ui", () => {
		expect(KLH_THEME_VERSION).toBe(PIN.version);
		expect(sha256(readFileSync(CANON))).toBe(PIN.sha256);
	});

	test("retired: no vendored copy survives in belt bin @ui", () => {
		expect(existsSync(RETIRED)).toBe(false);
	});

	test("dashboard imports the kernel module, not a vendored copy @ui", () => {
		const src = readFileSync(
			join(import.meta.dir, "..", "bin", "dashboard.ts"),
			"utf8",
		);
		expect(src).toContain(
			"from \"@klh/kernel/src/kernel.theme.module.ts\"",
		);
		expect(src).toContain(
			"from \"@klh/kernel/src/kernel.theme-sync.module.ts\"",
		);
		expect(src).not.toContain("./klh-theme");
	});
});

test.describe("belt dashboard page wears the klh theme (W281)", () => {
	let proc: ReturnType<typeof Bun.spawn> | null = null;
	let html = "";

	test.beforeAll(async () => {
		const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
		const port = probe.port;
		probe.stop(true);
		proc = Bun.spawn(
			[process.execPath, join(import.meta.dir, "..", "bin", "dashboard.ts")],
			{
				env: {
					...process.env,
					BELT_PORT: String(port),
					BELT_MDNS: "off",
					HOME: join(import.meta.dir, ".no-home"),
				},
				stdout: "ignore",
				stderr: "ignore",
			},
		);
		for (let i = 0; i < 80 && !html; i++) {
			try {
				const res = await fetch(`http://127.0.0.1:${port}/`);
				if (res.ok) html = await res.text();
			} catch {
				await Bun.sleep(50);
			}
		}
	});

	test.afterAll(() => {
		proc?.kill();
	});

	test("theme tokens + pre-paint lead <head>, before the page's own style @ui", () => {
		const at = html.indexOf(THEME_HEAD);
		expect(at).toBeGreaterThan(-1);
		expect(at).toBeLessThan(html.indexOf("<style>"));
		expect(at).toBeLessThan(html.indexOf("</head>"));
	});

	test("exactly one klh·fleet strip, belt current, first in <body> @ui", () => {
		// the dashboard serves fleetNav("belt", "models") — assert THAT nav
		// (the view-less variant has no aria-current on the Models row)
		const nav = fleetNav("belt", "models");
		expect(count(html, nav)).toBe(1);
		expect(count(html, 'class="klh-fleetnav"')).toBe(1);
		expect(html.indexOf(nav)).toBeGreaterThan(html.indexOf("<body>"));
		expect(html.indexOf(nav)).toBeLessThan(html.indexOf("<header>"));
		expect(html).toContain(FLEET_NAV_CSS);
		expect(html).toContain(FLEET_NAV_JS);
	});

	test("theme gear mounted once with its CSS + JS @ui", () => {
		expect(count(html, 'id="klh-settings"')).toBe(1);
		expect(html).toContain(THEME_SETTINGS_CSS);
		expect(html).toContain(THEME_SETTINGS_JS);
	});

	test("the old one-off topbar and private palette are gone @ui", () => {
		for (const gone of [
			"klh-topbar",
			"tb-link",
			"https://klh/local",
			"#191614",
			"#201d1a",
			"#e8e2d9",
			"#8a857e",
			"#e05a2b",
			"#4a7c4e",
			"#6f6a63",
			"#8ab4ff",
		])
			expect(html).not.toContain(gone);
	});

	test("outside the shared theme, the page hard-codes no colour @ui", () => {
		const own = [THEME_HEAD, FLEET_NAV_CSS, THEME_SETTINGS_CSS].reduce(
			(s, part) => s.split(part).join(""),
			html,
		);
		expect(own).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|color-scheme/i);
	});
});
