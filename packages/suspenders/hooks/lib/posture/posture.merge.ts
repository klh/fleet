import {
	assertSafePostureKeys,
	PostureDocumentSchema,
	PostureLayerSchema,
	PostureOverlaySchema,
	throwValidationError,
	type PostureDocument,
	type PostureLayer,
	type PostureOverlay,
	type PostureRule,
} from "./posture.zod.ts";

export const BASE_POSTURE_SOURCE = "base";

type SourceMap = Map<string, string>;

function hasOwn(record: object, key: string): boolean {
	return Object.hasOwn(record, key);
}

function setSourcesForDocument(
	document: PostureDocument,
	source: string,
	sources: SourceMap,
): void {
	sources.set("version", source);
	for (const [hub, hubConfig] of Object.entries(document.hubs)) {
		sources.set(`hubs.${hub}`, source);
		for (const [profile, profileConfig] of Object.entries(hubConfig.profiles)) {
			sources.set(`hubs.${hub}.profiles.${profile}`, source);
			for (const [model] of Object.entries(profileConfig.models)) {
				const prefix = `hubs.${hub}.profiles.${profile}.models.${model}`;
				sources.set(prefix, source);
				sources.set(`${prefix}.policy`, source);
				sources.set(`${prefix}.lanes`, source);
			}
		}
	}
	for (const [fleet, fleetConfig] of Object.entries(document.fleets)) {
		sources.set(`fleets.${fleet}`, source);
		for (const [posture, references] of Object.entries(fleetConfig.postures)) {
			sources.set(`fleets.${fleet}.postures.${posture}`, source);
			for (const [index] of references.entries()) {
				sources.set(
					`fleets.${fleet}.postures.${posture}.${String(index)}`,
					source,
				);
			}
		}
	}
	sources.set("selection.fleet", source);
	sources.set("selection.posture", source);
	sources.set("selection.developmentOverride", source);
}

function markOverlaySources(
	overlay: PostureOverlay,
	source: string,
	sources: SourceMap,
): void {
	if (overlay.version !== undefined) sources.set("version", source);
	for (const [hub, hubOverlay] of Object.entries(overlay.hubs ?? {})) {
		sources.set(`hubs.${hub}`, source);
		for (const [profile, profileOverlay] of Object.entries(
			hubOverlay.profiles ?? {},
		)) {
			sources.set(`hubs.${hub}.profiles.${profile}`, source);
			for (const [model, rule] of Object.entries(profileOverlay.models ?? {})) {
				const prefix = `hubs.${hub}.profiles.${profile}.models.${model}`;
				sources.set(prefix, source);
				if (rule.policy !== undefined) sources.set(`${prefix}.policy`, source);
				if (rule.lanes !== undefined) sources.set(`${prefix}.lanes`, source);
			}
		}
	}
	for (const [fleet, fleetOverlay] of Object.entries(overlay.fleets ?? {})) {
		for (const [posture, references] of Object.entries(
			fleetOverlay.postures ?? {},
		)) {
			sources.set(`fleets.${fleet}.postures.${posture}`, source);
			for (const [index] of references.entries()) {
				sources.set(
					`fleets.${fleet}.postures.${posture}.${String(index)}`,
					source,
				);
			}
		}
	}
	if (overlay.selection?.fleet !== undefined)
		sources.set("selection.fleet", source);
	if (overlay.selection?.posture !== undefined)
		sources.set("selection.posture", source);
	if (overlay.selection?.developmentOverride !== undefined)
		sources.set("selection.developmentOverride", source);
}

function mergedRule(
	current: { policy?: PostureRule["policy"]; lanes?: PostureRule["lanes"] },
	overlay: { policy?: PostureRule["policy"]; lanes?: PostureRule["lanes"] },
): { policy?: PostureRule["policy"]; lanes?: PostureRule["lanes"] } {
	const result: {
		policy?: PostureRule["policy"];
		lanes?: PostureRule["lanes"];
	} = {};
	const policy = overlay.policy ?? current.policy;
	const lanes = overlay.lanes ?? current.lanes;
	if (policy !== undefined) result.policy = policy;
	if (lanes !== undefined) result.lanes = lanes;
	return result;
}

function mergeOverlayLayers(
	current: PostureOverlay,
	next: PostureOverlay,
): unknown {
	const hubs = new Map<string, unknown>(Object.entries(current.hubs ?? {}));
	for (const [hub, hubOverlay] of Object.entries(next.hubs ?? {})) {
		const currentHub =
			current.hubs !== undefined && hasOwn(current.hubs, hub)
				? current.hubs[hub]
				: undefined;
		const profiles = new Map<string, unknown>(
			Object.entries(currentHub?.profiles ?? {}),
		);
		for (const [profile, profileOverlay] of Object.entries(
			hubOverlay.profiles ?? {},
		)) {
			const currentProfile =
				currentHub?.profiles !== undefined &&
				hasOwn(currentHub.profiles, profile)
					? currentHub.profiles[profile]
					: undefined;
			const models = new Map<string, unknown>(
				Object.entries(currentProfile?.models ?? {}),
			);
			for (const [model, ruleOverlay] of Object.entries(
				profileOverlay.models ?? {},
			)) {
				const currentRule =
					currentProfile?.models !== undefined &&
					hasOwn(currentProfile.models, model)
						? currentProfile.models[model]
						: {};
				models.set(model, mergedRule(currentRule, ruleOverlay));
			}
			profiles.set(profile, {
				models: Object.fromEntries(models),
			});
		}
		hubs.set(hub, { profiles: Object.fromEntries(profiles) });
	}

	const fleets = new Map<string, unknown>(Object.entries(current.fleets ?? {}));
	for (const [fleet, fleetOverlay] of Object.entries(next.fleets ?? {})) {
		const currentFleet =
			current.fleets !== undefined && hasOwn(current.fleets, fleet)
				? current.fleets[fleet]
				: undefined;
		const postures = new Map<string, unknown>(
			Object.entries(currentFleet?.postures ?? {}),
		);
		for (const [posture, references] of Object.entries(
			fleetOverlay.postures ?? {},
		)) {
			postures.set(posture, references);
		}
		fleets.set(fleet, { postures: Object.fromEntries(postures) });
	}

	return {
		version: next.version ?? current.version,
		hubs: Object.fromEntries(hubs),
		fleets: Object.fromEntries(fleets),
		selection: {
			...(current.selection ?? {}),
			...(next.selection ?? {}),
		},
	};
}

