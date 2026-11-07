import { expect, test } from "./pw";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTheme, readTheme } from "../hooks/board/routes-theme.ts";

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

test.describe("machine theme sync", () => {
	test("writes one bounded preference and reads it across service origins", async () => {
		const path = join(
			mkdtempSync(join(tmpdir(), "klh-theme-")),
			"ui-theme.json",
		);
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
		expect(fromBar.headers.get("access-control-allow-origin")).toBe(
			"https://bar.local",
		);
		expect(JSON.parse(readFileSync(path, "utf8")).pref).toBe("dark");
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("rejects foreign origins and invalid values", async () => {
		const path = join(
			mkdtempSync(join(tmpdir(), "klh-theme-")),
			"ui-theme.json",
		);
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

	test("emits changed preference to an open tab", async () => {
		const path = join(
			mkdtempSync(join(tmpdir(), "klh-theme-")),
			"ui-theme.json",
		);
		const events = await handleTheme(
			new Request(`${url}/events`, {
				headers: { host: "127.0.0.1", origin: "https://bar.local" },
			}),
			path,
		);
		expect(events.headers.get("content-type")).toStartWith("text/event-stream");
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
