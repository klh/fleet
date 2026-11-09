// Live opt-in routing experiment; scoped keys are always revoked after each call.
import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { RunnerReceipt } from "./contracts.ts";
import { evaluateRunner } from "./evaluate.ts";
import { withRouteKey } from "./route-auth.ts";
import {
	ROUTE_PROMPT,
	RouteAnswerSchema,
	RouteManifestSchema,
	type RouteManifest,
} from "./route-manifest.ts";
import { probeStream } from "./route-stream.ts";
import { routeLedger } from "./route-ledger.ts";

const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const producerDigest = () =>
	hash(
		[
			"contracts.ts",
			"evaluate.ts",
			"route-auth.ts",
			"route-ledger.ts",
			"route-stream.ts",
			"route-manifest.ts",
			"route-live.ts",
		]
			.map((file) => readFileSync(new URL(file, import.meta.url), "utf8"))
			.join("\n"),
	);
async function runRoute(
	m: RouteManifest,
	experiment: string,
	rep: number,
	position: number,
	arm: "baseline" | "candidate",
	fetchFn: typeof fetch,
): Promise<RunnerReceipt> {
	const jobId = `blam-route-${randomUUID()}`,
		front = m[arm].url.replace(/\/$/, "");
	const started = performance.now();
	let sample: Awaited<ReturnType<typeof probeStream>> | null = null,
		revoked = false;
	let failure: string | null = null;
	try {
		const result = await withRouteKey(
			front,
			m[arm].hub,
			jobId,
			(key) =>
				probeStream(
					`${front}/w/${jobId}/v1/chat/completions`,
					key,
					m.model,
					ROUTE_PROMPT,
					m.timeoutMs,
					fetchFn,
				),
			fetchFn,
		);
		sample = result.result;
		revoked = result.revoked;
	} catch (e) {
		failure = e instanceof Error ? e.message : "route setup failed";
	}
	let valid = false;
	try {
		valid = RouteAnswerSchema.safeParse(
			JSON.parse(sample?.content ?? ""),
		).success;
	} catch {
		valid = false;
	}
	const ledger = await routeLedger(front, m[arm].hub, jobId, fetchFn);
	const ledgerOk =
		ledger?.status === 200 &&
		ledger.ok === 1 &&
		ledger.served_model === m.model &&
		ledger.served_provider === m.providerIdentity;
	const usage = sample?.usage;
	const usageMatches =
		!!usage &&
		ledger?.out_tok === usage.out_tok &&
		ledger.in_tok !== null &&
		[
			ledger.in_tok,
			ledger.in_tok + (ledger.cache_r ?? 0) + (ledger.cache_c ?? 0),
		].includes(usage.in_tok);
	const passed =
		valid &&
		revoked &&
		!sample?.error &&
		sample?.wireModel === m.model &&
		ledgerOk &&
		usageMatches;
	return {
		version: 1,
		experiment,
		track: "inference",
		arm,
		rep,
		order: position === 0 ? 0 : 1,
		setup: {
			taskDigest: hash(ROUTE_PROMPT),
			repoRevision: hash("fixed-json-route-probe-v1"),
			host: hostname(),
			runtime: `bun-${Bun.version}`,
			model: m.model,
			provider: ledger?.served_provider ?? "unverified",
			cacheCondition: m.cacheCondition,
			policyDigest: m.policyDigest,
			dependenciesDigest: producerDigest(),
			judgeDigest: hash("strict object ok:true"),
		},
		seedDigest: hash(JSON.stringify(m[arm])),
		jobId,
		readyMs: sample?.headersMs ?? null,
		firstByteMs: sample?.firstByteMs ?? null,
		firstUsefulMs: sample?.firstOutputMs ?? null,
		wallMs: sample?.wallMs ?? performance.now() - started,
		rssBytes: null,
		diskBytes: null,
		usage: usage
			? {
					input: usage.in_tok,
					output: usage.out_tok,
					cachedInput: sample?.cacheReported ? usage.cache_r : null,
				}
			: null,
		quality: valid ? 1 : 0,
		exitCode: passed ? 0 : 1,
		timedOut: sample?.timedOut ?? false,
		isolationFailures: null,
		artifactDigest: hash(sample?.content ?? ""),
		evidence: JSON.stringify({
			failure: failure ?? sample?.error,
			revoked,
			wireModel: sample?.wireModel,
			ledger,
			ledgerOk,
			usageMatches,
			measurement: "request-only; exact JSON checked; no sandbox claim",
		}),
	};
}
export async function routeExperiment(
	raw: unknown,
	fetchFn: typeof fetch = fetch,
) {
	const m = RouteManifestSchema.parse(raw);
	const experiment = `route-${randomUUID()}`;
	mkdirSync(m.outputDir, { recursive: true, mode: 0o700 });
	const receiptFile = join(m.outputDir, "receipts.ndjson");
	writeFileSync(receiptFile, "", { flag: "wx", mode: 0o600 });
	const receipts: RunnerReceipt[] = [];
	for (let rep = 0; rep < m.reps; rep++) {
		const order =
			rep % 2
				? (["candidate", "baseline"] as const)
				: (["baseline", "candidate"] as const);
		for (const [position, arm] of order.entries()) {
			const row = await runRoute(m, experiment, rep, position, arm, fetchFn);
			receipts.push(row);
			appendFileSync(receiptFile, `${JSON.stringify(row)}\n`);
		}
		// Stop after the first failed pair; retain failures and refuse incomplete lift.
		if (receipts.slice(-2).some((r) => r.exitCode !== 0 || r.quality !== 1))
			break;
	}
	const report = evaluateRunner(receipts);
	writeFileSync(
		join(m.outputDir, "report.json"),
		`${JSON.stringify(report, null, 2)}\n`,
		{ flag: "wx", mode: 0o600 },
	);
	return report;
}

if (import.meta.main) {
	if (process.env.BLAM_LIVE !== "1")
		throw new Error("live route benchmark requires BLAM_LIVE=1");
	const path = process.argv[2];
	if (!path)
		throw new Error("usage: BLAM_LIVE=1 bun route-live.ts manifest.json");
	const report = await routeExperiment(JSON.parse(readFileSync(path, "utf8")));
	console.log(JSON.stringify(report));
	if (report.issues.length) process.exitCode = 2;
}
