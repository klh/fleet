// Shared LiteLLM activation helpers for the scheduled catalog refreshes
// (W1029.1): regenerate litellm.yaml from the current on-disk snapshots,
// restart the local :4100 engine, wait until the refreshed model rows are
// live, and stamp the applied marker only after activation succeeds — a
// failure leaves the previous routes serving and retries next cadence.
// The OpenRouter and Z.ai refreshes share the ONE :4100 engine, so both
// ride these helpers and both pass BOTH catalog env knobs into every
// regeneration (the serialization contract).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = process.env.HOME ?? homedir();

/** Installed runtime copy of belt's LiteLLM config generator. */
export const gatewayGenerator = join(
	home,
	".claude/local-llm/gateway-config.ts",
);

/** LiteLLM master key file for authenticated /v1/models probes. */
export const litellmKeyFile = join(home, ".claude/local-llm/litellm.key");

export type Runner = (argv: string[], env?: Record<string, string>) => void;

export const runCommand: Runner = (argv, env) => {
	execFileSync(argv[0], argv.slice(1), {
		env: env ? { ...process.env, ...env } : process.env,
		encoding: "utf8",
		timeout: 120_000,
	});
};

export const cloudGatewayLabel = `gui/${
	process.getuid?.() ?? 0
}/com.suspenders.cloud-gateway`;

/** Terminate only the verified LiteLLM listener. Launchd then restarts the
 * cloud gateway; killing its parent first can orphan a child holding :4100. */
export function restartLiteLLM(): void {
	let raw: string;
	try {
		raw = execFileSync("lsof", ["-nP", "-tiTCP:4100", "-sTCP:LISTEN"], {
			encoding: "utf8",
		}).trim();
	} catch {
		runCommand(["launchctl", "kickstart", cloudGatewayLabel]);
		return;
	}
	const pids = raw.split(/\s+/).map(Number).filter(Number.isInteger);
	if (pids.length !== 1)
		throw new Error("LiteLLM refresh requires exactly one :4100 listener");
	const processes = JSON.parse(
		execFileSync("procs", ["--json", "litellm"], { encoding: "utf8" }),
	) as Array<{ PID?: number; Command?: string }>;
	const command = processes.find((row) => row.PID === pids[0])?.Command;
	const expected = `--host 127.0.0.1 --config ${join(home, ".claude/local-llm/litellm.yaml")} --port 4100`;
	if (!command?.includes("/litellm ") || !command.endsWith(expected))
		throw new Error("refusing to terminate an unrecognized :4100 listener");
	process.kill(pids[0], "SIGTERM");
}

export const cloudGatewayRunning = (): boolean => {
	try {
		return /state = running/.test(
			execFileSync("launchctl", ["print", cloudGatewayLabel], {
				encoding: "utf8",
			}),
		);
	} catch {
		return false;
	}
};

export interface WaitDeps {
	/** Probe the :4100 /v1/models listing (tests inject a stub). */
	probe?: (
		url: string,
		headers: { authorization: string },
	) => Promise<{ ok: boolean; ids: string[] }>;
	/** Master key file for the default probe; empty/missing = unusable. */
	keyFile?: string;
	attempts?: number;
	sleep?: (ms: number) => Promise<void>;
}

const defaultProbe = async (
	url: string,
	headers: { authorization: string },
): Promise<{ ok: boolean; ids: string[] }> => {
	const response = await fetch(url, {
		headers,
		signal: AbortSignal.timeout(1500),
	});
	if (!response.ok) return { ok: false, ids: [] };
	const body = (await response.json()) as { data?: Array<{ id?: string }> };
	return { ok: true, ids: (body.data ?? []).map((row) => row.id ?? "") };
};

/** Resolve only when every name is listed AND the cloud gateway supervises.
 *  Throws after the attempt budget — the caller keeps last-good routes. */
export async function waitForLiteLLMModels(
	names: string[],
	deps: WaitDeps = {},
): Promise<void> {
	const master = readFileSync(deps.keyFile ?? litellmKeyFile, "utf8").trim();
	if (!master) throw new Error("LiteLLM master key file is empty");
	const probe = deps.probe ?? defaultProbe;
	const sleep = deps.sleep ?? Bun.sleep;
	for (let attempt = 0; attempt < (deps.attempts ?? 60); attempt++) {
		try {
			const listing = await probe("http://127.0.0.1:4100/v1/models", {
				authorization: `Bearer ${master}`,
			});
			const seen = new Set(listing.ids);
			if (listing.ok && names.every((name) => seen.has(name))) return;
		} catch {
			/* retry while the supervised engine starts */
		}
		await sleep(1000);
	}
	throw new Error("LiteLLM did not list the refreshed catalog models");
}

export const markerHash = (value: unknown): string =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const appliedHash = (path: string): string | null => {
	try {
		return readFileSync(`${path}.applied`, "utf8").trim();
	} catch {
		return null;
	}
};

export const writeAppliedHash = (path: string, hash: string): void => {
	const temp = `${path}.applied.${crypto.randomUUID()}.tmp`;
	writeFileSync(temp, `${hash}\n`, { mode: 0o600, flag: "wx" });
	renameSync(temp, `${path}.applied`);
};
