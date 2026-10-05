import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyFragment,
	dnsAlive,
	dnsArgv,
	fragmentConf,
	hostsRegistryPath,
	parseForwardAuth,
	readRegistryAt,
	updateRegistryAt,
	withLock,
	writeAtomic,
} from "./klh-local.ts";

const dirs: string[] = [];
const scratch = (): string => {
	const d = mkdtempSync(join(tmpdir(), "klh-local-test-"));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ok = { code: 0, out: "" };
const fail = (out: string) => () => ({ code: 1, out });

const setup = (): { sites: string; caddyfile: string } => {
	const d = scratch();
	const sites = join(d, "sites");
	mkdirSync(sites);
	const caddyfile = join(d, "Caddyfile");
	writeFileSync(
		caddyfile,
		`import ${sites}/*.caddy\n\nhttp://:80, https://:443 {\n\tabort\n}\n`,
	);
	return { sites, caddyfile };
};

describe("fragmentConf exposure", () => {
	test("loopback bind by default", () => {
		const f = fragmentConf("belt", 7791);
		expect(f).toContain("\tbind 127.0.0.1 ::1\n");
		expect(f).not.toContain("forward_auth");
	});

	test("routes keep the loopback bind", () => {
		const f = fragmentConf("belt", 7791, [{ path: "/s*", port: 4100 }]);
		expect(f.indexOf("bind 127.0.0.1")).toBeLessThan(f.indexOf("handle"));
	});

	test("--lan drops the bind and requires forward_auth", () => {
		const f = fragmentConf("belt", 7791, [], {
			lan: true,
			forwardAuth: "http://127.0.0.1:9091/api/verify?rd=x",
		});
		expect(f).not.toContain("bind ");
		expect(f).toContain("forward_auth http://127.0.0.1:9091 {");
		expect(f).toContain("uri /api/verify?rd=x");
		expect(() => fragmentConf("belt", 7791, [], { lan: true })).toThrow();
	});

	test("parseForwardAuth rejects anything that could smuggle config", () => {
		expect(parseForwardAuth("https://sso.example.com/auth")).toEqual({
			upstream: "https://sso.example.com",
			uri: "/auth",
		});
		for (const bad of [
			"ftp://x/y",
			"http://u:p@x/y",
			"http://x/y#f",
			"http://x}/a",
			"http://_x/a",
			"not a url",
		])
			expect(parseForwardAuth(bad)).toBeNull();
		// spaces/braces are percent-encoded by URL — they never reach the config raw
		expect(parseForwardAuth("http://x/a b}\n{")?.uri).toBe("/a%20b%7D%7B");
	});
});

describe("applyFragment rollback", () => {
	test("validate failure never touches sites/", () => {
		const { sites, caddyfile } = setup();
		writeFileSync(join(sites, "good.caddy"), "good");
		const res = applyFragment({
			sites,
			caddyfile,
			name: "bad",
			content: "broken {",
			validate: fail("parse error"),
			reload: () => ok,
		});
		expect(res).toEqual({ ok: false, stage: "validate", out: "parse error" });
		expect(readdirSync(sites)).toEqual(["good.caddy"]);
		expect(readdirSync(join(caddyfile, "..")).sort()).toEqual([
			"Caddyfile",
			"sites",
		]);
	});

	test("validate sees the candidate alongside the other fragments", () => {
		const { sites, caddyfile } = setup();
		writeFileSync(join(sites, "other.caddy"), "other");
		writeFileSync(join(sites, "svc.caddy"), "old");
		let seen: Record<string, string> = {};
		applyFragment({
			sites,
			caddyfile,
			name: "svc",
			content: "new",
			validate: (cf) => {
				const dir = /import (\S+)\/\*\.caddy/.exec(
					readFileSync(cf, "utf8"),
				)?.[1];
				expect(dir).not.toBe(sites);
				seen = Object.fromEntries(
					readdirSync(dir ?? "").map((f) => [
						f,
						readFileSync(join(dir ?? "", f), "utf8"),
					]),
				);
				return ok;
			},
			reload: () => ok,
		});
		expect(seen).toEqual({ "other.caddy": "other", "svc.caddy": "new" });
		expect(readFileSync(join(sites, "svc.caddy"), "utf8")).toBe("new");
	});

	test("reload failure restores the prior fragment", () => {
		const { sites, caddyfile } = setup();
		writeFileSync(join(sites, "svc.caddy"), "prior-good");
		const res = applyFragment({
			sites,
			caddyfile,
			name: "svc",
			content: "new",
			validate: () => ok,
			reload: fail("admin API down"),
		});
		expect(res.ok).toBe(false);
		expect(readFileSync(join(sites, "svc.caddy"), "utf8")).toBe("prior-good");
	});

	test("reload failure on a new service removes the fragment", () => {
		const { sites, caddyfile } = setup();
		applyFragment({
			sites,
			caddyfile,
			name: "svc",
			content: "new",
			validate: () => ok,
			reload: fail("nope"),
		});
		expect(readdirSync(sites)).toEqual([]);
	});

	const caddy = Bun.which("caddy");
	test.skipIf(!caddy)("real caddy validates loopback + lan fragments", () => {
		const { sites, caddyfile } = setup();
		const validate = (cf: string) => {
			const p = Bun.spawnSync([caddy ?? "", "validate", "--config", cf], {
				stdout: "pipe",
				stderr: "pipe",
			});
			return { code: p.exitCode ?? 1, out: p.stderr.toString() };
		};
		const lan = {
			lan: true,
			forwardAuth: "http://127.0.0.1:9091/api/verify",
		};
		for (const [name, content] of [
			["loop", fragmentConf("loop", 7001, [{ path: "/s*", port: 7002 }])],
			["wide", fragmentConf("wide", 7003, [], lan)],
		])
			expect(
				applyFragment({
					sites,
					caddyfile,
					name,
					content,
					validate,
					reload: () => ok,
				}),
			).toEqual({ ok: true });
		const bad = applyFragment({
			sites,
			caddyfile,
			name: "bad",
			content: "bad.local {\n\tnot_a_directive\n}\n",
			validate,
			reload: () => ok,
		});
		expect(bad.ok).toBe(false);
		expect(existsSync(join(sites, "bad.caddy"))).toBe(false);
	});
});

describe("dns pid identity", () => {
	test("only a dns-sd command line counts as our claim", () => {
		expect(dnsAlive(42, () => "dns-sd\n")).toBe(true);
		expect(dnsAlive(42, () => "/usr/bin/dns-sd")).toBe(true);
		expect(dnsAlive(42, () => "bash")).toBe(false);
		expect(dnsAlive(42, () => "")).toBe(false);
		expect(dnsAlive(undefined, () => "dns-sd")).toBe(false);
	});

	test("a live non-dns-sd pid is not trusted (real ps)", () => {
		expect(dnsAlive(process.pid)).toBe(false);
	});

	test("dns argv is an argument array, loopback advertised by default", () => {
		const argv = dnsArgv("belt", 7791, "127.0.0.1");
		expect(argv.slice(1)).toEqual([
			"-P",
			"belt",
			"_http._tcp",
			"local",
			"7791",
			"belt.local",
			"127.0.0.1",
		]);
	});
});

describe("registry lock", () => {
	test("concurrent writers lose no entries", async () => {
		const reg = join(scratch(), "registry.json");
		const mod = join(import.meta.dir, "klh-local.ts");
		const script = (tag: string) => `
			import { updateRegistryAt } from ${JSON.stringify(mod)};
			for (let i = 0; i < 25; i++)
				updateRegistryAt(${JSON.stringify(reg)}, (r) => ({
					next: [...r, { name: "${tag}" + i }],
					result: null,
				}));`;
		const procs = ["a", "b", "c"].map((t) =>
			Bun.spawn([process.execPath, "-e", script(t)], { stderr: "pipe" }),
		);
		const codes = await Promise.all(procs.map((p) => p.exited));
		expect(codes).toEqual([0, 0, 0]);
		expect(readRegistryAt(reg)).toHaveLength(75);
		expect(readdirSync(join(reg, ".."))).toEqual(["registry.json"]);
	});

	test("a lock left by a dead process is stolen", () => {
		const lock = join(scratch(), "x.lock");
		mkdirSync(lock);
		writeFileSync(join(lock, "pid"), "999999");
		expect(withLock(lock, () => "got it", 2000)).toBe("got it");
		expect(existsSync(lock)).toBe(false);
	});

	test("a live lock times out instead of being clobbered", () => {
		const lock = join(scratch(), "x.lock");
		mkdirSync(lock);
		writeFileSync(join(lock, "pid"), String(process.pid));
		expect(() => withLock(lock, () => 1, 100)).toThrow(/lock busy/);
	});

	test("updateRegistryAt is read-modify-write", () => {
		const reg = join(scratch(), "registry.json");
		updateRegistryAt(reg, () => ({ next: [], result: 0 }));
		writeAtomic(reg, '[{"name":"x"}]\n');
		const n = updateRegistryAt(reg, (r) => ({ result: r.length }));
		expect(n).toBe(1);
	});
});

describe("hosts-apply registry path", () => {
	const home = (u: string) => `/Users/${u}`;
	test("explicit --registry wins", () => {
		expect(hostsRegistryPath(["--registry", "/x/r.json"], {}, home)).toBe(
			"/x/r.json",
		);
	});
	test("SUDO_USER resolves the invoking user's registry", () => {
		expect(hostsRegistryPath([], { SUDO_USER: "kk" }, home)).toBe(
			"/Users/kk/.local/state/klh-local/registry.json",
		);
	});
	test("hostile SUDO_USER is ignored", () => {
		expect(
			hostsRegistryPath([], { SUDO_USER: "../../etc" }, home),
		).not.toContain("etc/.local");
	});
});