function applyOverlay(
	document: PostureDocument,
	overlay: PostureOverlay,
): unknown {
	const hubs = new Map<string, unknown>(Object.entries(document.hubs));
	for (const [hub, hubOverlay] of Object.entries(overlay.hubs ?? {})) {
		const currentHub = hasOwn(document.hubs, hub)
			? document.hubs[hub]
			: undefined;
		const profiles = new Map<string, unknown>(
			Object.entries(currentHub?.profiles ?? {}),
		);
		for (const [profile, profileOverlay] of Object.entries(
			hubOverlay.profiles ?? {},
		)) {
			const currentProfile =
				currentHub !== undefined && hasOwn(currentHub.profiles, profile)
					? currentHub.profiles[profile]
					: undefined;
			const models = new Map<string, unknown>(
				Object.entries(currentProfile?.models ?? {}),
			);
			for (const [model, ruleOverlay] of Object.entries(
				profileOverlay.models ?? {},
			)) {
				const currentRule =
					currentProfile !== undefined && hasOwn(currentProfile.models, model)
						? currentProfile.models[model]
						: undefined;
				models.set(model, mergedRule(currentRule ?? {}, ruleOverlay));
			}
			profiles.set(profile, { models: Object.fromEntries(models) });
		}
		hubs.set(hub, { profiles: Object.fromEntries(profiles) });
	}

	const fleets = new Map<string, unknown>(Object.entries(document.fleets));
	for (const [fleet, fleetOverlay] of Object.entries(overlay.fleets ?? {})) {
		const currentFleet = hasOwn(document.fleets, fleet)
			? document.fleets[fleet]
			: undefined;
		const postures = new Map<string, unknown>(
			Object.entries(currentFleet?.postures ?? {}),
		);
		for (const [posture, references] of Object.entries(
			fleetOverlay.postures ?? {},
		)) {
			postures.set(posture, references);
		}
		fleets.set(fleet, { postures: Object.fromEntries(postures) });
	}

	return {
		version: overlay.version ?? document.version,
		hubs: Object.fromEntries(hubs),
		fleets: Object.fromEntries(fleets),
		selection: {
			fleet: overlay.selection?.fleet ?? document.selection.fleet,
			posture: overlay.selection?.posture ?? document.selection.posture,
			developmentOverride:
				overlay.selection?.developmentOverride ??
				document.selection.developmentOverride,
		},
	};
}

function sourceForValidationPath(
	path: readonly PropertyKey[],
	sources: SourceMap,
): string {
	for (let length = path.length; length > 0; length -= 1) {
		const candidate = path.slice(0, length).map(String).join(".");
		const source = sources.get(candidate);
		if (source !== undefined) return source;
	}
	return BASE_POSTURE_SOURCE;
}

function throwSourcedValidationError(
	issues: readonly {
		path: readonly PropertyKey[];
		message: string;
	}[],
	sources: SourceMap,
): never {
	throw new Error(
		issues
			.map((issue) => {
				const path = issue.path.map(String).join(".") || "$";
				return `${sourceForValidationPath(issue.path, sources)}:${path}: ${issue.message}`;
			})
			.join("\n"),
	);
}

export function mergePostureLayers(
	base: PostureDocument,
	layers: PostureLayer[],
): { document: PostureDocument; sources: Record<string, string> } {
	assertSafePostureKeys(base, BASE_POSTURE_SOURCE);
	const baseResult = PostureDocumentSchema.safeParse(base);
	if (!baseResult.success)
		throwValidationError(BASE_POSTURE_SOURCE, baseResult.error.issues);

	const sources: SourceMap = new Map();
	setSourcesForDocument(baseResult.data, BASE_POSTURE_SOURCE, sources);
	let combinedOverlay: PostureOverlay = {};
	for (const layerInput of layers) {
		const source =
			typeof layerInput?.source === "string" ? layerInput.source : "layer";
		assertSafePostureKeys(layerInput, source);
		const layerResult = PostureLayerSchema.safeParse(layerInput);
		if (!layerResult.success)
			throwValidationError(source, layerResult.error.issues);
		const layer = layerResult.data;
		const mergedOverlay = mergeOverlayLayers(combinedOverlay, layer.overlay);
		const mergedOverlayResult = PostureOverlaySchema.safeParse(mergedOverlay);
		if (!mergedOverlayResult.success)
			throwValidationError(layer.source, mergedOverlayResult.error.issues);
		combinedOverlay = mergedOverlayResult.data;
		markOverlaySources(layer.overlay, layer.source, sources);
	}

	const documentResult = PostureDocumentSchema.safeParse(
		applyOverlay(baseResult.data, combinedOverlay),
	);
	if (!documentResult.success)
		throwSourcedValidationError(documentResult.error.issues, sources);
	return {
		document: documentResult.data,
		sources: Object.fromEntries(sources),
	};
}
