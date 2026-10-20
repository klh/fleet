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

const waitForLiteLLMModels = async (names: string[]): Promise<void> => {
	const master = readFileSync(liteKeyFile, "utf8").trim();
	if (!master) throw new Error("LiteLLM master key file is empty");
	for (let attempt = 0; attempt < 20; attempt++) {
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
				if (names.every((name) => seen.has(name))) return;
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
		run([
			"launchctl",
			"kickstart",
			"-k",
			`gui/${process.getuid?.() ?? 0}/com.suspenders.cloud-gateway`,
		]);
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
