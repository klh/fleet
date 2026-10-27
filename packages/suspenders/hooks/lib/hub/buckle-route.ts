// hooks/lib/hub/buckle-route.ts — W1265: the Buckle route-configuration adapter
// ATOP the W298 catalog (hooks/lib/targets.ts over the vendored vercel-labs/
// skills registry). NOT a second scanner: detection stays the catalog's;
// this module maps catalog AgentTypes to the native config face each tool
// reads its Buckle base URL from, plans + writes route config, and renders
// the tool|config|base|wire|provider|model|disable table. No scanner here —
// detection is detectFleetTargets()/capabilityCatalog().
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AgentType } from "../vendor/skills-agents.ts";

/** Wire family a route face speaks (buckle's Dialect union, restated here —
 *  the installed suspenders prefix must not import across packages). */
export type RouteWire = "anthropic" | "openai";

/** How the installer can configure this tool's Buckle base:
 *  - settings-json: JSON file, env.<KEY> merge (Claude Code settings.json)
 *  - codex-toml:    user-level config.toml [model_providers.buckle] splice
 *                   (project-level .codex/config.toml CANNOT set the
 *                   provider — owner-verified 2026-10-24, #67958)
 *  - manual:        documented config face, no automated write (path shown)
 *  - none:          no route face — the row stays gated, like hook wiring. */
export type RouteFace = "settings-json" | "codex-toml" | "manual" | "none";

/** One catalog target's Buckle route face. Distinct axis: a tool can be
 *  detected + hook-wired yet have no route face, and vice versa. */
export interface BuckleRouteFace {
	face: RouteFace;
	/** Config file path relative to $HOME. */
	configPath: string;
	/** The key/section this face writes (table + disable action). */
	target: string;
	/** The wire the face speaks; openai faces end their base at /v1. */
	wire: RouteWire;
	/** Post-write verification command shape (xh probe the base). */
	verify: string;
}

/** Provider pin accepted by the W1265 named ingress (buckle's list,
 *  restated here — the installed suspenders prefix stays package-local). */
export type IngressProvider = "zai";

/** Group a provider pin resolves to. Z.ai Coding Plan serves the glm
 *  family; nothing else is pinned today. */
const PROVIDER_MODEL: Record<IngressProvider, string> = { zai: "glm-5.3" };

/** Per-tool route faces over the W298 catalog keys. Tools absent from this
 *  map get no route write — the row stays gated, exactly like unwired hook
 *  targets. VS Code has NO vendor-registry key, so no row exists here; its
 *  chatLanguageModels.json face is documented in docs/fleet-install.md. */
export const BUCKLE_ROUTES: Partial<Record<AgentType, BuckleRouteFace>> = {
	"claude-code": {
		face: "settings-json",
		configPath: ".claude/settings.json",
		target: "env.ANTHROPIC_BASE_URL",
		wire: "anthropic",
		verify: "xh POST <base>/v1/messages model=<model>",
	},
	codex: {
		face: "codex-toml",
		configPath: ".codex/config.toml",
		target: 'model_providers.buckle + model_provider = "buckle"',
		wire: "openai",
		verify: "xh POST <base>/responses model=<model>",
	},
	grok: {
		face: "manual",
		configPath: ".grok/config.toml",
		target: "[model.*] base_url + api_backend",
		wire: "openai",
		verify: "xh POST <base>/chat/completions model=<model>",
	},
};

export interface BuckleRoutePlan {
	agent: AgentType;
	face: BuckleRouteFace;
	/** The exact base URL the tool config gets. */
	base: string;
	/** Pin carried into the plan, for the table's provider column. */
	provider: IngressProvider | null;
	/** Group the pin resolves to, when one is pinned. */
	model: string | null;
	/** $HOME the write targets (homedir() unless overridden — tests pin it). */
	home: string;
	/** How to undo the write (table's disable column). */
	disable: string;
}

/** Compose the tool-facing base: <front>[/w/<lane>][/<provider>]/<wire>.
 *  Codex faces end their base at /v1 (the client appends /responses or
 *  /chat/completions); Claude Code appends /v1/messages itself. */
export function buckleBaseURL(
	front: string,
	wire: RouteWire,
	opts: { lane?: string; provider?: IngressProvider; endsInV1?: boolean } = {},
): string {
	const segs = [front.replace(/\/+$/, "")];
	if (opts.lane !== undefined && opts.lane !== "") segs.push("w", opts.lane);
	if (opts.provider !== undefined) segs.push(opts.provider);
	segs.push(wire);
	return `${segs.join("/")}${opts.endsInV1 === true ? "/v1" : ""}`;
}

function disableAction(face: BuckleRouteFace): string {
	if (face.face === "settings-json") return `remove ${face.target}`;
	if (face.face === "codex-toml")
		return "remove [model_providers.buckle] + model_provider";
	return `hand-revert ${face.configPath} ${face.target}`;
}

/** Plan the route writes for detected catalog agents. Skips agents with no
 *  route face (gated rows stay invisible here; the install table covers
 *  detection separately). */
export function planBuckleRoutes(opts: {
	agents: AgentType[];
	front: string;
	lane?: string;
	provider?: IngressProvider;
	home?: string;
}): BuckleRoutePlan[] {
	const home = opts.home ?? homedir();
	return opts.agents.flatMap((agent) => {
		const face = BUCKLE_ROUTES[agent];
		if (face === undefined) return [];
		const base = buckleBaseURL(opts.front, face.wire, {
			lane: opts.lane,
			provider: opts.provider,
			endsInV1: face.face === "codex-toml",
		});
		return [
			{
				agent,
				face,
				base,
				provider: opts.provider ?? null,
				model:
					opts.provider === undefined ? null : PROVIDER_MODEL[opts.provider],
				home,
				disable: disableAction(face),
			},
		];
	});
}

