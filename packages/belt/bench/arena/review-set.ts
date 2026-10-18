// review-set.ts — W792: assembles the sealed review-arena task set: seeded
// synthetic tasks (FAMILIES generators) + incident tasks (review-incident)
// + clean tasks. Ground truth is exact by construction; assembly refuses
// loudly on a missing anchor — the seal stays honest.
import { join } from "node:path";
import { pick, ri, rng } from "./core.ts";
import {
	DEFECT_CLASSES,
	type Defect,
	type DefectClass,
	type ReviewTask,
	REVIEW_SEED,
	unifiedDiff,
} from "./review-core.ts";
import { incidentTask, INCIDENTS } from "./review-incident.ts";
import { FAMILIES, resolveSites } from "./review-tasks.ts";

type ResolvedSite = ReturnType<typeof resolveSites>[number];
const CLS_INCIDENT_ONLY: Set<DefectClass> = new Set([
	"n-plus-one",
	"argv-misparse",
	"privileged-bind",
]);

export function seededTasks(nSeeded = 24): ReviewTask[] {
	const out: ReviewTask[] = [];
	const used = new Set<string>();
	const take = (cls: DefectClass): ReviewTask | null => {
		for (const f of FAMILIES) {
			const key = `${f.name}|${cls}`;
			if (used.has(key)) continue;
			const g = f.gen(rng(`${REVIEW_SEED}|${f.name}`));
			const s = resolveSites(g.base, g.sites).find((x) => x.cls === cls);
			if (!s) continue;
			used.add(key);
			return buildTask(f.name, f.file, g.base, s, out.length);
		}
		return null;
	};

	for (const cls of DEFECT_CLASSES) {
		if (CLS_INCIDENT_ONLY.has(cls)) continue;
		const got = take(cls);
		if (got) out.push(got);
	}
	let guard = 0;
	while (out.length < nSeeded && guard++ < 200) {
		const r = rng(`${REVIEW_SEED}|fill|${guard}`);
		const f = pick(r, FAMILIES);
		const g = f.gen(rng(`${REVIEW_SEED}|${f.name}`));
		const s = pick(r, resolveSites(g.base, g.sites));
		if (used.has(`${f.name}|${s.cls}`)) continue;
		used.add(`${f.name}|${s.cls}`);
		out.push(buildTask(f.name, f.file, g.base, s, out.length));
	}
	return out;
}

function buildTask(
	family: string,
	file: string,
	base: string[],
	site: ResolvedSite,
	i: number,
): ReviewTask {
	const buggy = [
		...base.slice(0, site.at),
		...site.bug,
		...base.slice(site.at + site.bug.length),
	];
	const defect: Defect = {
		id: `d-${site.cls}`,
		cls: site.cls,
		file,
		line: site.at + 1,
		desc: site.desc,
	};
	return {
		id: `seed-${String(i + 1).padStart(2, "0")}-${family}-${site.cls}`,
		src: "seeded",
		title: `Seeded defect: ${site.cls} in ${family}`,
		mission: "Land this utility — behavior must match the file-header contract.",
		diff: unifiedDiff(file, base, buggy),
		defects: [defect],
	};
}

export function cleanTasks(nClean = 12): ReviewTask[] {
	const out: ReviewTask[] = [];
	for (let i = 0; i < nClean; i++) {
		const r = rng(`${REVIEW_SEED}|clean|${i}`);
		const f = pick(r, FAMILIES);
		const { base } = f.gen(rng(`${REVIEW_SEED}|${f.name}`));
		const helper = [
			`// usage counter appended by the ${f.name} bench`,
			`export function ${camel(f.name)}UsageCount(): number {`,
			`\treturn ${ri(r, 2, 40)};`,
			"}",
			"",
		];
		const full = [...base, ...helper];
		out.push({
			id: `clean-${String(i + 1).padStart(2, "0")}-${f.name}`,
			src: "clean",
			title: `Clean addition to ${f.name}`,
			mission: "Land this addition — the helper is unused until a follow-up item wires it in.",
			diff: unifiedDiff(f.file, base, full),
			defects: [],
		});
	}
	return out;
}
const camel = (s: string): string => s.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());

export function assembleReviewTasks(
	nSeeded = 24,
	nClean = 12,
	repo = join(import.meta.dir, "../../../.."),
): ReviewTask[] {
	return [
		...seededTasks(nSeeded),
		...cleanTasks(nClean),
		...INCIDENTS.map((d) => incidentTask(d, repo)),
	];
}
