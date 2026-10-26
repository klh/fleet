import type {
	PostureDocument,
	PostureLayer,
	PostureOverlay,
} from "./posture.zod.ts";

export function postureDocument(): PostureDocument {
	return {
		version: 1,
		hubs: {
			example: {
				profiles: {
					plaid: {
						models: {
							coder: { policy: "MUST", lanes: "MAX" },
							experiment: { policy: "CAN", lanes: 2 },
							disabled: { policy: "OFF", lanes: 0 },
						},
					},
					minimal: {
						models: {
							coder: { policy: "MUST", lanes: 1 },
						},
					},
					development: {
						models: {
							coder: { policy: "CAN", lanes: 2 },
						},
					},
				},
			},
		},
		fleets: {
			fleet: {
				postures: {
					plaid: ["example.plaid"],
					minimal: ["example.minimal"],
					development: ["example.development"],
				},
			},
		},
		selection: {
			fleet: "fleet",
			posture: "plaid",
			developmentOverride: false,
		},
	};
}

export function postureLayer(
	source: string,
	overlay: PostureOverlay,
): PostureLayer {
	return { source, overlay };
}

export function partialRuleOverlay(laneCount: number): PostureOverlay {
	return {
		version: 1,
		hubs: {
			example: {
				profiles: {
					plaid: {
						models: {
							coder: { lanes: laneCount },
						},
					},
				},
			},
		},
	};
}
