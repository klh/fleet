import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classify,
	createNotifier,
	normalizeConfig,
	scrubOutbound,
	type BusEvent,
	type Notification,
	type NotifyConfig,
} from "../hooks/lib/notify.ts";
import {
	desktopSender,
	emailSender,
	osascriptArgv,
	readEnvFile,
	sendSmtp,
	slackSender,
} from "../hooks/lib/notify-adapters.ts";
import { emitHubDown } from "../hooks/bin/metrics-alert.ts";

const ev = (
	kind: string,
	scope: string | null,
	payload: object,
	id = 1,
): BusEvent => ({
	id,
	ts: 0,
	source: "t",
	kind,
	scope,
	payload: JSON.stringify(payload),
});

const cfg = (over: Partial<NotifyConfig["classes"]> = {}): NotifyConfig =>
	normalizeConfig({
		classes: {
			"need-decision": { channels: ["desktop", "slack"], dedupe_s: 60 },
			...over,
		},
	});

describe("classify", () => {
	test("maps the four event classes, ignores the rest", () => {
		expect(classify(ev("NEED_DECISION", "W1", { note: "pick" }))?.cls).toBe(
			"need-decision",
		);
		expect(classify(ev("quota.exhausted", null, { note: "x" }))?.cls).toBe(
			"budget",
		);
		expect(classify(ev("hub.down", "http://h", { note: "x" }))?.cls).toBe(
			"hub-down",
		);
		expect(classify(ev("lane.dead", "W2", { sid: "s" }))?.cls).toBe(
			"lane-death",
		);
		expect(classify(ev("work.landed", "W2", {}))).toBeNull();
	});
	test("scrubs home paths and key material from outbound text", () => {
		const home = ["", "Users", "someone"].join("/");
		const tok = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");
		const n = classify(
			ev("NEED_DECISION", "W1", { note: `see ${home}/x key ${tok}` }),
		);
		expect(n?.body).not.toContain(home);
		expect(n?.body).not.toContain(tok.slice(0, 14));
		expect(scrubOutbound("ok")).toBe("ok");
	});
});

describe("notifier dedupe + rate limit", () => {
	const mk = (config: NotifyConfig, clock: { t: number }) => {
		const sent: string[] = [];
		const notifier = createNotifier({
			config,
			now: () => clock.t,
			senders: {
				desktop: async (n) => void sent.push(`d:${n.key}`),
				slack: async () => {
					throw new Error("boom");
				},
			},
		});
		return { notifier, sent };
	};
	test("same subject deduped inside window, re-notifies after", async () => {
		const clock = { t: 0 };
		const { notifier, sent } = mk(cfg(), clock);
		const e = ev("NEED_DECISION", "W1", { note: "a" });
		expect((await notifier.handle(e)).status).toBe("sent");
		expect((await notifier.handle(e)).status).toBe("deduped");
		clock.t = 61_000;
		expect((await notifier.handle(e)).status).toBe("sent");
		expect(sent).toHaveLength(2);
	});
	test("a failing channel is isolated, the other still delivers", async () => {
		const { notifier, sent } = mk(cfg(), { t: 0 });
		const r = await notifier.handle(ev("NEED_DECISION", "W1", { note: "a" }));
		expect(r.channels).toEqual({ desktop: "ok", slack: "boom" });
		expect(sent).toHaveLength(1);
	});
	test("per-class rate limit caps distinct subjects", async () => {
		const clock = { t: 0 };
		const c = cfg({
			"need-decision": {
				channels: ["desktop"],
				dedupe_s: 60,
				rate_limit: { max: 2, per_s: 100 },
			},
		});
		const { notifier } = mk(c, clock);
		const s = async (i: number) =>
			(await notifier.handle(ev("NEED_DECISION", `W${i}`, { note: "x" }))).status;
		expect(await s(1)).toBe("sent");
		expect(await s(2)).toBe("sent");
		expect(await s(3)).toBe("rate-limited");
		clock.t = 101_000;
		expect(await s(4)).toBe("sent");
		expect(notifier.stats.rateLimited).toBe(1);
	});
	test("unconfigured channel = skipped, no-channel status, not an error", async () => {
		const n = createNotifier({
			config: normalizeConfig({
				classes: { budget: { channels: ["email"] } },
			}),
			senders: {},
		});
		expect((await n.handle(ev("quota.exhausted", null, {}))).status).toBe(
			"no-channel",
		);
	});
});

const note: Notification = {
	cls: "hub-down",
	key: "k",
	title: "[fleet] hub.down h",
	body: "line1\n.dot line",
};

