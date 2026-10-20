// Fleet-loop's config-gated refresh. The applied marker advances only after
// LiteLLM and Buckle accept the new model list; failed activation retries.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StackConfig } from "../hooks/lib/stack-config.ts";
import { fetchFreeSnapshot, writeFreeSnapshot } from "./openrouter-free.ts";

const home = process.env.HOME ?? homedir();
const keyFile = join(home, ".claude/local-llm/openrouter.key");
const generator = join(home, ".claude/local-llm/gateway-config.ts");
const liteKeyFile = join(home, ".claude/local-llm/litellm.key");

const keyFileReady = (): boolean => {
	try {
		const key = statSync(keyFile);
		return key.isFile() && (key.mode & 0o777) === 0o600 && key.size > 0;
	} catch {
		return false;
	}
};

const run = (argv: string[], env?: Record<string, string>): void => {
	execFileSync(argv[0], argv.slice(1), {
		env: env ? { ...process.env, ...env } : process.env,
		encoding: "utf8",
		timeout: 120_000,
	});
};

const cloudGatewayLabel = `gui/${process.getuid?.() ?? 0}/com.suspenders.cloud-gateway`;

/** Terminate only the verified LiteLLM listener. Launchd then restarts the
 * cloud gateway; killing its parent first can orphan a child holding :4100. */
const restartLiteLLM = (): void => {
	let raw: string;
	try {
		raw = execFileSync("lsof", ["-nP", "-tiTCP:4100", "-sTCP:LISTEN"], {
			encoding: "utf8",
		}).trim();
	} catch {
		run(["launchctl", "kickstart", cloudGatewayLabel]);
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
};

const cloudGatewayRunning = (): boolean => {
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

const waitForLiteLLMModels = async (names: string[]): Promise<void> => {
	const master = readFileSync(liteKeyFile, "utf8").trim();
	if (!master) throw new Error("LiteLLM master key file is empty");
	for (let attempt = 0; attempt < 60; attempt++) {
		try {
			const response = await fetch("http://127.0.0.1:4100/v1/models", {
				headers: { authorization: `Bearer ${master}` },
				signal: AbortSignal.timeout(1500),
			});
			if (response.ok) {
				const body = (await response.json()) as {
					data?: Array<{ id?: string }>;
				};
				const seen = new Set(body.data?.map((row) => row.id));
				if (names.every((name) => seen.has(name)) && cloudGatewayRunning())
					return;
			}
		} catch {
			/* retry while the supervised engine starts */
		}
		await Bun.sleep(1000);
	}
	throw new Error("LiteLLM did not list the refreshed OpenRouter models");
};

const markerHash = (groups: unknown): string =>
	createHash("sha256").update(JSON.stringify(groups)).digest("hex");
const appliedHash = (path: string): string | null => {
	try {
		return readFileSync(`${path}.applied`, "utf8").trim();
	} catch {
		return null;
	}
};
const writeAppliedHash = (path: string, hash: string): void => {
	const temp = `${path}.applied.${crypto.randomUUID()}.tmp`;
	writeFileSync(temp, `${hash}\n`, { mode: 0o600, flag: "wx" });
	renameSync(temp, `${path}.applied`);
};

export async function refreshConfiguredOpenRouter(
	stack: StackConfig,
): Promise<string[]> {
	const configured = Object.entries(stack.hubs).filter(
		([, hub]) => hub.upstreams?.openrouter_free_catalog_file,
	);
	if (configured.length === 0) return [];
	if (!keyFileReady())
		return ["OpenRouter refresh idle: inference key missing or not mode 0600"];
	const eligible = configured.filter(
		([, hub]) =>
			hub.buckle_prefs?.allow_cloud === true &&
			hub.secrets?.upstream_keys?.LITELLM_KEY,
	);
	if (eligible.length === 0)
		return [
			"OpenRouter refresh idle: no hub has cloud opt-in and a LiteLLM key path",
		];
	const snapshot = await fetchFreeSnapshot();
	const hash = markerHash(snapshot.groups);
	const messages: string[] = [];
	for (const [name, hub] of eligible) {
		const path = hub.upstreams?.openrouter_free_catalog_file;
		if (!path) continue;
		writeFreeSnapshot(path, snapshot);
		if (appliedHash(path) === hash) {
			messages.push(
				`${name}: ${Object.keys(snapshot.groups).length} routes unchanged`,
			);
			continue;
		}
		if (process.platform !== "darwin" || hub.deploy?.ssh)
			throw new Error(
				`${name}: automatic LiteLLM reload currently requires a local macOS hub`,
			);
		run([process.execPath, generator], { OPENROUTER_FREE_CATALOG: path });
		restartLiteLLM();
		await waitForLiteLLMModels(Object.keys(snapshot.groups));
		run([
			process.execPath,
			join(import.meta.dir, "hubctl.ts"),
			"reload-upstreams",
			name,
		]);
		writeAppliedHash(path, hash);
		messages.push(
			`${name}: activated ${Object.keys(snapshot.groups).length} OpenRouter free routes`,
		);
	}
	return messages;
}
