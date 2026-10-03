// theme.test.ts — W269: the klh dark/light theme layer — token swap CSS,
// pre-paint resolution + persistence (localStorage `klh-theme`, system =
// prefers-color-scheme), the settings-panel binding, and every page wearing
// the tokens instead of hardcoded palette colors.
import { describe, expect, test } from "bun:test";
import {
	settingsBlock,
	THEME_CSS,
	THEME_HEAD,
	THEME_KEY,
	THEME_PREPAINT_JS,
	THEME_SETTINGS_JS,
	TOKENS,
} from "../hooks/lib/theme.ts";
import { HTML } from "../hooks/bin/fleet-board-html.ts";
import { consolePage } from "../hooks/bin/console-html.ts";

type Listener = (e: { key?: string; target?: unknown }) => void;

// minimal browser double: documentElement attrs, localStorage, matchMedia,
// document/window event buses — enough to run the shipped script strings
function browser(opts: {
	stored?: string | null;
	prefersLight?: boolean | null;
	storageThrows?: boolean;
}) {
	const attrs: Record<string, string> = {};
	const store = new Map<string, string>();
	if (opts.stored != null) store.set(THEME_KEY, opts.stored);
	const docL: Record<string, Listener[]> = {};
	const winL: Record<string, Listener[]> = {};
	const mqL: Listener[] = [];
	const events: { theme: string; pref: string }[] = [];
	const mq =
		opts.prefersLight == null
			? null
			: {
					matches: opts.prefersLight,
					addEventListener: (_t: string, f: Listener) => mqL.push(f),
				};
	const localStorage = {
		getItem: (k: string) => {
			if (opts.storageThrows) throw new Error("denied");
			return store.get(k) ?? null;
		},
		setItem: (k: string, v: string) => {
			if (opts.storageThrows) throw new Error("denied");
			store.set(k, v);
		},
		removeItem: (k: string) => {
			store.delete(k);
		},
	};
	const document = {
		documentElement: {
			setAttribute: (k: string, v: string) => {
				attrs[k] = v;
			},
		},
		addEventListener: (t: string, f: Listener) => {
			docL[t] = [...(docL[t] ?? []), f];
		},
		dispatchEvent: (e: { type: string; detail: (typeof events)[0] }) => {
			events.push(e.detail);
			for (const f of docL[e.type] ?? []) f(e);
			return true;
		},
		getElementById: (_id: string): unknown => null,
	};
	class CustomEvent {
		type: string;
		detail: unknown;
		constructor(type: string, init: { detail: unknown }) {
			this.type = type;
			this.detail = init.detail;
		}
	}
	const window: Record<string, unknown> = {
		localStorage,
		matchMedia: mq ? () => mq : undefined,
		addEventListener: (t: string, f: Listener) => {
			winL[t] = [...(winL[t] ?? []), f];
		},
	};
	const run = (src: string) =>
		new Function("window", "document", "CustomEvent", "Node", src)(
			window,
			document,
			CustomEvent,
			Object,
		);
	run(THEME_PREPAINT_JS);
	return { attrs, store, mq, mqL, winL, docL, events, window, document, run };
}

const api = (b: ReturnType<typeof browser>) =>
	b.window.klhTheme as {
		pref: () => string;
		set: (p: string) => string;
		apply: () => string;
	};

describe("token CSS (W269)", () => {
	test("every token has a dark and a light value, both emitted", () => {
		for (const [k, [dark, light]] of Object.entries(TOKENS)) {
			expect(k.startsWith("--klh-")).toBe(true);
			expect(dark.length).toBeGreaterThan(0);
			expect(light.length).toBeGreaterThan(0);
			expect(THEME_CSS).toContain(`${k}:${dark};`);
			expect(THEME_CSS).toContain(`${k}:${light};`);
		}
	});
	test("docs/theme-tokens.md lists every token with both values", async () => {
		const doc = await Bun.file(
			new URL("../docs/theme-tokens.md", import.meta.url),
		).text();
		const q = (s: string) => s.replace(/[.()]/g, "\\$&");
		for (const [k, [dark, light]] of Object.entries(TOKENS))
			expect(doc).toMatch(
				new RegExp(
					`\`${k}\`\\s*\\|\\s*\`${q(dark)}\`\\s*\\|\\s*\`${q(light)}\``,
				),
			);
	});
	test("data-theme selectors swap the set; dark is the no-attr default", () => {
		expect(THEME_CSS).toContain(
			':root,:root[data-theme="dark"]{color-scheme:dark;',
		);
		expect(THEME_CSS).toContain(
			':root[data-theme="light"]{color-scheme:light;',
		);
		expect(THEME_CSS).toContain(
			"@media (prefers-color-scheme: light){:root:not([data-theme])",
		);
	});
});

