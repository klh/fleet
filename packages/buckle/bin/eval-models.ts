// bin/eval-models.ts — W424 powered model-swap eval: paired A/B on shared
// seed-pinned tasks (≥130/shape → ±7pt), computed answer keys, per-shape
// Wilson 95% intervals + exact McNemar, owner abstain rule: overlapping arm
// intervals = tie → cost per resolved task decides (lesson.eval-power-discipline).
// Feeds buckle prefs + dispatch model picks; the YAML/prefs stay
// operator-owned — this tool produces the evidence, never writes config.
// One JSON report line on stdout; human table on stderr.
//
//	bun bin/eval-models.ts \
//		--a-url http://127.0.0.1:8902/v1 --a-model <id> \
//		--b-url http://127.0.0.1:8903/v1 --b-model <id> \
//		[--a-key K] [--b-key K] \
//		[--price-in-a X] [--price-out-a X] [--price-in-b X] [--price-out-b X] \
//		[--shapes code,menial,reasoning,danish] [--n 130] [--seed 424] \
//		[--repeats 1] [--concurrency 2] [--timeout 120000] [--max-tokens 2048] \
//		[--out results.jsonl] [--report report.json] [--quick]
import { appendFileSync } from "node:fs";
import {
	aggregateShape,
	renderTable,
	type ShapeReport,
} from "../src/eval/report.ts";
import { ping, runArm, type RunOpts } from "../src/eval/runner.ts";
import { POWER_N } from "../src/eval/stats.ts";
import { makeTasks } from "../src/eval/tasks.ts";
import {
	SHAPES,
	type Arm,
	type Shape,
	type TaskResult,
} from "../src/eval/types.ts";

const arg = (name: string): string | null => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};

const has = (name: string): boolean => process.argv.includes(`--${name}`);

const num = (name: string, dflt: number): number => Number(arg(name) ?? dflt);

const mkArm = (name: "a" | "b"): Arm => {
	const url = arg(`${name}-url`);
	const model = arg(`${name}-model`);
	if (!url || !model) {
		throw new Error(`--${name}-url and --${name}-model are required`);
	}
	const arm: Arm = { name, url, model };
	const key = arg(`${name}-key`);
	if (key) arm.key = key;
	const pin = arg(`price-in-${name}`);
	if (pin) arm.price_in = Number(pin);
	const pout = arg(`price-out-${name}`);
	if (pout) arm.price_out = Number(pout);
	return arm;
};

const jsonlSink = (
	path: string | null,
): ((r: TaskResult) => void) | undefined => {
	if (!path) return undefined;
	return (r: TaskResult): void => {
		try {
			appendFileSync(path, `${JSON.stringify(r)}\n`);
		} catch {
			// the sink must never kill a run — in-memory rows stand
		}
	};
};

function readShapes(): Shape[] {
	const raw = arg("shapes") ?? SHAPES.join(",");
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter((s): s is Shape => (SHAPES as readonly string[]).includes(s));
}

function evalOpts(quick: boolean): RunOpts {
	return {
		concurrency: num("concurrency", 2),
		timeout_ms: num("timeout", 120000),
		max_tokens: num("max-tokens", 2048),
		repeats: quick ? 1 : num("repeats", 1),
	};
}

async function evalShape(
	shape: Shape,
	n: number,
	seed: number,
	opts: RunOpts,
	a: Arm,
	b: Arm,
): Promise<ShapeReport> {
	const tasks = makeTasks(shape, n, seed);
	const msg = `eval: ${shape} — ${String(tasks.length)} tasks × 2 arms`;
	console.error(msg);
	const sink = jsonlSink(arg("out"));
	const rowsA = await runArm(a, tasks, opts, sink);
	const rowsB = await runArm(b, tasks, opts, sink);
	return aggregateShape(
		shape,
		tasks.map((t) => t.id),
		rowsA,
		rowsB,
		opts.repeats,
		a,
		b,
	);
}

async function runEval(
	shapes: Shape[],
	n: number,
	seed: number,
	opts: RunOpts,
	a: Arm,
	b: Arm,
): Promise<ShapeReport[]> {
	const reports: ShapeReport[] = [];
	for (const shape of shapes) {
		const rep = await evalShape(shape, n, seed, opts, a, b);
		reports.push(rep);
	}
	return reports;
}

function reportJson(
	reports: ShapeReport[],
	seed: number,
	n: number,
	repeats: number,
	a: Arm,
	b: Arm,
): string {
	const arms = {
		a: { url: a.url, model: a.model },
		b: { url: b.url, model: b.model },
	};
	return JSON.stringify({
		ts: new Date().toISOString(),
		seed,
		n,
		repeats,
		arms,
		shapes: reports,
	});
}

async function main(): Promise<void> {
	const quick = has("quick");
	const a = mkArm("a");
	const b = mkArm("b");
	const upA = await ping(a);
	const upB = await ping(b);
	if (!upA || !upB) {
		const msg = `eval: arm unreachable (a=${String(upA)}, b=${String(upB)})`;
		console.error(msg);
		process.exit(1);
	}
	const shapes = readShapes();
	const n = quick ? 8 : num("n", POWER_N);
	const seed = num("seed", 424);
	const opts = evalOpts(quick);
	const reports = await runEval(shapes, n, seed, opts, a, b);
	console.log(reportJson(reports, seed, n, opts.repeats, a, b));
	console.error(renderTable(reports));
	const rp = arg("report");
	if (rp) {
		await Bun.write(rp, reportJson(reports, seed, n, opts.repeats, a, b));
	}
}

await main();
