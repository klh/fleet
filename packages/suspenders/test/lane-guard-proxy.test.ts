// test/lane-guard-proxy.test.ts — W1141 proxy faces, in-process (a spawned
// child serving a parent-hitting client hangs on this macOS). Egress: raw
// CONNECT/forward flows against loopback upstreams + the NDJSON decision log.
// Push: real git over the proxy against a bare origin — the lane's own branch
// lands, main and deletions are refused at the credential layer, a wrong
// token gets 401.
import { setDefaultTimeout, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	relayCommand,
	startLaneEgressProxy,
	startLanePushProxy,
} from "../hooks/lib/lane-guard-proxy.ts";
import { mintLanePushIdentity } from "../hooks/lib/lane-guard.ts";

setDefaultTimeout(30000);

describe("relayCommand (origin transports)", () => {
	test("local path → direct receive-pack; ssh forms → the ssh relay; https refused", () => {
		expect(relayCommand("/srv/repo.git", true)).toEqual([
			"git",
			"receive-pack",
			"--http-backend-info-refs",
			"/srv/repo.git",
		]);
		expect(relayCommand("file:///srv/r.git", false)).toEqual([
			"git",
			"receive-pack",
			"--stateless-rpc",
			"/srv/r.git",
		]);
	});

	test("scp-like and ssh:// origins ride ssh", () => {
		expect(relayCommand("git@host.example:srv/r.git", false)).toEqual([
			"ssh",
			"git@host.example",
			"git-receive-pack --stateless-rpc 'srv/r.git'",
		]);
		expect(relayCommand("ssh://kk@nas.threads.dk/vol/r.git", true)).toEqual([
			"ssh",
			"kk@nas.threads.dk",
			"git-receive-pack --http-backend-info-refs 'vol/r.git'",
		]);
		expect(relayCommand("https://github.com/klh/fleet", true)).toBeNull();
	});
});

describe("egress proxy (CONNECT)", () => {
	const logIn = (name: string): string =>
		join(mkdtempSync(join(tmpdir(), "w1141-eg-")), name);

	test("deny → 403 + one logged decision row", async () => {
		const logFile = logIn("eg.log");
		const proxy = startLaneEgressProxy({
			port: 0,
			allow: ["127.0.0.1"],
			logFile,
		});
		const out = await new Promise<string>((resolve) => {
			Bun.connect({
				hostname: "127.0.0.1",
				port: proxy.port,
				socket: {
					data: (_s, d) => resolve(new TextDecoder().decode(d)),
					error: () => resolve(""),
				},
			}).then((sock) =>
				sock.write(
					"CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example\r\n\r\n",
				),
			);
		});
		expect(out).toContain("403 Forbidden");
		proxy.stop(true);
		const row = JSON.parse(
			readFileSync(logFile, "utf8").trim().split("\n").at(-1) ?? "{}",
		) as { host: string; verdict: string; via: string };
		expect(row.host).toBe("evil.example");
		expect(row.verdict).toBe("deny");
		expect(row.via).toBe("connect");
	});

	test("allow → tunnel: bytes flow to a loopback upstream", async () => {
		const up = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("pong"),
		});
		const proxy = startLaneEgressProxy({
			port: 0,
			allow: ["127.0.0.1"],
			logFile: logIn("eg.log"),
		});
		const body = await new Promise<string>((resolve) => {
			let sent = false;
			let buf = "";
			Bun.connect({
				hostname: "127.0.0.1",
				port: proxy.port,
				socket: {
					data: (s, d) => {
						buf += new TextDecoder().decode(d);
						if (!sent && buf.includes("200 Connection established")) {
							sent = true;
							s.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
						}
						if (buf.includes("pong")) {
							s.end();
							resolve(buf);
						}
					},
					error: () => resolve(buf),
				},
			}).then((sock) =>
				sock.write(`CONNECT 127.0.0.1:${up.port} HTTP/1.1\r\n\r\n`),
			);
		});
		expect(body).toContain("200 Connection established");
		expect(body).toContain("pong");
		proxy.stop(true);
		up.stop(true);
	});

	test("absolute-form forward: allow relays, deny logs + 403", async () => {
		const logFile = logIn("eg.log");
		const up = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("pong"),
		});
		const proxy = startLaneEgressProxy({
			port: 0,
			allow: ["127.0.0.1"],
			logFile,
		});
		const fwd = async (target: string): Promise<string> =>
			new Promise((resolve) => {
				let buf = "";
				Bun.connect({
					hostname: "127.0.0.1",
					port: proxy.port,
					socket: {
						data: (s, d) => {
							buf += new TextDecoder().decode(d);
							if (buf.includes("pong") || buf.includes("403")) {
								s.end();
								resolve(buf);
							}
						},
						error: () => resolve(buf),
					},
				}).then((sock) =>
					sock.write(
						`GET ${target} HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n`,
					),
				);
			});
		const ok = await fwd(`http://127.0.0.1:${up.port}/`);
		expect(ok).toContain("pong");
		const no = await fwd("http://evil.example/x");
		expect(no).toContain("403");
		proxy.stop(true);
		up.stop(true);
	});
});

