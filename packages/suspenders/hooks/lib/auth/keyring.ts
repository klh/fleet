// hooks/lib/auth/keyring.ts — W767: the Rust keyring crate's platform contract,
// in TypeScript for fleet secrets. darwin → Keychain (/usr/bin/security),
// win32 → Windows Credential Manager (advapi32 Cred*W via bun:ffi), linux →
// Secret Service (secret-tool, when installed); every backend falls back to
// the sanctioned 0600 file home (secrets-home.ts). WHY: lib/auth.ts and
// auth-client.ts write secrets with mode 0o600 — a NO-OP on NTFS, where ACL
// inheritance leaves token files readable; a Windows spoke keeps its secrets
// at rest in Credential Manager instead. Orchestration is testable on every
// host via injected Runner/WinCredIface deps; the advapi32 binding itself
// needs a Windows host to verify on metal.
//
// Semantics (keyring-crate shaped): keySet returns the backend actually
// used; keyGet returns the secret or null; keyDelete is best-effort across
// the OS store AND the file fallback (true = something was deleted).
// Secrets ride process argv on darwin (the keychain CLI has no stdin mode;
// NUL-free) and memory blobs on win32 (binary-safe). The file store strips
// one trailing newline — secrets ending in \n lose it.

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { dlopen, FFIType, ptr, toBuffer } from "bun:ffi";
import { secretsHome } from "../secrets-home.ts";

export type KeyringBackendName =
	| "keychain"
	| "credential-manager"
	| "secret-service"
	| "file";

export interface RunResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

export type Runner = (
	cmd: string,
	args: string[],
	opts?: { input?: string },
) => RunResult;

// win32 seam — the advapi32 binding below implements this; tests inject fakes.
export interface WinCredIface {
	write(target: string, blob: Uint8Array, user: string): boolean;
	read(target: string): { blob: Uint8Array; user: string } | null;
	/** true deleted · null not-found · false error */
	del(target: string): boolean | null;
}

export interface KeyringDeps {
	platform?: string;
	run?: Runner;
	which?: (bin: string) => string | null;
	winCred?: WinCredIface;
}

const defaultRun: Runner = (cmd, args, opts) => {
	const r = spawnSync(cmd, args, {
		encoding: "utf8",
		...(opts?.input === undefined ? {} : { input: opts.input }),
	});
	return {
		status: r.status,
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
	};
};

// ---- file fallback (every platform) — the sanctioned 0600 secrets home ----

const slug = (s: string): string => s.replace(/[^A-Za-z0-9_-]+/g, "-");

function fileStorePath(service: string, user: string): string {
	return join(
		secretsHome(),
		"keyring",
		`${slug(service)}--${slug(user)}.secret`,
	);
}

