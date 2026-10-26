import { mergePostureLayers, BASE_POSTURE_SOURCE } from "./posture.merge.ts";
import {
	ResolvedPostureSchema,
	throwValidationError,
	type PostureDocument,
	type PostureLayer,
	type ResolvedEntry,
	type ResolvedPosture,
} from "./posture.zod.ts";

function hasOwn(record: object, key: string): boolean {
	return Object.hasOwn(record, key);
}

function sourceFor(sources: Record<string, string>, path: string): string {
	return hasOwn(sources, path) ? sources[path] : BASE_POSTURE_SOURCE;
}

function resolveReferences(
	document: PostureDocument,
	sources: Record<string, string>,
): ResolvedEntry[] {
	for (const [fleetName, fleetConfig] of Object.entries(document.fleets)) {
		for (const [postureName, references] of Object.entries(
			fleetConfig.postures,
		)) {
			for (const [index, reference] of references.entries()) {
				const parts = reference.split(".");
				const hubName = parts[0];
				const profileName = parts[1];
				const sourcePath = `fleets.${fleetName}.postures.${postureName}.${String(index)}`;
				const source = sourceFor(sources, sourcePath);
				if (
					parts.length !== 2 ||
					hubName === undefined ||
					profileName === undefined ||
					!hasOwn(document.hubs, hubName)
				) {
					throw new Error(
						`${source}:${sourcePath}: unknown hub profile reference '${reference}'`,
					);
				}
				const hub = document.hubs[hubName];
				if (!hasOwn(hub.profiles, profileName)) {
					throw new Error(
						`${source}:${sourcePath}: unknown hub profile reference '${reference}'`,
					);
				}
			}
		}
	}

	const selection = document.selection;
	if (!hasOwn(document.fleets, selection.fleet)) {
		throw new Error(
			`${sourceFor(sources, "selection.fleet")}:selection.fleet: unknown fleet '${selection.fleet}'`,
		);
	}
	const fleet = document.fleets[selection.fleet];
	if (!hasOwn(fleet.postures, selection.posture)) {
		throw new Error(
			`${sourceFor(sources, "selection.posture")}:selection.posture: unknown posture '${selection.posture}' in fleet '${selection.fleet}'`,
		);
	}

	const seenReferences = new Set<string>();
	const entrySources = new Map<
		string,
		{
			entry: ResolvedEntry;
			profiles: Array<{ reference: string; source: string }>;
		}
	>();
	for (const reference of fleet.postures[selection.posture]) {
		if (seenReferences.has(reference)) continue;
		seenReferences.add(reference);

		const parts = reference.split(".");
		const hubName = parts[0];
		const profileName = parts[1];
		if (hubName === undefined || profileName === undefined) continue;
		const hub = document.hubs[hubName];
		const profile = hub.profiles[profileName];

		for (const [model, rule] of Object.entries(profile.models)) {
			const key = `${hubName}\u0000${model}`;
			const modelPath = `hubs.${hubName}.profiles.${profileName}.models.${model}`;
			const currentSource = [
				sourceFor(sources, `${modelPath}.policy`),
				sourceFor(sources, `${modelPath}.lanes`),
			]
				.filter((source, index, items) => items.indexOf(source) === index)
				.join(", ");
			const existing = entrySources.get(key);
			if (existing === undefined) {
				entrySources.set(key, {
					entry: {
						hub: hubName,
						model,
						policy: rule.policy,
						lanes: rule.lanes,
					},
					profiles: [{ reference, source: currentSource }],
				});
				continue;
			}
			if (
				existing.entry.policy !== rule.policy ||
				existing.entry.lanes !== rule.lanes
			) {
				const previous = existing.profiles
					.map(
						(profileSource) =>
							`${profileSource.reference} from ${profileSource.source}`,
					)
					.join(", ");
				throw new Error(
					`${sourceFor(sources, `${modelPath}.policy`)}:${modelPath}: conflicting rules for ${hubName}.${model}; ${previous} and ${reference} from ${currentSource}`,
				);
			}
			existing.profiles.push({ reference, source: currentSource });
		}
	}

	return [...entrySources.values()].map(({ entry }) => entry);
}

export function resolvePosture(
	base: PostureDocument,
	layers: PostureLayer[],
): ResolvedPosture {
	const { document, sources } = mergePostureLayers(base, layers);
	const entries = resolveReferences(document, sources);
	const result = ResolvedPostureSchema.safeParse({
		selection: document.selection,
		entries,
		sources,
	});
	if (!result.success)
		throwValidationError(BASE_POSTURE_SOURCE, result.error.issues);
	return result.data;
}
