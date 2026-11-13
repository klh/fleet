import { z } from "zod";
import type { UpstreamGroup } from "../bin/console-html.ts";

const GatewayProbeSchema = z.enum(["up", "down", "unknown"]);
export const GatewaySetupSchema = z
	.object({
		state: z.enum([
			"unconfigured",
			"configured-unavailable",
			"ready",
			"unknown",
		]),
		gateway: GatewayProbeSchema,
		connections: z.number().int().nonnegative().nullable(),
		models: z.number().int().nonnegative().nullable(),
		defaultsOnly: z.boolean(),
		checkedAt: z.iso.datetime().optional(),
	})
	.strict();
export type GatewaySetup = z.infer<typeof GatewaySetupSchema>;

/** Configuration/catalog evidence, never inference or caller authorization. */
export function gatewaySetup(
	groups: UpstreamGroup[] | null,
	gateway: z.infer<typeof GatewayProbeSchema>,
	models: number | null,
	connections: number | null,
): GatewaySetup {
	const defaultsOnly =
		!!groups?.length &&
		groups.every((group) => group.source === "fleet default");
	let state = "unknown";
	if (connections === 0 && !defaultsOnly) state = "unconfigured";
	else if (
		connections !== null &&
		connections > 0 &&
		!defaultsOnly &&
		gateway === "down"
	)
		state = "configured-unavailable";
	else if (connections !== null && models !== null && gateway !== "unknown") {
		if ((connections === 0 || defaultsOnly) && models === 0)
			state = "unconfigured";
		else if (gateway === "up" && connections > 0 && models > 0) state = "ready";
		else state = "configured-unavailable";
	}
	return GatewaySetupSchema.parse({
		state,
		gateway,
		connections,
		models,
		defaultsOnly,
		checkedAt: new Date().toISOString(),
	});
}

const InventorySchema = z.object({
	generatedAt: z.iso.datetime(),
	models: z
		.array(
			z.object({
				id: z.string().min(1),
				exposures: z
					.array(
						z.object({
							evidence: z.enum(["configured", "catalog", "probe"]),
							state: z.enum(["up", "down", "unknown"]),
							observedAt: z.iso.datetime().optional(),
							routeModel: z.string().optional(),
							routes: z.array(z.string()).max(1000).optional(),
						}),
					)
					.max(1000),
			}),
		)
		.max(10_000),
});

/** Headers and body share one deadline. Failed reads stay unknown. */
export async function readSetupInventory(
	read: (signal: AbortSignal) => Promise<Response | null>,
	timeoutMs = 6000,
	configuredGroups?: readonly string[],
): Promise<number | null> {
	const controller = new AbortController();
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((resolve) => {
		timer = setTimeout(() => {
			controller.abort();
			void reader?.cancel().catch(() => {});
			resolve(null);
		}, timeoutMs);
	});
	try {
		return await Promise.race([
			timeout,
			(async () => {
				const response = await read(controller.signal);
				if (!response?.ok || !response.body || controller.signal.aborted) {
					void response?.body?.cancel().catch(() => {});
					return null;
				}
				reader = response.body.getReader();
				const chunks: Uint8Array[] = [];
				let length = 0;
				for (;;) {
					const next = await reader.read();
					if (controller.signal.aborted) return null;
					if (next.done) break;
					length += next.value.length;
					if (length > 1_048_576) {
						void reader.cancel().catch(() => {});
						return null;
					}
					chunks.push(next.value);
				}
				const bytes = new Uint8Array(length);
				let offset = 0;
				for (const chunk of chunks) {
					bytes.set(chunk, offset);
					offset += chunk.length;
				}
				const data = InventorySchema.parse(
					JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
				);
				const age = Date.now() - Date.parse(data.generatedAt);
				if (age < 0 || age > 120_000) return null;
				// Generation time is not observation freshness. Presets and undated
				// provider catalogs cannot prove a currently observed route.
				const observed = data.models.filter((model) =>
					model.exposures.some((row) => {
						const age = Date.now() - Date.parse(row.observedAt ?? "");
						return (
							(!configuredGroups ||
								configuredGroups.includes(model.id) ||
								configuredGroups.includes(row.routeModel ?? "") ||
								row.routes?.some((route) =>
									configuredGroups.includes(route),
								)) &&
							row.evidence !== "configured" &&
							row.state === "up" &&
							age >= 0 &&
							age <= 120_000
						);
					}),
				);
				return data.models.length > 0 && observed.length === 0
					? null
					: observed.length;
			})(),
		]);
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}