describe("pre-paint resolution + persistence (W269)", () => {
	test("no stored pref + no media query → system → dark", () => {
		const b = browser({});
		expect(b.attrs["data-theme"]).toBe("dark");
		expect(b.attrs["data-theme-pref"]).toBe("system");
	});
	test("system follows prefers-color-scheme", () => {
		expect(browser({ prefersLight: true }).attrs["data-theme"]).toBe("light");
		expect(browser({ prefersLight: false }).attrs["data-theme"]).toBe("dark");
	});
	test("stored pref wins over the media query", () => {
		const b = browser({ stored: "dark", prefersLight: true });
		expect(b.attrs["data-theme"]).toBe("dark");
		expect(b.attrs["data-theme-pref"]).toBe("dark");
		expect(browser({ stored: "light" }).attrs["data-theme"]).toBe("light");
	});
	test("junk stored value degrades to system", () => {
		const b = browser({ stored: "neon", prefersLight: true });
		expect(b.attrs["data-theme"]).toBe("light");
		expect(b.attrs["data-theme-pref"]).toBe("system");
	});
	test("set() persists light/dark, system clears the key", () => {
		const b = browser({ prefersLight: false });
		expect(api(b).set("light")).toBe("light");
		expect(b.store.get(THEME_KEY)).toBe("light");
		expect(b.attrs["data-theme"]).toBe("light");
		api(b).set("system");
		expect(b.store.has(THEME_KEY)).toBe(false);
		expect(b.attrs["data-theme"]).toBe("dark");
	});
	test("blocked storage still themes (system)", () => {
		const b = browser({ storageThrows: true, prefersLight: true });
		expect(b.attrs["data-theme"]).toBe("light");
		expect(api(b).set("dark")).toBe("light");
	});
	test("OS scheme flip re-applies only while on system", () => {
		const b = browser({ prefersLight: false });
		const mq = b.mq as { matches: boolean };
		mq.matches = true;
		for (const f of b.mqL) f({});
		expect(b.attrs["data-theme"]).toBe("light");
		api(b).set("dark");
		mq.matches = false;
		for (const f of b.mqL) f({});
		mq.matches = true;
		for (const f of b.mqL) f({});
		expect(b.attrs["data-theme"]).toBe("dark");
	});
	test("cross-tab storage event re-applies", () => {
		const b = browser({});
		b.store.set(THEME_KEY, "light");
		for (const f of b.winL.storage ?? []) f({ key: THEME_KEY });
		expect(b.attrs["data-theme"]).toBe("light");
	});
	test("klh-themechange fires with {theme, pref}", () => {
		const b = browser({ prefersLight: true });
		api(b).set("dark");
		expect(b.events).toEqual([
			{ theme: "light", pref: "system" },
			{ theme: "dark", pref: "dark" },
		]);
	});
});

describe("settings panel binding (W269)", () => {
	test("markup: native details + one radio per pref, system checked", () => {
		const m = settingsBlock("<a href='/x'>more</a>");
		expect(m).toStartWith('<details class="klh-settings" id="klh-settings">');
		for (const p of ["light", "dark", "system"])
			expect(m).toContain(`name="${THEME_KEY}" value="${p}"`);
		expect(m).toContain('value="system" checked');
		expect(m).toContain("<a href='/x'>more</a>");
	});
	test("radios reflect the pref and write through klhTheme.set", () => {
		const b = browser({ stored: "light" });
		type Radio = {
			value: string;
			checked: boolean;
			on?: (e: { target: Radio }) => void;
			addEventListener: (t: string, f: (e: { target: Radio }) => void) => void;
		};
		const radios: Radio[] = ["light", "dark", "system"].map((value) => {
			const r: Radio = {
				value,
				checked: false,
				addEventListener: (_t, f) => {
					r.on = f;
				},
			};
			return r;
		});
		const box = {
			open: true,
			querySelectorAll: () => radios,
			querySelector: () => null,
			contains: () => false,
		};
		b.document.getElementById = (id: string) =>
			id === "klh-settings" ? box : null;
		b.run(THEME_SETTINGS_JS);
		expect(radios.map((r) => r.checked)).toEqual([true, false, false]);
		radios[1].on?.({ target: radios[1] });
		expect(b.store.get(THEME_KEY)).toBe("dark");
		expect(b.attrs["data-theme"]).toBe("dark");
		expect(radios.map((r) => r.checked)).toEqual([false, true, false]);
		for (const f of b.docL.keydown ?? []) f({ key: "Escape" } as never);
		expect(box.open).toBe(false);
	});
});

// strip the token block itself + data: URIs, then no palette literal remains
const palette =
	/#(141413|171614|1c1b19|232220|e8e6e1|98958e|d8900f|c96a4f|af2f12)\b|rgba\(255,255,255/i;
const bodyOf = (h: string) =>
	h.replace(THEME_HEAD, "").replace(/data:image\/[^"]+/g, "");

describe("pages wear the theme (W269)", () => {
	test("fleet board: pre-paint in <head>, settings in the topbar, no palette literals", () => {
		const head = HTML.slice(0, HTML.indexOf("</head>"));
		expect(head).toContain(THEME_HEAD);
		expect(head.indexOf(THEME_HEAD)).toBeLessThan(head.indexOf("<style>\n"));
		expect(HTML).toContain('id="klh-settings"');
		expect(HTML).toContain("klh-themechange");
		expect(bodyOf(HTML)).not.toMatch(palette);
		expect(HTML).not.toContain("color-scheme: dark");
	});
	test("console page: same contract, settings link kept", () => {
		const page = consolePage("Settings", "settings", "<p>x</p>");
		expect(page.slice(0, page.indexOf("</head>"))).toContain(THEME_HEAD);
		expect(page).toContain('id="klh-settings"');
		expect(page).toContain('<a aria-current="page" href="/console/settings">');
		expect(bodyOf(page)).not.toMatch(palette);
	});
});
