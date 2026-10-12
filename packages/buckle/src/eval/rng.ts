// src/eval/rng.ts — seeded RNG (mulberry32): the seed pins the task list, so
// both arms run THE SAME tasks (paired diffs) and re-runs stay comparable.

export interface Rng {
	float(): number;
	int(maxExclusive: number): number;
	pick<T>(xs: readonly T[]): T;
	shuffle<T>(xs: readonly T[]): T[];
}

export function makeRng(seed: number): Rng {
	let s = seed >>> 0;
	const next = (): number => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		t ^= t >>> 16;
		return t >>> 0;
	};
	const unit = (): number => next() / 4294967296;
	return {
		float: unit,
		int: (maxExclusive) => Math.floor(unit() * maxExclusive),
		pick: (xs) => xs[Math.floor(unit() * xs.length)] as (typeof xs)[number],
		shuffle: (xs) => {
			const out = [...xs];
			for (let i = out.length - 1; i > 0; i--) {
				const j = Math.floor(unit() * (i + 1));
				const tmp = out[i] as (typeof out)[number];
				out[i] = out[j] as (typeof out)[number];
				out[j] = tmp;
			}
			return out;
		},
	};
}
