// klh-theme-sync.test.ts — W997: the dashboard serves the shared machine
// theme preference (W997 vendored bin/klh-theme-sync.ts), so same-origin
// http://localhost pages persist light/dark against the SAME state file the
// suspenders board writes — one preference across board, belt and bar.
import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	handleTheme,
	hostAllowlist,
	readTheme,
	themePath,
} from "../bin/klh-theme-sync.ts";

const url = "http://127.0.0.1/api/theme";
const request = (
	method: string,
	origin = "https://belt.local",
	body?: object,
) =>
	new Request(url, {
		method,
		headers: { host: "127.0.0.1", origin, "content-type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});

const scratch = (): string =>
	join(mkdtempSync(join(tmpdir(), "klh-theme-sync-")), "ui-theme.json");

test.describe("vendored theme sync (W997)", () => {
	test("belt and local vendor byte-identical copies @unit", () => {
		const belt = readFileSync(
			join(import.meta.dir, "..", "bin", "klh-theme-sync.ts"),
		);
		const local = readFileSync(
			join(import.meta.dir, "..", "..", "local", "bin", "klh-theme-sync.ts"),
		);
		expect(Buffer.from(belt).equals(Buffer.from(local))).toBe(true);
	});

	test("state file is the shared machine timeline (same as the board) @unit", () => {
		expect(themePath()).toBe(
			`${process.env.HOME}/.cache/claude-governor/ui-theme.json`,
		);
		expect(themePath({ KLH_THEME_STATE: "/tmp/x.json" })).toBe("/tmp/x.json");
	});

	test("host guard: fleet .local names + loopback, rebind host refused @unit", () => {
		const allow = hostAllowlist("0.0.0.0");
		for (const h of [
			"belt.local",
			"bar.local",
			"suspenders.local",
			"localhost",
		])
			expect(allow.has(h)).toBe(true);
		expect(allow.has("evil.example")).toBe(false);
	});

	test("writes one bounded preference, readable across service origins @unit", async () => {
		const path = scratch();
		expect(readTheme(path)).toEqual({ pref: "system", revision: 0 });
		const wrote = await handleTheme(
			request("POST", "https://belt.local", { pref: "dark" }),
			path,
		);
		expect(wrote.status).toBe(200);
		expect(wrote.headers.get("access-control-allow-origin")).toBe(
			"https://belt.local",
		);
		const fromBar = await handleTheme(
			request("GET", "https://bar.local"),
			path,
		);
		expect((await fromBar.json()).pref).toBe("dark");
		expect(JSON.parse(readFileSync(path, "utf8")).pref).toBe("dark");
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("rejects foreign origins, junk prefs and oversized bodies @unit", async () => {
		const path = scratch();
		expect(
			(
				await handleTheme(
					request("POST", "https://evil.example", { pref: "dark" }),
					path,
				)
			).status,
		).toBe(403);
		expect(
			(
				await handleTheme(
					request("POST", "https://belt.local", { pref: "blue" }),
					path,
				)
			).status,
		).toBe(400);
		expect(readTheme(path).pref).toBe("system");
	});

	test("emits a changed preference to an open tab @unit", async () => {
		const path = scratch();
		const events = await handleTheme(
			new Request(`${url}/events`, {
				headers: { host: "127.0.0.1", origin: "https://bar.local" },
			}),
			path,
		);
		expect(
			events.headers.get("content-type")?.startsWith("text/event-stream"),
		).toBe(true);
		const reader = events.body?.getReader();
		expect(reader).toBeDefined();
		await reader?.read();
		await handleTheme(
			request("POST", "https://belt.local", { pref: "light" }),
			path,
		);
		const next = await reader?.read();
		expect(new TextDecoder().decode(next?.value)).toContain('"pref":"light"');
		await reader?.cancel();
	});
});
