// belt-models.ts — the belt-provider leaf runtime composition, ONE place:
// the desktop runtime, the live acceptance path, and the W2971.3 bench arm
// all ride this (third duplicate decomposed instead of added). The leaf
// owns model transport per-run (root #118378): the provider's credential
// resolve returns a PLACEHOLDER that the leaf's transformHeaders overrides
// with the run's leaf-minted key — never an ambient key.
import { createModels, createProvider } from "@earendil-works/pi-ai";
import {
	stream,
	streamSimple,
} from "@earendil-works/pi-ai/api/openai-completions";
import {
	createRegistry,
	type HarnessOptions,
} from "@earendil-works/pi-durable";

/** The pi-durable runtime shape the durable job rides (wiring.ts mirror). */
export type BeltLeafRuntime = Pick<
	HarnessOptions,
	"models" | "registry" | "env" | "settings" | "onReport"
>;

const CONTEXT_WINDOW = 32_768;
const MAX_TOKENS = 2_048;

/** Belt-provider Models facade over one base URL (the /v1 join happens
 *  here — callers pass the bare buckle/belt origin). Every model speaks
 *  the openai-completions wire; costs are zeroed because spend truth
 *  lives at the buckle gate, not in the leaf. */
export const beltModelsOf = (
	baseUrl: string,
	modelIds: readonly string[],
): ReturnType<typeof createModels> => {
	const base = new URL("/v1", baseUrl).href;
	const models = createModels();
	models.setProvider(
		createProvider({
			id: "belt",
			baseUrl: base,
			auth: {
				apiKey: {
					name: "belt",
					resolve: async () => ({
						auth: { apiKey: "runner-leaf-credential-required" },
						source: "runner",
					}),
				},
			},
			models: modelIds.map((id) => ({
				id,
				name: id,
				api: "openai-completions",
				provider: "belt",
				baseUrl: base,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				reasoning: false,
				contextWindow: CONTEXT_WINDOW,
				maxTokens: MAX_TOKENS,
			})),
			api: { "openai-completions": { stream, streamSimple } },
		}),
	);
	return models;
};

/** The full leaf runtime for one belt base + model set: models + a fresh
 *  pi-durable registry; env/settings/onReport stay host-owned no-ops
 *  exactly as the desktop runtime composes them (env is an env-BUILDER
 *  function in HarnessOptions — absent, never an object). */
export const beltLeafRuntime = (
	baseUrl: string,
	modelIds: readonly string[],
): BeltLeafRuntime => ({
	models: beltModelsOf(baseUrl, modelIds),
	registry: createRegistry(),
	settings: undefined,
	onReport() {},
});
