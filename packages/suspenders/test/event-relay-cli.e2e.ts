import { expect, test } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(import.meta.dir, "../hooks/bin");
const fixture = mkdtempSync(join(tmpdir(), "relay-cli-"));
const senderHome = join(fixture, "sender");
const receiverHome = join(fixture, "receiver");
const repo = join(fixture, "repo");
const token = "relay-fixture-token";
const remoteSid = "relay-remote-fixture";

test("actual CLI and store HTTP paths preserve directed bodies, receipts and pause behavior", async () => {
	mkdirSync(repo, { recursive: true });
	Bun.spawnSync(["git", "init", "-q", repo]);
	const probe = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response("ok"),
	});
	const port = probe.port;
	probe.stop(true);
	const url = `http://127.0.0.1:${port}`;
	const base = {
		...process.env,
		GOVERNOR_STORE_URL: "local",
		GOVERNOR_STORE_TOKEN: token,
		NO_COLOR: "1",
	};
	delete base.SUSPENDERS_SID;
	delete base.SUSPENDERS_SESSION_IDENTITY_PROTOCOL;
	const server = Bun.spawn(
		["bun", join(BIN, "store-server.ts"), "--port", String(port)],
		{ env: { ...base, HOME: receiverHome }, stdout: "ignore", stderr: "pipe" },
	);
	const cli = (
		home: string,
		args: string[],
		extra: Record<string, string> = {},
	) => {
		const child = Bun.spawnSync(["bun", join(BIN, "coord.ts"), ...args], {
			cwd: repo,
			env: {
				...base,
				HOME: home,
				SUSPENDERS_HUB_TESTHUB_URL: url,
				SUSPENDERS_HUB_TESTHUB_TOKEN: token,
				...extra,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			code: child.exitCode,
			out: child.stdout.toString(),
			err: child.stderr.toString(),
		};
	};
	try {
		let ready = false;
		for (let i = 0; i < 100; i++) {
			try {
				if ((await fetch(`${url}/health`)).ok) {
					ready = true;
					break;
				}
			} catch {}
			await Bun.sleep(20);
		}
		expect(ready).toBe(true);
		expect(
			cli(receiverHome, [
				"bootstrap",
				"--as",
				remoteSid,
				"--name",
				"remote-fixture",
			]).code,
		).toBe(0);
		expect(
			cli(senderHome, [
				"bootstrap",
				"--as",
				"origin-fixture",
				"--name",
				"origin-fixture",
			]).code,
		).toBe(0);
		mkdirSync(join(repo, ".fleet"), { recursive: true });
		writeFileSync(
			join(repo, ".fleet/lanes.json"),
			JSON.stringify([{ sid: remoteSid, host: "testhub.local" }]),
		);
		const body = "- review this ✓\n\tkeep the exact body\r\n-- final line";
		const sent = cli(senderHome, [
			"message",
			remoteSid,
			body,
			"--as",
			"origin-fixture",
		]);
		expect(sent.code).toBe(0);
		expect(sent.out).toContain("message forwarded");
		const deliveryId = /coord delivery ([0-9a-f-]{36})/.exec(sent.out)?.[1];
		expect(deliveryId).toBeDefined();
		const path = `${url}/event-relay/${deliveryId}`;
		expect((await fetch(path)).status).toBe(403);
		expect(
			(await fetch(`${url}/event-relay`, { method: "POST", body: "{}" }))
				.status,
		).toBe(403);
		const before = await fetch(path, {
			headers: { "x-governor-token": token },
		});
		expect(before.status).toBe(200);
		const initial = (await before.json()) as { eventId: number; state: string };
		expect(initial.state).not.toBe("ACCEPTED");
		const displayed = cli(senderHome, ["delivery", deliveryId ?? "missing"]);
		expect(displayed.code).toBe(0);
		expect(displayed.out).toContain("QUEUED");
		const inbox = cli(receiverHome, ["inbox", "--as", remoteSid]);
		expect(inbox.code).toBe(0);
		expect(inbox.out).toContain(body);
		const seen = cli(senderHome, [
			"delivery",
			deliveryId ?? "missing",
			"--json",
		]);
		expect(seen.code).toBe(0);
		expect(JSON.parse(seen.out).state).toBe("SEEN");
		expect(
			cli(receiverHome, ["ack", String(initial.eventId), "--as", remoteSid])
				.code,
		).toBe(0);
		const accepted = cli(senderHome, [
			"delivery",
			deliveryId ?? "missing",
			"--json",
		]);
		expect(JSON.parse(accepted.out).state).toBe("ACCEPTED");
		const unreadable = cli(senderHome, ["delivery", deliveryId ?? "missing"], {
			SUSPENDERS_HUB_TESTHUB_TOKEN: "wrong",
		});
		expect(unreadable.code).toBe(0);
		expect(unreadable.out).toContain("receipt unreadable");
		expect(
			cli(senderHome, [
				"pause",
				"origin-fixture",
				"--reason",
				"fixture",
				"--as",
				"origin-fixture",
				"--force",
			]).code,
		).toBe(0);
		const remotePause = cli(senderHome, [
			"pause",
			remoteSid,
			"--reason",
			"remote fixture",
			"--as",
			"origin-fixture",
		]);
		expect(remotePause.code).toBe(0);
		expect(remotePause.out).toContain("pause_requested forwarded");
	} finally {
		server.kill();
		await server.exited;
		rmSync(fixture, { recursive: true, force: true });
	}
}, 20000);
