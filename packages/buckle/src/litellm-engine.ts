/** W3081: the engine mapping — buckle is a FRONT for litellm (owner law
 *  2026-11-13: a hub is buckle + litellm + a GUI; anything else is a
 *  defect). This module owns the ONE mapping in the fleet: how a buckle
 *  upstream ladder projects onto a litellm engine.
 *
 *  One walk produces both artifacts (single source — the catalog and the
 *  rewritten legs can never drift):
 *    - the engine catalog (litellm.yaml model_list) for every provider row
 *    - the buckle-side ladder in which every provider row rides the local
 *      engine leg (http://127.0.0.1:<port>), never the provider directly.
 *
 *  Buckle owns this because the ladder shape IS buckle domain knowledge;
 *  hubctl (suspenders) only materializes files. Inputs are plain data —
 *  this module imports nothing from suspenders. */

/** The engine's loopback leg — compose runs it host-networked. */
export const ENGINE_LOOPBACK = "127.0.0.1";
/** Compose defaults (hub-compose.yaml litellm-hub / litellm-health). */
export const ENGINE_DEFAULT_PORT = 4100;
export const ENGINE_DEFAULT_HEALTH_PORT = 4105;
/** The engine master key env — upstream.env carries it (stack secrets). */
export const ENGINE_KEY_ENV = "LITELLM_KEY";
/** The GitHub Copilot seat: litellm 1.103.0 native provider. Identified
 *  by HOST or by the provider annotation the projection stamps — a
 *  fixture/profile endpoint is still the seat (keying on host alone
 *  breaks every test profile). */
export const COPILOT_HOST = "api.githubcopilot.com";
const COPILOT_PROVIDER = "github-copilot";

function isCopilotRow(row: Record<string, unknown>): boolean {
	return (
		rowHost(row.url) === COPILOT_HOST ||
		row.provider === COPILOT_PROVIDER ||
		row.providerProfile === COPILOT_PROVIDER
	);
}

/** Ladder groups in buckle's upstreams.json shape (plain records —
 *  structural, so neither package's config types leak across). */
export type EngineGroups = Record<string, Record<string, unknown>[]>;

export interface EngineMaterialization {
	/** The buckle ladder: provider rows replaced by engine legs. */
	groups: EngineGroups;
	/** The engine catalog (litellm.yaml) rendered from the same walk. */
	catalog: string;
	/** True when the walk emitted github_copilot rows (token cache needed). */
	copilot: boolean;
}

const LOOPBACK_HOSTS = new Set([
	"localhost",
	"127.0.0.1",
	"::1",
	"[::1]",
	"0.0.0.0",
]);

function rowHost(url: unknown): string | null {
	if (typeof url !== "string" || !url) return null;
	try {
		return new URL(url).hostname;
	} catch {
		throw new Error(`upstream row carries an unparseable url: ${url}`);
	}
}

/** A row is engine-bound when it points at a real provider out there
 *  (https, non-loopback). Loopback rows (peer buckles, local swarm legs)
 *  stay direct — the engine is not in that path. */
export function isProviderRow(row: Record<string, unknown>): boolean {
	if (typeof row.url !== "string") return false;
	try {
		const u = new URL(row.url);
		return u.protocol === "https:" && !LOOPBACK_HOSTS.has(u.hostname);
	} catch {
		return false;
	}
}

function catalogRow(row: Record<string, unknown>): string {
	const model = typeof row.model === "string" ? row.model : "";
	if (!model) throw new Error("provider row without a model id");
	if (isCopilotRow(row)) {
		// litellm's native github_copilot provider: the seeded token cache
		// authenticates (device flow is fallback-only); both wires work —
		// the /chat/completions endpoint 400s responses-only models
		// (gpt-6-astra class); the engine translates.
		return (
			`  - model_name: ${model}\n` +
			`    litellm_params:\n` +
			`      model: github_copilot/${model}\n` +
			`    model_info:\n` +
			`      disable_background_health_check: true`
		);
	}
	// Generic provider: openai-wire passthrough. Secrets NEVER live in the
	// catalog — os.environ/<ENV> indirection rides upstream.env.
	const dialect = row.dialect;
	if (dialect !== undefined && dialect !== "openai")
		throw new Error(
			`engine fronts openai-wire providers; ${rowHost(row.url)} row for ${model} is ${String(dialect)} — map it through a native provider or fix the row`,
		);
	const env = row.api_key_env;
	if (typeof env !== "string" || !env)
		throw new Error(
			`provider row for ${model} (${rowHost(row.url)}) has no api_key_env — the engine cannot authenticate it`,
		);
	return (
		`  - model_name: ${model}\n` +
		`    litellm_params:\n` +
		`      model: openai/${model}\n` +
		`      api_base: ${row.url}\n` +
		`      api_key: os.environ/${env}\n` +
		`    model_info:\n` +
		`      disable_background_health_check: true`
	);
}

function engineLeg(
	row: Record<string, unknown>,
	port: number,
): Record<string, unknown> {
	const model = typeof row.model === "string" ? row.model : "";
	// Preserve the projected row's metadata (capabilities, attribution,
	// connection limits ride untouched); override ONLY the hop fields —
	// the leg speaks the engine's openai wire, not the provider's.
	const leg: Record<string, unknown> = {
		...row,
		url: `http://${ENGINE_LOOPBACK}:${port}`,
		model,
		dialect: "openai",
		adapter: "openai-compat",
		api_key_env: ENGINE_KEY_ENV,
		buckle: false,
	};
	delete leg.adapter_config;
	delete leg.path_rewrite;
	return leg;
}

/** Copilot model ids carried by a ladder (catalog fallback source for the
 *  Mac engine when no hand-made copilot-models.json exists). */
export function copilotModelsFromGroups(groups: EngineGroups): string[] {
	const out = new Set<string>();
	for (const rows of Object.values(groups))
		for (const row of rows)
			if (isCopilotRow(row) && typeof row.model === "string")
				out.add(row.model);
	return [...out].sort();
}

/** One walk: rewrite provider rows onto the engine leg AND render the
 *  engine catalog from the same rows. Pure — same input, same output. */
export function materializeEngineGroups(
	groups: EngineGroups,
	port: number = ENGINE_DEFAULT_PORT,
): EngineMaterialization {
	const catalogRows: string[] = [];
	let copilot = false;
	const rewritten: EngineGroups = {};
	for (const [group, rows] of Object.entries(groups)) {
		const legs: Record<string, unknown>[] = [];
		for (const row of rows) {
			if (!isProviderRow(row)) {
				legs.push(row);
				continue;
			}
			// A provider row with no bound key was never rideable — drop it
			// from BOTH artifacts (discovery observes models opportunistically;
			// a keyless connection is not deployable, and the projection's
			// catalog_status already marks the profile unavailable).
			if (typeof row.api_key_env !== "string" || !row.api_key_env) continue;
			if (isCopilotRow(row)) copilot = true;
			catalogRows.push(catalogRow(row));
			legs.push(engineLeg(row, port));
		}
		rewritten[group] = legs;
	}
	const catalog =
		`model_list:\n${catalogRows.join("\n")}\n\n` +
		`litellm_settings:\n  drop_params: true # tolerate Anthropic-only params the direct wire 400s\n\n` +
		`general_settings:\n  master_key: os.environ/${ENGINE_KEY_ENV}\n`;
	return { groups: rewritten, catalog, copilot };
}
