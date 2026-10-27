// test/keyring.test.ts — W767: platform dispatch, file fallback posture,
// darwin keychain roundtrip on the real /usr/bin/security, linux
// secret-tool argv/stdin shape via a fake runner, and win32 orchestration
// through the injected WinCredIface seam (the advapi32 binding itself needs
// a Windows host to verify on metal). Every test points BUCKLE_SECRETS_HOME
// at a fresh temp dir — no test material touches the real secrets home.
import { expect, test } from "./pw";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	keyBackend,
	keyDelete,
	keyGet,
	keySet,
	type KeyringDeps,
	type Runner,
	type WinCredIface,
} from "../hooks/lib/auth/keyring.ts";

const Svc = "klh-fleet-keyring-test";
const User = "lane-test";

const envHome = (): string => process.env.BUCKLE_SECRETS_HOME ?? "";

test.beforeEach(() => {
	process.env.BUCKLE_SECRETS_HOME = mkdtempSync(
		join(tmpdir(), "keyring-test-"),
	);
});

test.afterEach(() => {
	delete process.env.BUCKLE_SECRETS_HOME;
});

test.describe("keyring (W767)", () => {
	test("backend matrix: keychain · credential-manager · secret-tool optional · file", () => {
		expect(keyBackend({ platform: "darwin" })).toBe("keychain");
		expect(keyBackend({ platform: "win32" })).toBe("credential-manager");
		expect(
			keyBackend({ platform: "linux", which: () => "/usr/bin/secret-tool" }),
		).toBe("secret-service");
		expect(keyBackend({ platform: "linux", which: () => null })).toBe("file");
		expect(keyBackend({ platform: "sunos" })).toBe("file");
	});

	test("file backend roundtrip on an unknown platform (0600 at rest)", () => {
		expect(keySet(Svc, User, "s3cret-value", { platform: "sunos" })).toBe(
			"file",
		);
		const p = join(envHome(), "keyring", `${Svc}--${User}.secret`);
		expect(statSync(p).mode & 0o777).toBe(0o600);
		expect(keyGet(Svc, User, { platform: "sunos" })).toBe("s3cret-value");
		expect(keyDelete(Svc, User, { platform: "sunos" })).toBe(true);
		expect(keyGet(Svc, User, { platform: "sunos" })).toBe(null);
	});

	test("darwin backend failure falls back to the file store", () => {
		const run: Runner = () => ({ status: 45, stdout: "", stderr: "boom" });
		expect(keySet(Svc, User, "v", { platform: "darwin", run })).toBe("file");
		expect(keyGet(Svc, User, { platform: "darwin", run })).toBe("v");
		expect(keyDelete(Svc, User, { platform: "darwin", run })).toBe(true);
	});

	test("win32 orchestration: fleet target naming, utf8 blob, file fallback on miss", () => {
		const seen: { target: string; blob: Uint8Array; user: string }[] = [];
		const miss: WinCredIface = {
			write(target, blob, user) {
				seen.push({ target, blob, user });
				return true;
			},
			read: () => null,
			del: () => null,
		};
		expect(
			keySet(Svc, User, "w-secret", { platform: "win32", winCred: miss }),
		).toBe("credential-manager");
		expect(seen[0].target).toBe(`klh:${Svc}/${User}`);
		expect(seen[0].user).toBe(User);
		expect(new TextDecoder().decode(seen[0].blob)).toBe("w-secret");
		// a miss falls through to the file store — which is empty → null
		expect(keyGet(Svc, User, { platform: "win32", winCred: miss })).toBe(null);
	});

	test("win32 in-memory store roundtrip: set/get/delete through the seam", () => {
		const store = new Map<string, Uint8Array>();
		const mem: WinCredIface = {
			write: (t, b) => {
				store.set(t, b);
				return true;
			},
			read: (t) => {
				const b = store.get(t);
				return b === undefined ? null : { blob: b, user: User };
			},
			del: (t) => (store.delete(t) ? true : null),
		};
		const d: KeyringDeps = { platform: "win32", winCred: mem };
		expect(keySet(Svc, User, "mem-secret", d)).toBe("credential-manager");
		expect(keyGet(Svc, User, d)).toBe("mem-secret");
		expect(keyDelete(Svc, User, d)).toBe(true);
		expect(keyGet(Svc, User, d)).toBe(null);
		expect(keyDelete(Svc, User, d)).toBe(false);
	});

	test("linux secret-tool path: label flag present, secret rides stdin", () => {
		const calls: { args: string[]; input?: string }[] = [];
		const run: Runner = (cmd, args, opts) => {
			calls.push({
				args: [cmd, ...args],
				...(opts?.input === undefined ? {} : { input: opts.input }),
			});
			return { status: 0, stdout: "", stderr: "" };
		};
		const d: KeyringDeps = { platform: "linux", run };
		expect(keySet(Svc, User, "linux-secret", d)).toBe("secret-service");
		expect(calls[0].args).toContain("--label=klh");
		expect(calls[0].input).toBe("linux-secret");
		expect(keyDelete(Svc, User, d)).toBe(true);
		expect(calls[calls.length - 1].args[1]).toBe("clear");
	});

	test("darwin keychain roundtrip on the real security CLI", () => {
		if (process.platform !== "darwin") return;
		if (!existsSync("/usr/bin/security")) return;
		const d: KeyringDeps = { platform: "darwin" };
		try {
			expect(keySet(Svc, User, "keychain-secret", d)).toBe("keychain");
			expect(keyGet(Svc, User, d)).toBe("keychain-secret");
			expect(keyDelete(Svc, User, d)).toBe(true);
			expect(keyGet(Svc, User, d)).toBe(null);
		} finally {
			keyDelete(Svc, User, d); // no test material stays in the login keychain
		}
	});
});
