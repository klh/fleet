// scripts/install-connections.ts — W1234: the wireConnections install step.
// ASK "Proxy desktop GUIs (VS Code, ChatGPT, Claude) through the hub? [Y/n]"
// — in the install chain's native consent door: --yes answers it, an
// unconsented run pauses with need_user_action + resume_command (the
// installer NEVER blocks on a prompt). If connections.json exists it is
// NEVER overwritten (config-over-code); only the launchctl face re-applies.
// Idempotent: re-runs converge (same file bytes, same launchctl sets).
import { existsSync } from "node:fs";
import { tryLoadStack } from "../hooks/lib/stack-config.ts";
import {
	type AppName,
	assertNoSecrets,
	CONNECTIONS_PATH,
	type ConnectionsConfig,
	enabledAppsOf,
	facePairs,
	loadConnections,
	resolveEndpoint,
	writeDefaultConfig,
} from "./lib/connections.ts";
import type { StepContext, StepResult } from "./install-run.ts";

/** The exact ask the install chain surfaces for this step. */
export const GUI_PROXY_ASK =
	"Proxy desktop GUIs (VS Code, ChatGPT, Claude) through the hub? [Y/n]";

/** launchctl apply runner — injectable so tests never touch the host. */
export type LaunchctlRun = (
	pairs: { key: string; value: string }[],
) => Promise<void>;

/** hub-resolution face — injectable for the same reason (the real chain
 *  probes dns-sd/mdns for seconds on a miss). */
export type EndpointResolve = (
	label: string,
) => Promise<{ url: string; via: string } | null>;

const realLaunchctlRun: LaunchctlRun = async (pairs) => {
	const { execa } = await import("execa");
	for (const p of pairs)
		await execa("launchctl", ["setenv", p.key, p.value], { reject: false });
};

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

/** Apply the launchctl face for the enabled apps against the resolved
 *  default hub. Returns the human note; never throws on an unresolved hub —
 *  that degrades the note (the file write is the durable part). */
async function applyLaunchctlFace(
	cfg: ConnectionsConfig,
	run: LaunchctlRun,
	resolve: EndpointResolve,
): Promise<string> {
	const apps: AppName[] = enabledAppsOf(cfg);
	if (apps.length === 0) return "launchctl face skipped (no enabled apps)";
	const ep = await resolve(cfg.default);
	if (!ep)
		return `launchctl face skipped (default hub '${cfg.default}' unresolved — check the hubs registry or stack.yaml)`;
	const pairs = facePairs(apps, ep.url);
	assertNoSecrets(pairs.map((p) => `${p.key}=${p.value}`).join("\n"));
	await run(pairs);
	const keys = pairs.map((p) => p.key).join(", ");
	return `launchctl setenv applied (${ep.via}): ${keys} — undo: launchctl unsetenv <key>`;
}

/** The wireConnections step: ask, write-once, apply the launchctl face.
 *  `resolve` is injectable (tests stub hub resolution — the real chain
 *  probes dns-sd/mdns for seconds on a miss). */
export async function wireConnections(
	ctx: StepContext,
	run: LaunchctlRun = realLaunchctlRun,
	resolve: EndpointResolve = resolveEndpoint,
): Promise<StepResult> {
	const path = CONNECTIONS_PATH();
	if (existsSync(path)) {
		const load = loadConnections(path);
		if (!load.ok)
			return {
				status: "failed",
				note: `connections.json at ${path} unparseable: ${load.why}`,
			};
		const applied = await applyLaunchctlFace(load.config, run, resolve);
		return {
			status: "ok",
			note: `connections.json present (never overwritten) — ${applied}`,
		};
	}
	const hub = defaultHubLabel();
	if (!hub)
		return {
			status: "skipped",
			note: "no default hub (SUSPENDERS_DEFAULT_HUB unset, stack.yaml has no hub profiles) — name one in ~/.fleet/config/connections.json when ready",
		};
	if (!ctx.yes)
		return {
			status: "need_user_action",
			note: `${GUI_PROXY_ASK} — resume_command runs this step with --yes (writes ${path} mode 600 + the launchctl face); decline by leaving connections.json absent`,
		};
	const cfg = defaultTemplate(hub);
	assertNoSecrets(JSON.stringify(cfg));
	writeDefaultConfig(path, cfg);
	const applied = await applyLaunchctlFace(cfg, run, resolve);
	return {
		status: "ok",
		note: `${GUI_PROXY_ASK} — consented (--yes): wrote ${path} (mode 600, default hub ${hub}) and applied ${applied}`,
	};
}
