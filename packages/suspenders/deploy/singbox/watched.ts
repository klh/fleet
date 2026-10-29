// deploy/singbox/watched.ts — W1260.1: the GUI TRANSPORT signatures and the
// Buckle CONNECT identity contract for the sing-box TUN kit.
//
// BOUNDARY (owner 2026-10-24, finding.vercel-skills-detection-install-
// boundary-20261024): cross-TOOL detection and installation ride the ONE
// fleet-install catalog — hooks/lib/vendor/skills-agents.ts +
// hooks/lib/targets.ts (detectFleetTargets / capabilityCatalog). This file
// deliberately carries NO tool-install detection and NO CLI paths: CLIs are
// steered at the request layer by explicit Buckle named routes (their tool
// config), never invented here. Only opaque GUI transports — which ignore
// tool config — get TUN watch rules.
//
// TRANSPORT law (owner #67813/#67819 + W1260.2): private/LAN bypass FIRST,
// then GUI rules that qualify process AND destination — a watched app's
// non-AI traffic (auth/update/local) stays direct; only AI destinations
// ride the CONNECT gate, which stays the fail-closed allowlist (403 on
// anything unallowlisted). TLS stays opaque end-to-end: CONNECT relays,
// never MITMs; buckle sees app identity + byte counts, not plaintext.
import { existsSync } from "node:fs";

/** The CONNECT username vocabulary — W1260.2's authenticated egress contract.
 *  `buckle` = the unknown-process bucket (W1260.2 maps it to app=unknown);
 *  tool identities ride the fleet-install catalog, this is only the wire
 *  vocabulary the egress accepts. */
export type ConnectUser = "claude" | "chatgpt" | "vscode" | "codex" | "buckle";

export const CONNECT_USERS: readonly ConnectUser[] = [
	"claude",
	"chatgpt",
	"vscode",
	"codex",
	"buckle",
];

/** The unknown-process bucket: AI destinations reached by processes with no
 *  GUI signature (CLIs, helpers, anything else). */
export const CONNECT_UNKNOWN_USER = "buckle" as const;

/** The outbound tag prefix — every buckle egress outbound starts with it. */
export const CONNECT_PREFIX = "buckle-connect-";

/** The default CONNECT egress port — the fleet-agreed constant (W1260.2:
 *  BUCKLE_CONNECT_PORT; 4100 litellm / 4101 buckle gateway / 4102 retired). */
export const CONNECT_PORT_DEFAULT = 4103;

/** The CONNECT egress binds loopback only — the outbound server law. */
export const CONNECT_SERVER = "127.0.0.1"; // scrub:allow — loopback pin

/** The AI destination set (domain_suffix, subdomains included) — the ONE
 *  list the template rules, the fleet law, and the verifier share. */
export const AI_DESTINATION_SUFFIXES: readonly string[] = [
	"anthropic.com",
	"claude.ai",
	"openai.com",
	"chatgpt.com",
];

/** The outbound tag for a CONNECT user. */
export const connectTagOf = (user: string): string =>
	`${CONNECT_PREFIX}${user}`;

/** One opaque GUI transport: the sing-box process_path_regex that pins its
 *  AI traffic plus the app-bundle path presence probing uses. Presence is
 *  TRANSPORT OBSERVATION ONLY — it never selects tools for installation
 *  (the fleet-install catalog owns that). */
export interface GuiTransport {
	/** The CONNECT username this transport's AI traffic authenticates as. */
	user: Exclude<ConnectUser, "buckle">;
	label: string;
	/** Go regexp flavor (sing-box), (?i); matches the bundle's binaries and
	 *  helpers (Electron helpers live under the .app dir). */
	regex: string;
	/** The app bundle whose presence means this transport may run. */
	bundle: string;
	/** Representative binary paths the regex MUST match (law + tests). */
	probes: string[];
}

const GUI_TABLE: readonly GuiTransport[] = [
	{
		user: "claude",
		label: "Claude desktop",
		regex: "(?i)/Claude\\.app/",
		probes: [
			"/Applications/Claude.app/Contents/MacOS/Claude",
			"/Applications/Claude.app/Contents/MacOS/Claude Helper",
		],
		bundle: "/Applications/Claude.app",
	},
	{
		user: "chatgpt",
		label: "ChatGPT desktop",
		regex: "(?i)/ChatGPT\\.app/",
		probes: ["/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
		bundle: "/Applications/ChatGPT.app",
	},
	{
		user: "vscode",
		label: "VS Code",
		regex: "(?i)(/Visual Studio Code\\.app/|/Code Helper)",
		probes: [
			"/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
			"/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper",
		],
		bundle: "/Applications/Visual Studio Code.app",
	},
];

/** The one GUI transport table (template rule order). */
export const guiTransports = (): readonly GuiTransport[] => GUI_TABLE;

/** Compile one transport's regex (null when it does not compile — a law
 *  problem, reported by the fleet law, never silently skipped). */
export const compileRegexOf = (user: string): RegExp | null => {
	const row = GUI_TABLE.find((a) => a.user === user);
	if (row === undefined) return null;
	return goRegexOf(row.regex);
};

/** Compile a sing-box Go regexp for JS law checks — the (?i) inline flag
 *  maps to the JS `i` flag; the rest is PCRE-compatible. */
export const goRegexOf = (pattern: string): RegExp | null => {
	const m = /^\(\?i\)(.*)$/s.exec(pattern);
	return m === null ? safeNewRegex(pattern) : safeNewRegex(m[1], "i");
};

const safeNewRegex = (src: string, flags = ""): RegExp | null => {
	try {
		return new RegExp(src, flags);
	} catch {
		return null;
	}
};

/** One presence row (transport observation, never install selection). */
export interface TransportRow {
	user: string;
	label: string;
	present: boolean;
}

/** GUI transport presence over the real machine — transport observation,
 *  NOT install detection (injectable exists() keeps tests off the host). */
export function transportPresence(
	exists: (path: string) => boolean = (p) => existsSync(p),
): TransportRow[] {
	return GUI_TABLE.map((a) => ({
		user: a.user,
		label: a.label,
		present: exists(a.bundle),
	}));
}

/** The bundle path of one transport (for status output). */
export const bundleOf = (user: string): string | null =>
	GUI_TABLE.find((a) => a.user === user)?.bundle ?? null;
