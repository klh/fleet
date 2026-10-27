import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectIdentity } from "../hooks/lib/govdb/govdb-project.ts";

const serverPath = join(
	import.meta.dir,
	"..",
	"hooks",
	"bin",
	"store-server.ts",
);
const coordPath = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
const proxyPath = join(
	import.meta.dir,
	"fixtures",
	"codex-app-server-proxy.ts",
);
const home = mkdtempSync(join(tmpdir(), "codex-direct-subscribe-"));
const processes: ReturnType<typeof Bun.spawn>[] = [];

test.afterAll(() => {
	for (const child of processes) child.kill();
	rmSync(home, { recursive: true, force: true });
});

async function rpc(url: string, mode: string, sql: string, params: unknown[]) {
	const response = await fetch(`${url}/rpc`, {
		method: "POST",
		body: JSON.stringify({ mode, sql, params }),
	});
	expect(response.ok).toBe(true);
	return response.json();
}

async function cli(url: string, ...args: string[]) {
	const child = Bun.spawn(["bun", coordPath, ...args], {
		env: { ...process.env, HOME: home, GOVERNOR_STORE_URL: url, NO_COLOR: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, code };
}

test("direct consult and reply steer exact Codex subscriber without acknowledging inbox", async () => {
	const reservation = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const port = reservation.port;
	reservation.stop(true);
	const url = `http://127.0.0.1:${port}`;
	const server = Bun.spawn(["bun", serverPath, "--port", String(port)], {
		env: { ...process.env, HOME: home, NO_COLOR: "1" },
		stdout: "ignore",
		stderr: "pipe",
	});
	processes.push(server);
	for (let i = 0; i < 50; i++) {
		try {
			if ((await fetch(`${url}/health`)).ok) break;
		} catch {}
		if (i === 49) throw new Error("store server did not start");
		await Bun.sleep(100);
	}

	const sid = "codex-direct-subscriber";
	const peer = "codex-direct-peer";
	const threadId = "019b0ba5-4c7e-7d51-99fa-85704ad78b99";
	for (const identity of [sid, peer])
		await rpc(
			url,
			"run",
			"INSERT INTO sessions (sid, project, started_at, hb, state, tags) VALUES (?, ?, ?, ?, 'RUNNING', '{}')",
			[identity, projectIdentity(), Date.now(), Date.now()],
		);
	for (const identity of [sid, peer])
		await rpc(
			url,
			"run",
			"INSERT INTO facts (key, value, ts) VALUES (?, ?, ?)",
			[`codex.thread.${identity}`, threadId, Date.now()],
		);

	const subscriberEnv = {
		...process.env,
		HOME: home,
		GOVERNOR_STORE_URL: url,
		SUSPENDERS_CODEX_BIN: proxyPath,
		NO_COLOR: "1",
	};
	const subscriber = Bun.spawn(["bun", coordPath, "subscribe", "--as", sid], {
		env: {
			...subscriberEnv,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const askerSubscriber = Bun.spawn(
		["bun", coordPath, "subscribe", "--as", peer],
		{
			env: subscriberEnv,
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	processes.push(subscriber, askerSubscriber);
	let errors = "";
	let askerErrors = "";
	const readErrors = (async () => {
		for await (const chunk of subscriber.stderr)
			errors += new TextDecoder().decode(chunk);
	})();
	const readAskerErrors = (async () => {
		for await (const chunk of askerSubscriber.stderr)
			askerErrors += new TextDecoder().decode(chunk);
	})();
	try {
		await Bun.sleep(250);
		const opened = await cli(
			url,
			"consult",
			sid,
			"Can the active turn receive this?",
			"--no-kb",
			"--as",
			peer,
		);
		expect(opened.code).toBe(0);
		const consultId = opened.stdout.match(/C\d+/)?.[0];
		expect(consultId).toBeTruthy();
		if (!consultId) throw new Error("coord consult returned no consult ID");
		const replied = await cli(
			url,
			"consult-reply",
			consultId,
			"Yes, via direct steering.",
			"--as",
			sid,
		);
		expect(replied.code).toBe(0);
		for (
			let i = 0;
			i < 60 &&
			(!errors.includes(": steered") || !askerErrors.includes(": steered"));
			i++
		)
			await Bun.sleep(50);
		expect(errors).toContain(": steered");
		expect(askerErrors).toContain(": steered");
		const inbox = await cli(url, "inbox", "--as", sid);
		expect(inbox.code).toBe(0);
		expect(inbox.stdout).toContain("Can the active turn receive this?");
		const askerInbox = await cli(url, "inbox", "--as", peer);
		expect(askerInbox.code).toBe(0);
		expect(askerInbox.stdout).toContain("Yes, via direct steering.");
	} finally {
		subscriber.kill();
		askerSubscriber.kill();
		await Promise.all([readErrors, readAskerErrors]);
	}
}, 15_000);