describe("adapters", () => {
	test("osascript argv carries title/body as args, never interpolated", async () => {
		const argv = osascriptArgv({ ...note, body: 'x" & do shell script "evil' });
		expect(argv.slice(-2)).toEqual([note.title, 'x" & do shell script "evil']);
		expect(argv.join(" ")).not.toContain("evil\"");
		let seen: string[] = [];
		await desktopSender(async (a) => {
			seen = a;
			return 0;
		})(note);
		expect(seen[0]).toBe("osascript");
		await expect(desktopSender(async () => 1)(note)).rejects.toThrow("exit 1");
	});
	test("slack posts JSON text and surfaces non-2xx", async () => {
		let body = "";
		const ok = (async (_u: unknown, init?: RequestInit) => {
			body = String(init?.body);
			return new Response("ok");
		}) as typeof fetch;
		await slackSender("http://x/hook", ok)(note);
		expect(JSON.parse(body).text).toContain("hub.down");
		const bad = (async () => new Response("no", { status: 500 })) as typeof fetch;
		await expect(slackSender("http://x/hook", bad)(note)).rejects.toThrow(
			"HTTP 500",
		);
	});
	test("readEnvFile refuses group/world-readable credential files", () => {
		const d = mkdtempSync(join(tmpdir(), "notify-"));
		const f = join(d, "env");
		writeFileSync(f, "export GMAIL_USER='a@b.c'\nGMAIL_APP_PASSWORD=pw\n");
		chmodSync(f, 0o644);
		expect(() => readEnvFile(f)).toThrow("mode 600");
		chmodSync(f, 0o600);
		expect(readEnvFile(f)).toEqual({
			GMAIL_USER: "a@b.c",
			GMAIL_APP_PASSWORD: "pw",
		});
	});
	test("emailSender resolves creds from env_file at send time", async () => {
		const d = mkdtempSync(join(tmpdir(), "notify-"));
		const f = join(d, "env");
		writeFileSync(f, "GMAIL_USER=a@b.c\nGMAIL_APP_PASSWORD=pw\n");
		chmodSync(f, 0o600);
		let got: { user: string; to: string[]; host: string } | null = null;
		await emailSender({ env_file: f }, async (o) => {
			got = { user: o.user, to: o.to, host: o.host };
		})(note);
		expect(got).toEqual({ user: "a@b.c", to: ["a@b.c"], host: "smtp.gmail.com" });
	});
});

describe("smtp client vs fake server", () => {
	test("EHLO → AUTH PLAIN → MAIL/RCPT/DATA with dot-stuffing", async () => {
		const lines: string[] = [];
		let inData = false;
		const server = net.createServer((s) => {
			s.write("220 fake\r\n");
			let buf = "";
			s.on("data", (d) => {
				buf += d.toString();
				let i = buf.indexOf("\r\n");
				while (i >= 0) {
					const l = buf.slice(0, i);
					buf = buf.slice(i + 2);
					lines.push(l);
					if (inData) {
						if (l === ".") {
							inData = false;
							s.write("250 queued\r\n");
						}
					} else if (l.startsWith("EHLO")) s.write("250 fake\r\n");
					else if (l.startsWith("AUTH")) s.write("235 ok\r\n");
					else if (l === "DATA") {
						inData = true;
						s.write("354 go\r\n");
					} else if (l === "QUIT") s.write("221 bye\r\n");
					else s.write("250 ok\r\n");
					i = buf.indexOf("\r\n");
				}
			});
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const port = (server.address() as net.AddressInfo).port;
		await sendSmtp(
			{
				host: "127.0.0.1",
				port,
				user: "u",
				pass: "p",
				from: "u@x",
				to: ["r@x"],
				starttls: false,
			},
			note,
		);
		server.close();
		expect(lines.some((l) => l === "RCPT TO:<r@x>")).toBe(true);
		expect(lines).toContain("..dot line");
		expect(lines.find((l) => l.startsWith("AUTH PLAIN"))).toBe(
			`AUTH PLAIN ${Buffer.from("\0u\0p").toString("base64")}`,
		);
		expect(lines).toContain("Subject: [fleet] hub.down h");
	});
	test("a rejected AUTH surfaces as an error without leaking the password", async () => {
		const server = net.createServer((s) => {
			s.write("220 fake\r\n");
			s.on("data", (d) => {
				const t = d.toString();
				s.write(t.startsWith("AUTH") ? "535 bad\r\n" : "250 ok\r\n");
			});
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const port = (server.address() as net.AddressInfo).port;
		const err = await sendSmtp(
			{
				host: "127.0.0.1",
				port,
				user: "u",
				pass: "secretpw",
				from: "u@x",
				to: ["r@x"],
				starttls: false,
			},
			note,
		).catch((e: Error) => e);
		server.close();
		expect((err as Error).message).toContain("535");
		expect((err as Error).message).not.toContain("secretpw");
	});
});

describe("hub-down source", () => {
	test("metrics-alert DROP alerts become hub.down bus events", () => {
		const rows: [string, string, string][] = [];
		const n = emitHubDown(
			[
				{ kind: "DROP", target: "http://h:1", detail: "2 failed scrapes" },
				{ kind: "SPIKE", target: "http://h:1", detail: "x" },
			],
			(k, s, p) => void rows.push([k, s, p]),
		);
		expect(n).toBe(1);
		expect(rows[0]?.slice(0, 2)).toEqual(["hub.down", "http://h:1"]);
	});
});
