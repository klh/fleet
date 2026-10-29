// scripts/install/install-connections.ts — W1234: the wireConnections install step.
// ASK "Proxy desktop GUIs (VS Code, ChatGPT, Claude) through the hub? [Y/n]"
// — in the install chain's native consent door: --yes answers it, an
// unconsented run pauses with need_user_action + resume_command (the
// installer NEVER blocks on a prompt). If connections.json exists it is
// NEVER overwritten (config-over-code). W2284 (owner ruling 2026-10-29: the
// buckle proxy is NOT a system proxy): the universal launchctl face is
// RETIRED — every run UNSETS whatever a previous install left in the launchd
// user domain; routing rides the scoped env/singbox faces.
// Idempotent: re-runs converge (same file bytes, same unsets).
import { existsSync } from "node:fs";
import { tryLoadStack } from "../../hooks/lib/stack-config.ts";
import {
	assertNoSecrets,
	CONNECTIONS_PATH,
	type ConnectFace,
	loadConnections,
	writeDefaultConfig,
} from "../lib/connections.ts";
import type { StepContext, StepResult } from "./install-run.ts";

/** The exact ask the install chain surfaces for this step. */
export const GUI_PROXY_ASK =
	"Proxy desktop GUIs (VS Code, ChatGPT, Claude) through the hub? [Y/n]";

/** CONNECT-face probe — injectable for the same reason (tests stub the
 *  wire; the real one dials the live egress). */
export type ConnectProbe = (
	face: ConnectFace,
) => Promise<{ ok: boolean; why: string }>;

/** hub-resolution face — injectable for the same reason (the real chain
 *  probes dns-sd/mdns for seconds on a miss). */
export type EndpointResolve = (
	label: string,
) => Promise<{ url: string; via: string } | null>;

/** The template written when connections.json is ABSENT. Default-ON
 *  (W1260.1): every detected GUI app's AI destinations route through the
 *  authenticated Buckle CONNECT relay — TLS opaque end-to-end, never MITM
 *  (the W1231 chatgpt.com ban is unaffected; the relay sees SNI only). The
 *  operator opts OUT via connections.json. codex rides the `buckle`
 *  fallback rule — its CLI steers via user-level config (owner #67959). */
export function defaultTemplate(defaultHub: string): ConnectionsConfig {
	return {
		version: 1,
		default: defaultHub,
		apps: {
			claude: { enabled: true },
			chatgpt: { enabled: true },
			vscode: { enabled: true },
			codex: { enabled: true },
		},
		repos: {},
	};
}

/** The default hub label for a fresh config: SUSPENDERS_DEFAULT_HUB env, else
 *  the first stack.yaml hub profile (operator authoring order = intent). */
export function defaultHubLabel(): string | null {
	const envHub = process.env.SUSPENDERS_DEFAULT_HUB;
	if (envHub && envHub.trim() !== "") return envHub.trim();
	const first = Object.keys(tryLoadStack()?.hubs ?? {})[0];
	return first ?? null;
}

/** W2284 (owner ruling 2026-10-29: the buckle proxy is NOT a system proxy)
 *  — the universal launchctl face is RETIRED. The launchd user domain is
 *  machine-wide env: setting it proxied every terminal, npm, git and test
 *  run through the CONNECT relay. The step now ends with the domain CLEAN:
 *  it unsets the proxy trio unconditionally on every invocation (W2198's
 *  clear-dead-proxy intent, generalized), and routing rides the SCOPED
 *  faces instead — `connections emit env` for opt-in AI-CLI shells,
 *  `connections emit singbox --out <file>` for process-scoped GUI
 *  enforcement (TLS opaque, never MITM — W1231/W1233/W1260.2). */
export const RETIRED_LAUNCHCTL_KEYS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
] as const;

/** launchctl teardown runner — injectable so tests never touch the host.
 *  Empty value = unsetenv (the old W2198 facePairs contract, kept). */
export type LaunchctlRun = (
	pairs: { key: string; value: "" }[] | { key: string; value: string }[],
) => Promise<void>;

/** W2198 hardened the runner to map empty values to unsetenv; W2284 keeps
 *  exactly that half — the step only ever clears now, never sets. */
const realLaunchctlRun: LaunchctlRun = async (pairs) => {
	const { execa } = await import("execa");
	for (const p of pairs)
		await execa(
			"launchctl",
			p.value === "" ? ["unsetenv", p.key] : ["setenv", p.key, p.value],
			{ reject: false },
		);
};

/** Unconditionally clear the retired face's launchd writes — the proxy
 *  trio. Clearing needs no hub; it runs on EVERY invocation (even a
 *  paused or failed step ends with the domain clean). */
async function clearLaunchctlProxy(run: LaunchctlRun): Promise<string> {
	await run(RETIRED_LAUNCHCTL_KEYS.map((key) => ({ key, value: "" })));
	return "launchctl proxy vars UNSET (W2284: universal face retired — route AI CLIs via `connections emit env`, Dock GUIs via `connections emit singbox`)";
}

/** The wireConnections step: ask, write-once, retire the universal face.
 *  The clear runs FIRST — every path (consented, paused, failed) ends with
 *  the launchd user domain clean. */
export async function wireConnections(
	ctx: StepContext,
	run: LaunchctlRun = realLaunchctlRun,
): Promise<StepResult> {
	const cleared = await clearLaunchctlProxy(run);
	const path = CONNECTIONS_PATH();
	if (existsSync(path)) {
		const load = loadConnections(path);
		if (!load.ok)
			return {
				status: "failed",
				note: `connections.json at ${path} unparseable: ${load.why}`,
			};
		return {
			status: "ok",
			note: `connections.json present (never overwritten) — ${cleared}`,
		};
	}
	const hub = defaultHubLabel();
	if (!hub)
		return {
			status: "skipped",
			note: "no first hub (SUSPENDERS_DEFAULT_HUB unset, stack.yaml has no hub profiles) — name one in ~/.fleet/config/connections.json when ready",
		};
	if (!ctx.yes)
		return {
			status: "need_user_action",
			note: `${GUI_PROXY_ASK} — resume_command runs this step with --yes (writes ${path} mode 600; the universal launchctl proxy face is retired — W2284); decline by leaving connections.json absent`,
		};
	const cfg = defaultTemplate(hub);
	assertNoSecrets(JSON.stringify(cfg));
	writeDefaultConfig(path, cfg);
	return {
		status: "ok",
		note: `${GUI_PROXY_ASK} — consented (--yes): wrote ${path} (mode 600, default hub ${hub}); ${cleared}`,
	};
}
