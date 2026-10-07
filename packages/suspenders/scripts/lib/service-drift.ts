import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { stableDescendant, type OwnershipDeps } from "./owned-process.ts";

export interface ActivationService {
	label: string;
	unit: string;
	unitSha256: string;
	arguments: string[];
	resident: boolean;
	port?: number;
}
export interface ActivationReceipt {
	schema: "fleet.service-activation.v1";
	platform: "darwin";
	domain: string;
	manifest: string;
	manifestSha256: string;
	services: ActivationService[];
}
export type Inspection = { code: number; out: string; error: string };
export type Inspect = (args: string[]) => Inspection;
export interface ServiceVerdict {
	label: string;
	state:
		| "unloaded"
		| "disabled"
		| "unknown"
		| "drift"
		| "scheduled-idle"
		| "starting"
		| "running"
		| "degraded";
	reason: string;
	pid: number | null;
}
export const digestUnit = (bytes: string | Uint8Array): string =>
	new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
export function readActivation(path: string): ActivationReceipt {
	if (statSync(path).size > 262144)
		throw new Error("activation receipt too large");
	const receipt = JSON.parse(readFileSync(path, "utf8")) as ActivationReceipt;
	if (
		receipt.schema !== "fleet.service-activation.v1" ||
		receipt.platform !== "darwin" ||
		typeof receipt.manifest !== "string" ||
		!receipt.manifest.startsWith("/") ||
		!/^[a-f0-9]{64}$/.test(receipt.manifestSha256) ||
		!/^gui\/\d+$/.test(receipt.domain) ||
		!Array.isArray(receipt.services) ||
		receipt.services.length > 64
	)
		throw new Error("invalid activation receipt");
	for (const service of receipt.services) {
		if (
			!/^com\.suspenders\.[a-z0-9-]+$/.test(service.label) ||
			!service.unit.startsWith("/") ||
			!/^[a-f0-9]{64}$/.test(service.unitSha256) ||
			!Array.isArray(service.arguments) ||
			service.arguments.length === 0 ||
			service.arguments.some((arg) => typeof arg !== "string") ||
			typeof service.resident !== "boolean" ||
			(service.port !== undefined &&
				(!Number.isInteger(service.port) ||
					service.port < 1 ||
					service.port > 65535))
		)
			throw new Error("invalid activation service");
	}
	return receipt;
}
/** Prior validated activation intent survives failed or omitted re-registration. */
export function retainActivation(
	receipt: ActivationReceipt,
	previous?: ActivationReceipt,
): ActivationReceipt {
	const services = new Map<string, ActivationService>();
	if (previous?.domain === receipt.domain)
		for (const service of previous.services)
			services.set(service.label, service);
	for (const service of receipt.services) services.set(service.label, service);
	return { ...receipt, services: [...services.values()] };
}
/** Atomic private receipt publication; failed validation/publication retains prior intent. */
export function writeActivation(
	path: string,
	receipt: ActivationReceipt,
	publish: (source: string, target: string) => void = renameSync,
): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${crypto.randomUUID()}`;
	try {
		writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600 });
		readActivation(temporary);
		publish(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}
const defaultInspect: Inspect = (args) => {
	try {
		const child = Bun.spawnSync(args, {
			stdout: "pipe",
			stderr: "pipe",
			timeout: 3000,
			maxBuffer: 262144,
		});
		return {
			code: child.exitCode ?? 1,
			out: child.stdout.toString(),
			error: child.stderr.toString(),
		};
	} catch {
		return { code: 1, out: "", error: "inspection unavailable" };
	}
};
export function inspectServices(
	receipt: ActivationReceipt,
	domain: string,
	authoritativeManifest: string,
	inspect: Inspect = defaultInspect,
	readUnit: (path: string) => string = (path) => {
		if (statSync(path).size > 262144) throw new Error("unit too large");
		return readFileSync(path, "utf8");
	},
	ownership?: OwnershipDeps,
): ServiceVerdict[] {
	let manifestState: "unknown" | "drift" | null = null;
	try {
		if (digestUnit(readUnit(authoritativeManifest)) !== receipt.manifestSha256)
			manifestState = "drift";
	} catch {
		manifestState = "unknown";
	}
	const disabled =
		receipt.domain === domain
			? inspect(["/bin/launchctl", "print-disabled", domain])
			: null;
	return receipt.services.map((service) => {
		const result = (
			state: ServiceVerdict["state"],
			reason: string,
			pid: number | null = null,
		): ServiceVerdict => ({ label: service.label, state, reason, pid });
		if (receipt.domain !== domain)
			return result(
				"unknown",
				"activation domain does not match current domain",
			);
		if (manifestState)
			return result(
				manifestState,
				"canonical manifest differs from receipt or cannot be inspected",
			);
		if (disabled?.code !== 0)
			return result("unknown", "disabled state inspection failed");
		if (disabled.out.includes(`"${service.label}" => true`))
			return result("disabled", "explicit launchd override");
		let unit: string;
		try {
			unit = readUnit(service.unit);
		} catch {
			return result("unknown", "recorded unit unavailable");
		}
		if (digestUnit(unit) !== service.unitSha256)
			return result("drift", "installed unit differs from activation receipt");
		const loaded = inspect([
			"/bin/launchctl",
			"print",
			`${domain}/${service.label}`,
		]);
		if (loaded.code !== 0)
			return result(
				/Could not find service|Could not find specified service/.test(
					loaded.error,
				)
					? "unloaded"
					: "unknown",
				"exact-domain service inspection failed",
			);
		const argBlock = /\n\s*arguments = \{([\s\S]*?)\n\s*\}/.exec(loaded.out);
		if (!argBlock) return result("unknown", "loaded arguments unavailable");
		const args = argBlock[1]
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		if (JSON.stringify(args) !== JSON.stringify(service.arguments))
			return result(
				"drift",
				"loaded arguments differ from activated definition",
			);
		const pidText = /\n\s*pid = (\d+)/.exec(loaded.out)?.[1];
		const pid = pidText ? Number(pidText) : null;
		const state = /\n\s*state = ([^\n]+)/.exec(loaded.out)?.[1].trim();
		if (!pid) {
			if (!service.resident && state === "not running") {
				const lastExit = /\n\s*last exit code = ([^\n]+)/
					.exec(loaded.out)?.[1]
					.trim();
				if (lastExit !== undefined && !/^-?\d+$/.test(lastExit))
					return result(
						"unknown",
						"scheduled invocation exit status is ambiguous",
					);
				if (lastExit !== undefined && Number(lastExit) !== 0)
					return result(
						"degraded",
						`scheduled invocation failed with exit code ${Number(lastExit)}`,
					);
				const runs = /\n\s*runs = (\d+)/.exec(loaded.out)?.[1];
				if (
					lastExit === undefined &&
					(Number(runs) > 0 ||
						/\n\s*last terminating signal =/.test(loaded.out))
				)
					return result(
						"unknown",
						"prior scheduled invocation outcome unavailable",
					);
				return result(
					"scheduled-idle",
					"scheduled job loaded; last invocation successful or not yet run",
				);
			}
			if (state === "waiting" || state === "spawn scheduled")
				return result("starting", "resident awaiting launch");
			return result(
				service.resident ? "degraded" : "unknown",
				"loaded job has no verified running PID",
			);
		}
		if (service.port !== undefined) {
			const listeners = inspect([
				"/usr/sbin/lsof",
				"-nP",
				"-t",
				`-iTCP:${service.port}`,
				"-sTCP:LISTEN",
			]);
			if (listeners.code !== 0 && listeners.code !== 1)
				return result("unknown", "listener inspection failed", pid);
			const owners = listeners.out.trim().split("\n").filter(Boolean);
			if (listeners.code === 1 && listeners.error)
				return result("unknown", "listener inspection failed", pid);
			if (owners.length === 1 && owners[0] !== String(pid)) {
				// One bounded recheck handles a legitimate launchd replacement between observations.
				const fresh = inspect([
					"/bin/launchctl",
					"print",
					`${domain}/${service.label}`,
				]);
				if (fresh.code !== 0)
					return result("unknown", "supervised PID recheck unavailable", pid);
				const freshPid = /\n\s*pid = (\d+)/.exec(fresh.out)?.[1];
				const freshBlock = /\n\s*arguments = \{([\s\S]*?)\n\s*\}/.exec(
					fresh.out,
				);
				const freshArgs = freshBlock?.[1]
					.split("\n")
					.map((line) => line.trim())
					.filter(Boolean);
				if (
					freshPid === owners[0] &&
					JSON.stringify(freshArgs) === JSON.stringify(service.arguments)
				)
					return result(
						"running",
						"supervised listener verified after bounded PID recheck",
						Number(freshPid),
					);
				if (
					freshPid === String(pid) &&
					JSON.stringify(freshArgs) === JSON.stringify(service.arguments)
				) {
					const owned = stableDescendant(Number(owners[0]), pid, ownership);
					if (owned === "unknown")
						return result(
							"unknown",
							"supervised descendant start identity or ancestry unavailable or changed",
							pid,
						);
					if (owned === "owned") {
						const currentListeners = inspect([
							"/usr/sbin/lsof",
							"-nP",
							"-t",
							`-iTCP:${service.port}`,
							"-sTCP:LISTEN",
						]);
						if (
							currentListeners.code !== 0 ||
							currentListeners.out.trim() !== owners[0]
						)
							return result(
								"unknown",
								"descendant listener changed during ownership verification",
								pid,
							);
						return result(
							"running",
							"activated supervisor owns listener through stable bounded descendant ancestry",
							pid,
						);
					}
				}
			}
			if (owners.length !== 1 || owners[0] !== String(pid))
				return result(
					"degraded",
					"port listener is absent or owned outside the supervised process",
					pid,
				);
		}
		return result(
			"running",
			service.port === undefined
				? "loaded definition matches; no listener port declared"
				: "loaded arguments and supervised listener match",
			pid,
		);
	});
}
export function driftNotices(
	verdicts: ServiceVerdict[],
	previous: Record<string, string> = {},
	now = Date.now(),
	lastAt = 0,
): { fingerprints: Record<string, string>; notices: ServiceVerdict[] } {
	const fingerprints: Record<string, string> = {};
	const notices: ServiceVerdict[] = [];
	for (const verdict of verdicts) {
		const fingerprint = `${verdict.state}:${verdict.reason}`;
		fingerprints[verdict.label] = fingerprint;
		const healthy =
			verdict.state === "running" ||
			verdict.state === "scheduled-idle" ||
			verdict.state === "starting";
		if (
			(previous[verdict.label] !== fingerprint &&
				(!healthy || previous[verdict.label] !== undefined)) ||
			(!healthy && now - lastAt >= 3600000)
		)
			notices.push(verdict);
	}
	return { fingerprints, notices, notifiedAt: notices.length ? now : lastAt };
}