function fileSet(path: string, secret: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${secret}\n`, { mode: 0o600 });
	chmodSync(path, 0o600); // pre-existing files keep 0600 (mode applies once)
}

function fileGet(path: string): string | null {
	try {
		return readFileSync(path, "utf8").replace(/\n$/, "");
	} catch {
		return null;
	}
}

function fileDel(path: string): boolean {
	try {
		rmSync(path);
		return true;
	} catch {
		return false;
	}
}

// ---- darwin Keychain (/usr/bin/security) ----

const DARWIN_SECURITY = "/usr/bin/security";

function keychainSet(
	run: Runner,
	service: string,
	user: string,
	secret: string,
): boolean {
	return (
		run(DARWIN_SECURITY, [
			"add-generic-password",
			"-U",
			"-s",
			service,
			"-a",
			user,
			"-w",
			secret,
		]).status === 0
	);
}

function keychainGet(
	run: Runner,
	service: string,
	user: string,
): string | null {
	const r = run(DARWIN_SECURITY, [
		"find-generic-password",
		"-s",
		service,
		"-a",
		user,
		"-w",
	]);
	if (r.status !== 0) return null;
	return r.stdout.replace(/\n$/, "");
}

function keychainDelete(run: Runner, service: string, user: string): boolean {
	return (
		run(DARWIN_SECURITY, ["delete-generic-password", "-s", service, "-a", user])
			.status === 0
	);
}

// ---- linux Secret Service (secret-tool, when installed) ----

function secretServiceStore(
	run: Runner,
	service: string,
	user: string,
	secret: string,
): boolean {
	// the secret rides stdin — secret-tool never takes it as argv
	return (
		run(
			"secret-tool",
			["store", "--label=klh", "service", service, "user", user],
			{ input: secret },
		).status === 0
	);
}

function secretServiceLookup(
	run: Runner,
	service: string,
	user: string,
): string | null {
	const r = run("secret-tool", ["lookup", "service", service, "user", user]);
	if (r.status !== 0 || r.stdout.length === 0) return null;
	return r.stdout.replace(/\n$/, "");
}

function secretServiceClear(
	run: Runner,
	service: string,
	user: string,
): boolean {
	return (
		run("secret-tool", ["clear", "service", service, "user", user]).status === 0
	);
}

// ---- win32 Windows Credential Manager (advapi32, lazily bound) ----

const CRED_TYPE_GENERIC = 1;
const CRED_PERSIST_LOCAL_MACHINE = 1;
const ERROR_NOT_FOUND = 1168;
const CRED_SIZE = 80;
const USER_NAME_MAX_BYTES = 4096;

// Credential Manager target name — fleet-namespaced, ASCII by law.
const credTarget = (service: string, user: string): string =>
	`klh:${service}/${user}`;

const utf16 = (s: string): Uint8Array => {
	const body = Buffer.from(s, "utf16le");
	const out = new Uint8Array(body.length + 2); // trailing UTF-16 nul
	out.set(body);
	return out;
};

// CREDENTIALW (x64): DWORD Flags · DWORD Type · LPWSTR TargetName ·
// LPWSTR Comment · FILETIME LastWritten · DWORD BlobSize · [pad] · LPBYTE
// Blob · DWORD Persist · DWORD AttributeCount · [pad] · PATTR Attributes ·
// LPWSTR TargetAlias · LPWSTR UserName.
function buildCred(
	target: Uint8Array,
	blob: Uint8Array,
	user: Uint8Array,
): ArrayBuffer {
	const buf = new ArrayBuffer(CRED_SIZE);
	const v = new DataView(buf);
	v.setUint32(0, 0, true);
	v.setUint32(4, CRED_TYPE_GENERIC, true);
	v.setBigUint64(8, BigInt(ptr(target)), true);
	v.setBigUint64(16, 0n, true);
	v.setBigUint64(24, 0n, true); // LastWritten — set by CredWrite
	v.setUint32(32, blob.length, true);
	v.setBigUint64(40, BigInt(ptr(blob)), true);
	v.setUint32(48, CRED_PERSIST_LOCAL_MACHINE, true);
	v.setUint32(52, 0, true);
	v.setBigUint64(56, 0n, true);
	v.setBigUint64(64, 0n, true);
	v.setBigUint64(72, BigInt(ptr(user)), true);
	return buf;
}

let winCredSingleton: WinCredIface | null = null;

// Binding correctness needs a Windows host to verify on metal; the
// orchestration above it is exercised everywhere via the injected seam.
export function winCredIface(): WinCredIface {
	if (winCredSingleton !== null) return winCredSingleton;
	const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
	const advapi = dlopen(
		join(system32, "advapi32.dll"),
		{
			CredWriteW: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
			CredReadW: {
				args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
				returns: FFIType.i32,
			},
			CredDeleteW: {
				args: [FFIType.ptr, FFIType.u32, FFIType.u32],
				returns: FFIType.i32,
			},
			CredFree: { args: [FFIType.ptr], returns: FFIType.void },
		},
		true,
	).symbols;
	const kernel32 = dlopen(
		join(system32, "kernel32.dll"),
		{ GetLastError: { args: [], returns: FFIType.u32 } },
		true,
	).symbols;

	winCredSingleton = {
		write(target, blob, user) {
			const t = utf16(target);
			const b = Uint8Array.from(blob);
			const u = utf16(user);
			const cred = buildCred(t, b, u);
			return advapi.CredWriteW(ptr(cred), 0) !== 0;
		},
		read(target) {
			const t = utf16(target);
			const out = new BigUint64Array(1);
			if (advapi.CredReadW(ptr(t), CRED_TYPE_GENERIC, 0, ptr(out)) === 0) {
				return null;
			}
			const cred = Number(out[0]);
			try {
				const struct = toBuffer(cred, CRED_SIZE);
				const v = new DataView(struct.buffer, struct.byteOffset, CRED_SIZE);
				const size = v.getUint32(32, true);
				const blobPtr = Number(v.getBigUint64(40, true));
				const userPtr = Number(v.getBigUint64(72, true));
				const blob = new Uint8Array(toBuffer(blobPtr, size)); // copy
				let ulen = 0; // walk the nul-terminated UTF-16 UserName in-bounds
				while (ulen + 2 <= USER_NAME_MAX_BYTES) {
					const pair = toBuffer(userPtr + ulen, 2);
					if (pair[0] === 0 && pair[1] === 0) break;
					ulen += 2;
				}
				const owner = new TextDecoder("utf-16le").decode(
					new Uint8Array(toBuffer(userPtr, ulen)),
				);
				return { blob, user: owner };
			} finally {
				advapi.CredFree(ptr(cred));
			}
		},
		del(target) {
			const t = utf16(target);
			if (advapi.CredDeleteW(ptr(t), CRED_TYPE_GENERIC, 0) !== 0) return true;
			return kernel32.GetLastError() === ERROR_NOT_FOUND ? null : false;
		},
	};
	return winCredSingleton;
}

// ---- orchestration: backend dispatch + file fallback ----

export function keyBackend(deps: KeyringDeps = {}): KeyringBackendName {
	const platform = deps.platform ?? process.platform;
	if (platform === "darwin") return "keychain";
	if (platform === "win32") return "credential-manager";
	if (
		platform === "linux" &&
		(deps.which ?? Bun.which)("secret-tool") !== null
	) {
		return "secret-service";
	}
	return "file";
}

export function keySet(
	service: string,
	user: string,
	secret: string,
	deps: KeyringDeps = {},
): KeyringBackendName {
	const platform = deps.platform ?? process.platform;
	if (platform === "darwin") {
		if (keychainSet(deps.run ?? defaultRun, service, user, secret)) {
			return "keychain";
		}
	} else if (platform === "win32") {
		const wc = deps.winCred ?? winCredIface();
		if (
			wc.write(credTarget(service, user), Buffer.from(secret, "utf8"), user)
		) {
			return "credential-manager";
		}
	} else if (platform === "linux") {
		if (secretServiceStore(deps.run ?? defaultRun, service, user, secret)) {
			return "secret-service";
		}
	}
	fileSet(fileStorePath(service, user), secret);
	return "file";
}

export function keyGet(
	service: string,
	user: string,
	deps: KeyringDeps = {},
): string | null {
	const platform = deps.platform ?? process.platform;
	let osValue: string | null = null;
	if (platform === "darwin") {
		osValue = keychainGet(deps.run ?? defaultRun, service, user);
	} else if (platform === "win32") {
		const hit = (deps.winCred ?? winCredIface()).read(
			credTarget(service, user),
		);
		if (hit !== null) osValue = new TextDecoder().decode(hit.blob);
	} else if (platform === "linux") {
		osValue = secretServiceLookup(deps.run ?? defaultRun, service, user);
	}
	return osValue ?? fileGet(fileStorePath(service, user));
}

export function keyDelete(
	service: string,
	user: string,
	deps: KeyringDeps = {},
): boolean {
	const platform = deps.platform ?? process.platform;
	let osDeleted: boolean | null = false;
	if (platform === "darwin") {
		osDeleted = keychainDelete(deps.run ?? defaultRun, service, user);
	} else if (platform === "win32") {
		osDeleted = (deps.winCred ?? winCredIface()).del(credTarget(service, user));
	} else if (platform === "linux") {
		osDeleted = secretServiceClear(deps.run ?? defaultRun, service, user);
	}
	return osDeleted === true || fileDel(fileStorePath(service, user));
}