const pad = (s: string, n: number): string =>
	s.length >= n ? s : s + " ".repeat(n - s.length);

/** The owner-mandated visibility table: tool|config file|base URL|wire|
 *  provider|model|disable action. */
export function renderBuckleRouteTable(plans: BuckleRoutePlan[]): string {
	const head = [
		"TOOL",
		"CONFIG FILE",
		"BASE URL",
		"WIRE",
		"PROVIDER",
		"MODEL",
		"DISABLE ACTION",
	];
	const rows = plans.map((p) => [
		p.agent,
		join(p.home, p.face.configPath),
		p.base,
		p.face.wire,
		p.provider ?? "any",
		p.model ?? "-",
		p.disable,
	]);
	const widths = head.map((h, i) =>
		Math.max(h.length, ...rows.map((r) => r[i].length)),
	);
	const line = (cells: string[]): string =>
		cells
			.map((c, i) => pad(c, widths[i]))
			.join("  ")
			.trimEnd();
	return [line(head), ...rows.map(line)].join("\n");
}

export type BuckleRouteWrite =
	| { ok: true; path: string; plan: BuckleRoutePlan }
	| { ok: false; path: string; why: string };

const CLAUDE_ENV_KEY = "ANTHROPIC_BASE_URL";
const CODEX_SECTION = "[model_providers.buckle]";

function readOrFresh(path: string): { text: string; fresh: boolean } | null {
	try {
		return { text: readFileSync(path, "utf8"), fresh: false };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT")
			return { text: "", fresh: true };
		return null;
	}
}

/** settings-json face: merge env.ANTHROPIC_BASE_URL into Claude Code's
 *  settings.json. Unparseable existing config refuses (fail closed) — never
 *  overwrite user JSON we could not read. Auth stays out of scope: the token
 *  is a minted buckle key, never written by this module. */
function applySettingsJson(
	path: string,
	plan: BuckleRoutePlan,
): BuckleRouteWrite {
	const cur = readOrFresh(path);
	if (cur === null)
		return {
			ok: false,
			path,
			why: `${path} is not readable JSON — fix by hand first`,
		};
	let doc: { env?: Record<string, unknown> } = {};
	if (!cur.fresh) {
		try {
			doc = JSON.parse(cur.text) as typeof doc;
		} catch {
			return {
				ok: false,
				path,
				why: `unparseable JSON in ${path} — fix by hand first`,
			};
		}
	}
	if (
		doc.env !== undefined &&
		(typeof doc.env !== "object" || doc.env === null || Array.isArray(doc.env))
	)
		return { ok: false, path, why: `env in ${path} is not an object` };
	const env = { ...(doc.env ?? {}), [CLAUDE_ENV_KEY]: plan.base };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ ...doc, env }, null, "\t")}\n`);
	return { ok: true, path, plan };
}

/** codex-toml face: splice [model_providers.buckle] (base_url ends /v1,
 *  wire_api = "responses") into the USER-LEVEL config.toml — project-level
 *  .codex/config.toml cannot set the provider (owner-verified #67958). A
 *  conflicting top-level model_provider refuses instead of being stomped. */
function applyCodexToml(path: string, plan: BuckleRoutePlan): BuckleRouteWrite {
	const cur = readOrFresh(path);
	if (cur === null)
		return {
			ok: false,
			path,
			why: `${path} is not readable — fix by hand first`,
		};
	let text = cur.text;
	const block = [
		CODEX_SECTION,
		'name = "Buckle gateway"',
		`base_url = "${plan.base}"`,
		'wire_api = "responses"',
		"requires_openai_auth = false",
		"",
		"",
	].join("\n");
	const start = text.indexOf(CODEX_SECTION);
	if (start >= 0) {
		const next = text.indexOf("\n[", start + 1);
		const end = next === -1 ? text.length : next + 1;
		text = text.slice(0, start) + block + text.slice(end);
	} else {
		text =
			text === "" || text.endsWith("\n") ? text + block : `${text}\n${block}`;
	}
	if (/^model_provider\s*=/m.test(text)) {
		const current = /^model_provider\s*=\s*"([^"]*)"/m.exec(text)?.[1];
		if (current !== "buckle")
			return {
				ok: false,
				path,
				why: `model_provider already "${current ?? "set"}" in ${path} — switch by hand if intended`,
			};
	} else {
		const line = 'model_provider = "buckle"\n';
		const firstSection = text.search(/^\[/m);
		text =
			firstSection === -1
				? text + line
				: text.slice(0, firstSection) + line + text.slice(firstSection);
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
	return { ok: true, path, plan };
}

/** Write one plan's route config. manual/none faces never write — they
 *  report the hand path (the table's disable column covers the undo). */
export function applyBuckleRoute(plan: BuckleRoutePlan): BuckleRouteWrite {
	const path = join(plan.home, plan.face.configPath);
	if (plan.face.face === "settings-json") return applySettingsJson(path, plan);
	if (plan.face.face === "codex-toml") return applyCodexToml(path, plan);
	return {
		ok: false,
		path,
		why:
			plan.face.face === "manual"
				? `manual face — configure ${path} by hand (${plan.face.target})`
				: `no route face for ${plan.agent}`,
	};
}
