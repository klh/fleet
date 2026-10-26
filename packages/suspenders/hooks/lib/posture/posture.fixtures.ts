import type {
	PostureDocument,
	PostureLayer,
	PostureOverlay,
} from "./posture.zod.ts";

/** Project-local fixture storage; never changes HOME or machine configuration. */
export function postureTree() {
	const root = mkdtempSync(resolve(".posture-fixture-"));
	const repo = join(root, "parent", "repo");
	const worktree = join(repo, ".worktrees", "lane");
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(worktree, { recursive: true });
	writeFileSync(join(worktree, ".git"), "gitdir: ../../.git/worktrees/lane\n");
	return {
		root,
		parent: join(root, "parent"),
		repo,
		worktree,
		write(dir: string, text: string): string {
			const source = join(dir, ".prefer");
			writeFileSync(source, text);
			return source;
		},
		cleanup: () => cleanupDirs(root),
	};
}

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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupDirs } from "../../../test/helpers/fixture-kit.ts";