describe("push proxy (real git, bare origin)", () => {
	const sh = (args: string[], cwd?: string): string => {
		const p = Bun.spawnSync(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
		if (p.exitCode !== 0) throw new Error(p.stderr.toString());
		return p.stdout.toString();
	};

	const pkt = (s: string): string =>
		`${(s.length + 4).toString(16).padStart(4, "0")}${s}`;
	const pktBody = (cmds: string[], pack: Uint8Array): Uint8Array => {
		const head = new TextEncoder().encode(`${cmds.map(pkt).join("")}0000`);
		const out = new Uint8Array(head.length + pack.length);
		out.set(head);
		out.set(pack, head.length);
		return out;
	};
	const advUrl = (port: number): string =>
		`http://127.0.0.1:${port}/fleet.git/info/refs?service=git-receive-pack`;
	const postUrl = (port: number): string =>
		`http://127.0.0.1:${port}/fleet.git/git-receive-pack`;

	const laneFixture = (): {
		base: string;
		origin: string;
		wt: string;
		ident: ReturnType<typeof mintLanePushIdentity>;
		proxy: ReturnType<typeof startLanePushProxy>;
	} => {
		const base = mkdtempSync(join(tmpdir(), "w1141-px-"));
		const origin = join(base, "origin.git");
		sh(["init", "-q", "--bare", "-b", "main", origin]);
		const machine = join(base, "machine");
		sh(["clone", "-q", origin, machine]);
		sh(
			[
				"-c",
				"user.email=t@l",
				"-c",
				"user.name=t",
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				"c0",
			],
			machine,
		);
		sh(["push", "-q", origin, "HEAD:refs/heads/main"], machine);
		const wt = join(base, "wt");
		sh(["worktree", "add", "-q", wt, "-b", "suspenders/W1141"], machine);
		sh(
			[
				"-c",
				"user.email=t@l",
				"-c",
				"user.name=t",
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				"lane c1",
			],
			wt,
		);
		const ident = mintLanePushIdentity(base, "autow1141-x", "W1141");
		const proxy = startLanePushProxy({
			port: 0,
			repoRoot: base,
			originUrl: origin,
		});
		return { base, origin, wt, ident, proxy };
	};

	test("own branch lands on the origin through the scoped credential", async () => {
		const f = laneFixture();
		const auth = `Basic ${btoa(`${f.ident.sid}:${f.ident.token}`)}`;
		const newOid = sh(["-C", f.wt, "rev-parse", "HEAD"]).trim();
		const pk = Bun.spawn(
			["git", "-C", f.wt, "pack-objects", "--revs", "--stdout"],
			{
				stdin: "pipe",
				stdout: "pipe",
			},
		);
		pk.stdin.write("HEAD\n");
		pk.stdin.end();
		const pack = new Uint8Array(await new Response(pk.stdout).arrayBuffer());
		const body = pktBody(
			[
				`${"0".repeat(40)} ${newOid} refs/heads/suspenders/W1141\u0000report-status`,
			],
			new Uint8Array(pack),
		);
		const adv = await fetch(advUrl(f.proxy.port), {
			headers: { authorization: auth },
		});
		expect(adv.status).toBe(200);
		expect(adv.headers.get("content-type")).toContain("advertisement");
		const res = await fetch(postUrl(f.proxy.port), {
			method: "POST",
			headers: {
				authorization: auth,
				"content-type": "application/x-git-receive-pack-request",
			},
			body,
		});
		expect(res.status).toBe(200);
		const report = await res.text();
		expect(report).toContain("ok refs/heads/suspenders/W1141");
		const refs = sh([
			"--git-dir",
			f.origin,
			"for-each-ref",
			"--format=%(refname)",
		]);
		expect(refs).toContain("refs/heads/suspenders/W1141");
		f.proxy.stop(true);
		rmSync(f.base, { recursive: true, force: true });
	});

	test("main, own-branch deletion, and wrong tokens are refused", async () => {
		const f = laneFixture();
		const auth = `Basic ${btoa(`${f.ident.sid}:${f.ident.token}`)}`;
		const newOid = sh(["-C", f.wt, "rev-parse", "HEAD"]).trim();
		const post = (refname: string, isDel = false): Promise<Response> =>
			fetch(postUrl(f.proxy.port), {
				method: "POST",
				headers: {
					authorization: auth,
					"content-type": "application/x-git-receive-pack-request",
				},
				body: pktBody(
					[
						`${isDel ? newOid : "0".repeat(40)} ${isDel ? "0".repeat(40) : newOid} ${refname}\u0000report-status`,
					],
					new Uint8Array(20),
				),
			});
		expect((await post("refs/heads/main")).status).toBe(403);
		const del = await post("refs/heads/suspenders/W1141", true);
		expect(del.status).toBe(403);
		const bad = await fetch(advUrl(f.proxy.port), {
			headers: { authorization: `Basic ${btoa("autow1141-x:wrong")}` },
		});
		expect(bad.status).toBe(401);
		const refs = sh([
			"--git-dir",
			f.origin,
			"for-each-ref",
			"--format=%(refname)",
		]);
		expect(refs).not.toContain("W1141");
		const mainAfter = sh([
			"--git-dir",
			f.origin,
			"rev-parse",
			"refs/heads/main",
		]).trim();
		expect(mainAfter).toBe(
			sh(["-C", f.wt, "merge-base", "HEAD", "refs/heads/main"]).trim(),
		);
		f.proxy.stop(true);
		rmSync(f.base, { recursive: true, force: true });
	});

	test("no credential → 401 + the Basic challenge", async () => {
		const f = laneFixture();
		const res = await fetch(
			`http://127.0.0.1:${f.proxy.port}/fleet.git/info/refs?service=git-receive-pack`,
		);
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain("Basic");
		f.proxy.stop(true);
		rmSync(f.base, { recursive: true, force: true });
	});
});
