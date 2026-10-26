import { dirname, join, resolve } from "node:path";
import {
	parseExecutorPrefer,
	preferOverlayOf,
	readPreferText,
} from "../prefer-format.ts";
import { parsePreferFile } from "../prefer-parse.ts";
import type { PostureLayer } from "./posture.zod.ts";

const MAX_WALK = 64;

/** Outermost to nearest, across repository boundaries. Never return a truncated policy. */
export function readPostureLayers(startDir: string): PostureLayer[] {
	const layers: PostureLayer[] = [];
	let dir = resolve(startDir);
	for (let depth = 0; depth < MAX_WALK; depth++) {
		const source = join(dir, ".prefer");
		const text = readPreferText(source);
		if (text !== null) {
			const overlay = preferOverlayOf(source, text);
			if (overlay !== null) layers.push({ source, overlay });
			else {
				const { values, errors } = parsePreferFile(source, text);
				layers.push({
					source,
					overlay: {},
					legacy: { values, errors, executor: parseExecutorPrefer(text) },
				});
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return layers.reverse();
		dir = parent;
	}
	throw new Error(`${startDir}: .prefer walk exceeds ${MAX_WALK} directories`);
}
