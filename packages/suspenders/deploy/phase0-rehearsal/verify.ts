#!/usr/bin/env bun
// deploy/phase0-rehearsal/verify.ts — the Phase 0 rehearsal verifier (W2968).
// Brings the four-service stack up on the local Docker rehearsal and proves
// the end-to-end contract (never the real APIM — that is the live Phase 0
// exit test):
//
//   preflight → fixture env → compose up → readiness → mint hop keys →
//   force-recreate → checks → revoke + compose down
//
// Checks:
//   discovery    /v1/models through the full chain; test-model offered
//   stream       SSE flows unbuffered; include_usage terminal frame;
//                sim-minted x-klh-request-id on the response; NO
//                x-klh-hop-contract stamping anywhere on the wire
//   identity     invalid bearer → 401 with ZERO upstream completion calls
//                (stub journal count unchanged)
//   outage       stop stub → verbatim 502 whose fleet_trace.hops name BOTH
//                phase0-edge AND phase0-inner, no fallback; start stub →
//                buckles recover WITHOUT recreation
//   correlation  client-forged ids stripped; the sim-minted id survives
//                both buckles into the stub journal unchanged
//   surface      /v1/admin/* and /__log 404 AT THE PUBLISHED PORT
//                (excluded faces never publish)
//   pacing       dual-leg probe INSIDE apim-sim: proxy (sim listener) vs
//                direct (edge-buckle) — equal frame counts, equal payloads,
//                loose TTFT bound; measured numbers are evidence, never an
//                assertion of two-buckle latency (W2972)
//   quota-429    rpm_limit=1 minted key: invalid bearer 401, first valid
//                200, second valid 429 + Retry-After, exactly ONE upstream
//                hit across the whole block (W2972)
//   ledger-join  the completion's trace id joins a W824 usage-ledger row
//                on the edge gate (/v1/admin/traces): model, ok, tokens
//
// Teardown law: minted keys are revoked (best-effort, receipts printed),
// compose down, fixture dir removed. Exit 0 all-pass · 1 fail · 3 blocked.
//
// Schema law: every wire shape safeParses through a named schema below.

import { z } from "zod";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// -- named wire schemas (schema law: parse, never cast) --
const ComposePortSchema = z.string().regex(/^127\.0\.0\.1:(\d+)$/);
const MintSchema = z.object({
	key_id: z.string().min(1),
	key: z.string().min(1),
	name: z.string().min(1),
	scopes: z.array(z.string()).min(1),
});
const StubEntrySchema = z.object({
	n: z.number(),
	path: z.string(),
	requestId: z.string().nullable(),
	traceId: z.string().nullable(),
	stream: z.boolean(),
	includeUsage: z.boolean(),
	keyFp: z.string().nullable(),
});
const StubJournalSchema = z.object({
	model: z.string(),
	entries: z.array(StubEntrySchema),
});
const ModelsSchema = z.object({
	data: z.array(z.object({ id: z.string() })).min(1),
});
const FleetHopSchema = z.object({
	hub: z.string(),
	status: z.number(),
});
const FleetTraceSchema = z.object({
	id: z.string(),
	hops: z.array(FleetHopSchema).min(1),
});
// W2972 pacing probe — arrival timestamps taken when a COMPLETE SSE frame
// terminator lands (never after res.text(); a buffered read measures
// delivery, not arrival, and would hide mid-frame chunk splits).
const PacingProbeSchema = z.object({
	status: z.number(),
	ttft: z.number(),
	frames: z.number(),
	payload: z.string(),
});
const PacingSchema = z.object({
	direct: PacingProbeSchema,
	proxy: PacingProbeSchema,
});
const QuotaWireSchema = z.object({
	bad: z.number(),
	first: z.number(),
	second: z.number(),
	retryAfter: z.string().nullable(),
});
// W824 usage-ledger read (GET /v1/admin/traces) — the join row for the
// streamed request, by trace id.
const LedgerTraceSchema = z.object({
	requests: z
		.array(
			z.object({
				trace_id: z.string(),
				target_model: z.string().nullable(),
				ok: z.number(),
				in_tok: z.number().nullable(),
				out_tok: z.number().nullable(),
			}),
		)
		.min(1),
});

// -- layout + orchestration helpers --
const HERE = import.meta.dir;
const REPO = join(HERE, "..", "..", "..", "..");
const STUB_ENTRY = join(
	REPO,
	"packages",
	"buckle",
	"deploy",
	"phase0-testbed",
	"vllm-stub-main.ts",
);
const KEEP = process.argv.includes("--keep");

type ShResult = { code: number; out: string; err: string };
const sh = (args: string[]): ShResult => {
	const p = Bun.spawnSync(args, { cwd: HERE, stdout: "pipe", stderr: "pipe" });
	return {
		code: p.exitCode ?? 1,
		out: p.stdout?.toString() ?? "",
		err: p.stderr?.toString() ?? "",
	};
};
// Every compose call carries the run's env file + project name (the
// recreate must re-interpolate the injected hop keys; a bare call resolves
// defaults and silently DROPS the minted credentials from the env).
let COMPOSE_ENV: string | null = null;
let COMPOSE_PROJECT: string | null = null;
const compose = (args: string[]): ShResult => {
	const pre: string[] = [];
	if (COMPOSE_PROJECT !== null) pre.push("--project-name", COMPOSE_PROJECT);
	if (COMPOSE_ENV !== null) pre.push("--env-file", COMPOSE_ENV);
	return sh(["docker", "compose", ...pre, ...args]);
};

const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string): void => {
	checks.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
};

// -- in-container faces (compose exec; nothing publishes admin or journal)
const execIn = (service: string, script: string): ShResult =>
	compose(["exec", "-T", service, "bun", "-e", script]);

const MINT_SCRIPT =
	'const r=await fetch("http://127.0.0.1:"+process.env.BUCKLE_PORT+"/v1/admin/keys",' +
	'{method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+process.env.BUCKLE_ROOT_KEY},' +
	'body:JSON.stringify({name:"phase0-verify",scopes:["buckle:proxy:READ_","buckle:proxy:WRITE_"],expires_in_s:600})});' +
	"console.log(JSON.stringify(await r.json()));";

const revokeScript = (keyId: string): string =>
	'const r=await fetch("http://127.0.0.1:"+process.env.BUCKLE_PORT+"/v1/admin/keys/' +
	keyId +
	'/revoke",{method:"POST",headers:{"authorization":"Bearer "+process.env.BUCKLE_ROOT_KEY}});' +
	"console.log(String(r.status));";

const JOURNAL_SCRIPT =
	'await fetch("http://127.0.0.1:"+process.env.STUB_PORT+"/__log")' +
	".then((r)=>r.text()).then((t)=>console.log(t));";

// W2972 pacing probe — runs INSIDE apim-sim: the proxy leg rides the sim's
// own listener (127.0.0.1:8191), the direct leg hits edge-buckle (:8192,
// the compose-pinned APIM_UPSTREAM) verbatim. Arrival = a COMPLETE SSE
// frame terminator, partial buffer carried across chunk reads; both legs
// relay the same stub, so payloads must come back equal.
const PACING_SCRIPT =
	"const probe=async(url,key)=>{const t0=Date.now();" +
	'const res=await fetch(url+"/v1/chat/completions",{method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+key},' +
	'body:JSON.stringify({model:"test-model",stream:true,messages:[{role:"user",content:"phase0 pacing probe"}]}),signal:AbortSignal.timeout(30000)});' +
	'const reader=res.body.getReader();const dec=new TextDecoder();let buf="",ttft=-1,frames=0,payload="";' +
	"for(;;){const r=await reader.read();if(r.done)break;buf+=dec.decode(r.value,{stream:true});" +
	'for(;;){const i=buf.indexOf("\\n\\n");if(i<0)break;const raw=buf.slice(0,i);buf=buf.slice(i+2);' +
	'const line=raw.replace(/^data: /,"").trim();if(line.length===0||line==="[DONE]")continue;frames++;if(ttft<0)ttft=Date.now()-t0;' +
	'try{payload+=JSON.stringify(JSON.parse(line).choices?.[0]?.delta?.content??"");}catch{}}}' +
	"return {status:res.status,ttft,frames,payload};};" +
	'const d=await probe("http://edge-buckle:8192",process.env.APIM_EDGE_KEY);' +
	'const p=await probe("http://127.0.0.1:8191",process.env.APIM_AUTH_TOKEN);' +
	"console.log(JSON.stringify({direct:d,proxy:p}));";

// W2972 quota leg — a dedicated rpm_limit=1 key on the edge gate, exercised
// from inside apim-sim: invalid bearer, first valid (hits the stub), second
// valid within the same minute.
const QUOTA_MINT_SCRIPT =
	'const r=await fetch("http://127.0.0.1:"+process.env.BUCKLE_PORT+"/v1/admin/keys",' +
	'{method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+process.env.BUCKLE_ROOT_KEY},' +
	'body:JSON.stringify({name:"phase0-verify",scopes:["buckle:proxy:READ_","buckle:proxy:WRITE_"],rpm_limit:1,expires_in_s:600})});' +
	"console.log(JSON.stringify(await r.json()));";

const QUOTA_SCRIPT = (key: string): string =>
	'const call=(auth)=>fetch("http://edge-buckle:8192/v1/chat/completions",{method:"POST",headers:{"content-type":"application/json","authorization":auth},' +
	'body:JSON.stringify({model:"test-model",messages:[{role:"user",content:"phase0 quota probe"}]}),signal:AbortSignal.timeout(30000)});' +
	`const qk=${JSON.stringify(key)};` +
	'const bad=await call("Bearer wrong-token");await bad.arrayBuffer();' +
	'const first=await call("Bearer "+qk);await first.arrayBuffer();' +
	'const second=await call("Bearer "+qk);await second.arrayBuffer();' +
	'console.log(JSON.stringify({bad:bad.status,first:first.status,second:second.status,retryAfter:second.headers.get("retry-after")}));';

// W2972 ledger read — the edge gate's W824 trace face, by the trace id the
// sim minted and relayed (32-hex, server-validated).
const LEDGER_SCRIPT = (traceId: string): string =>
	'const r=await fetch("http://127.0.0.1:"+process.env.BUCKLE_PORT+"/v1/admin/traces?trace_id=' +
	traceId +
	'",{headers:{"authorization":"Bearer "+process.env.BUCKLE_ROOT_KEY}});' +
	"console.log(JSON.stringify(await r.json()));";

const readJournal = (): z.infer<typeof StubJournalSchema> | null => {
	const r = execIn("stub", JOURNAL_SCRIPT);
	if (r.code !== 0) return null;
	let wire: unknown;
	try {
		wire = JSON.parse(r.out.trim());
	} catch {
		return null;
	}
	const parsed = StubJournalSchema.safeParse(wire);
	return parsed.success ? parsed.data : null;
};

type Minted = { service: string; keyId: string; key: string };
const mintIn = (service: string, script = MINT_SCRIPT): Minted | null => {
	const r = execIn(service, script);
	if (r.code !== 0) return null;
	let wire: unknown;
	try {
		wire = JSON.parse(r.out.trim());
	} catch {
		return null;
	}
	const parsed = MintSchema.safeParse(wire);
	return parsed.success
		? { service, keyId: parsed.data.key_id, key: parsed.data.key }
		: null;
};

// W2972: the exec-out → JSON → safeParse read every new check shares.
const parseOut = <S extends z.ZodType>(
	r: ShResult,
	schema: S,
): z.infer<S> | null => {
	let wire: unknown = null;
	if (r.code === 0) {
		try {
			wire = JSON.parse(r.out.trim());
		} catch {
			wire = null;
		}
	}
	const parsed = schema.safeParse(wire);
	return parsed.success ? parsed.data : null;
};

// -- stack lifecycle: fixture env, up, port discovery, readiness --
const writeFixtureEnv = (): {
	dir: string;
	envPath: string;
	secrets: Record<string, string>;
	lines: string[];
} => {
	const r = (n: number): string =>
		crypto.randomUUID().replaceAll("-", "").slice(0, n);
	const secrets = {
		clientToken: `p0-client-${r(16)}`,
		edgeRoot: `p0-root-${r(20)}`,
		innerRoot: `p0-root-${r(20)}`,
		stubToken: `p0-stub-${r(16)}`,
	};
	const dir = mkdtempSync(join(tmpdir(), "phase0-verify-"));
	const envPath = join(dir, "phase0.env");
	const lines = [
		`APIM_AUTH_TOKEN=${secrets.clientToken}`,
		`EDGE_ROOT_KEY=${secrets.edgeRoot}`,
		`INNER_ROOT_KEY=${secrets.innerRoot}`,
		`STUB_TOKEN=${secrets.stubToken}`,
	];
	writeFileSync(envPath, `${lines.join("\n")}\n`, { mode: 0o600 });
	return { dir, envPath, secrets, lines };
};

const simHostPort = (): number | null => {
	const r = compose(["port", "apim-sim", "8191"]);
	const parsed = ComposePortSchema.safeParse(r.out.trim());
	return parsed.success ? Number(r.out.trim().split(":")[1]) : null;
};

const waitHealth = async (
	portFn: () => number | null,
	timeoutMs: number,
): Promise<boolean> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const p = portFn();
		if (p !== null) {
			try {
				const res = await fetch(`http://127.0.0.1:${p}/__health`, {
					signal: AbortSignal.timeout(2000),
				});
				if (res.ok) return true;
			} catch {
				// not ready yet — poll until the deadline
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	return false;
};

// -- checks --
const SIM_MODEL = "test-model";

type SimTarget = { port: () => number | null; secrets: Record<string, string> };

const checkDiscovery = async (t: SimTarget): Promise<void> => {
	const p = t.port();
	if (p === null) {
		check("discovery", false, "no published port");
		return;
	}
	const res = await fetch(`http://127.0.0.1:${p}/v1/models`, {
		headers: { authorization: `Bearer ${t.secrets.clientToken ?? ""}` },
		signal: AbortSignal.timeout(15000),
	});
	const parsed = ModelsSchema.safeParse(await res.json().catch(() => null));
	check(
		"discovery",
		res.status === 200 &&
			parsed.success &&
			parsed.data.data.some((m) => m.id === SIM_MODEL),
		`status=${res.status} parse=${parsed.success} model=${SIM_MODEL}`,
	);
};

const checkStream = async (t: SimTarget): Promise<void> => {
	const p = t.port();
	if (p === null) {
		check("stream", false, "no published port");
		return;
	}
	const res = await fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${t.secrets.clientToken ?? ""}`,
		},
		body: JSON.stringify({
			model: SIM_MODEL,
			stream: true,
			stream_options: { include_usage: true },
			messages: [{ role: "user", content: "phase0 rehearsal stream probe" }],
		}),
		signal: AbortSignal.timeout(30000),
	});
	const minted = res.headers.get("x-klh-request-id");
	const hopContract = res.headers.get("x-klh-hop-contract");
	const text = await res.text();
	const frames = text
		.split("\n\n")
		.map((chunk) => chunk.replace(/^data: /, "").trim())
		.filter((line) => line.length > 0 && line !== "[DONE]")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
	const usageFrame = frames.find(
		(f) =>
			f.usage !== undefined &&
			Array.isArray(f.choices) &&
			f.choices.length === 0,
	);
	check(
		"stream",
		res.status === 200 &&
			frames.length > 1 &&
			usageFrame !== undefined &&
			typeof minted === "string" &&
			hopContract === null,
		`status=${res.status} frames=${frames.length} usage=${usageFrame !== undefined} minted-id=${typeof minted === "string"} hop-contract=${String(hopContract)}`,
	);
};

const checkIdentity = async (t: SimTarget): Promise<void> => {
	const p = t.port();
	if (p === null) {
		check("identity", false, "no published port");
		return;
	}
	const before = readJournal()?.entries.length ?? -1;
	const res = await fetch(`http://127.0.0.1:${p}/v1/models`, {
		headers: { authorization: "Bearer wrong-token" },
		signal: AbortSignal.timeout(15000),
	});
	const after = readJournal()?.entries.length ?? -2;
	check(
		"identity",
		res.status === 401 && before >= 0 && before === after,
		`status=${res.status} journal-before=${before} journal-after=${after}`,
	);
};

const checkSurface = async (t: SimTarget): Promise<void> => {
	const p = t.port();
	if (p === null) {
		check("surface", false, "no published port");
		return;
	}
	const auth = { authorization: `Bearer ${t.secrets.clientToken ?? ""}` };
	const admin = await fetch(`http://127.0.0.1:${p}/v1/admin/keys`, {
		headers: auth,
		signal: AbortSignal.timeout(10000),
	});
	const log = await fetch(`http://127.0.0.1:${p}/__log`, {
		headers: auth,
		signal: AbortSignal.timeout(10000),
	});
	check(
		"surface",
		admin.status === 404 && log.status === 404,
		`admin=${admin.status} log=${log.status} (both must 404 at the published port)`,
	);
};

const checkOutage = async (t: SimTarget): Promise<void> => {
	const p = t.port();
	if (p === null) {
		check("outage", false, "no published port");
		return;
	}
	if (compose(["stop", "stub"]).code !== 0) {
		check("outage", false, "compose stop stub failed");
		return;
	}
	const res = await fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${t.secrets.clientToken ?? ""}`,
		},
		body: JSON.stringify({
			model: SIM_MODEL,
			messages: [{ role: "user", content: "phase0 outage probe" }],
		}),
		signal: AbortSignal.timeout(30000),
	});
	const wire = (
		(await res.json().catch(() => null)) as Record<string, unknown> | null
	)?.fleet_trace;
	const trace = FleetTraceSchema.safeParse(wire);
	const hubs = trace.success ? trace.data.hops.map((h) => h.hub) : [];
	check(
		"outage-502",
		res.status === 502 &&
			hubs.includes("phase0-edge") &&
			hubs.includes("phase0-inner"),
		`status=${res.status} hubs=${hubs.join(",")}`,
	);
};

const checkCorrelation = async (t: SimTarget): Promise<void> => {
	const p = t.port();
	if (p === null) {
		check("correlation", false, "no published port");
		return;
	}
	const forged = "forged-by-client-123";
	const forgedTraceId = "11111111111111111111111111111111";
	const forgedTp = `00-${forgedTraceId}-2222222222222222-01`;
	const res = await fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${t.secrets.clientToken ?? ""}`,
			"x-klh-request-id": forged,
			"x-request-id": forged,
			traceparent: forgedTp,
		},
		body: JSON.stringify({
			model: SIM_MODEL,
			messages: [{ role: "user", content: "phase0 correlation probe" }],
		}),
		signal: AbortSignal.timeout(30000),
	});
	await res.arrayBuffer();
	const minted = res.headers.get("x-klh-request-id");
	const traceId = res.headers.get("x-klh-trace-id");
	const entry = readJournal()?.entries.at(-1) ?? null;
	check(
		"correlation",
		res.ok &&
			typeof minted === "string" &&
			minted !== forged &&
			entry?.traceId !== null &&
			entry?.traceId === traceId &&
			traceId !== forgedTraceId,
		`minted-not-forged=${minted !== forged} trace-join=${entry?.traceId === traceId}`,
	);
};

// W2972: does routing through the APIM listener deform streaming? Both legs
// run inside apim-sim against the same stub — equal frame counts, equal
// payloads, and a LOOSE TTFT bound (2s) prove relay fidelity. The measured
// numbers print as evidence; they are NOT a two-buckle latency claim.
const checkPacing = async (): Promise<void> => {
	const parsed = parseOut(execIn("apim-sim", PACING_SCRIPT), PacingSchema);
	const d = parsed?.direct ?? null;
	const p = parsed?.proxy ?? null;
	const equalPayloads = d !== null && p !== null && p.payload === d.payload;
	check(
		"pacing",
		d !== null &&
			p !== null &&
			d.status === 200 &&
			p.status === 200 &&
			p.frames === d.frames &&
			p.frames > 1 &&
			equalPayloads &&
			p.ttft <= d.ttft + 2000,
		`direct ttft=${d?.ttft ?? -1}ms frames=${d?.frames ?? 0} · proxy ttft=${p?.ttft ?? -1}ms frames=${p?.frames ?? 0} payload-equal=${equalPayloads} (simulator-only)`,
	);
};

// W2972: rpm_limit rides the mint itself — 401 without a key, 200 on the
// first valid call, 429 + Retry-After on the second within the same minute,
// and EXACTLY ONE upstream hit across the whole block (the 401 and the 429
// must never reach the stub). The key carries the fixture-class mint name
// (phase0-verify — the tier policy binds by mint name; any other name 403s
// repo_unknown) and joins minted[] for teardown.
const checkQuota = async (minted: Minted[]): Promise<void> => {
	const qk = mintIn("edge-buckle", QUOTA_MINT_SCRIPT);
	if (qk === null) {
		check("quota-429", false, "quota key mint failed");
		return;
	}
	minted.push(qk);
	const before = readJournal()?.entries.length ?? -1;
	const w = parseOut(execIn("apim-sim", QUOTA_SCRIPT(qk.key)), QuotaWireSchema);
	const after = readJournal()?.entries.length ?? -2;
	const hits = after - before;
	check(
		"quota-429",
		w !== null &&
			w.bad === 401 &&
			w.first === 200 &&
			w.second === 429 &&
			w.retryAfter !== null &&
			before >= 0 &&
			hits === 1,
		`401=${w?.bad ?? "-"} 200=${w?.first ?? "-"} 429=${w?.second ?? "-"} retry-after=${w?.retryAfter === null ? "MISSING" : "present"} upstream-hits=${hits} (expect 1)`,
	);
};

// W2972: fire one completion through the full chain, then poll the edge
// gate's W824 trace face until the ledger row settles. The query is
// trace-id-filtered server-side — a returned row IS the join.
const ledgerJoin = async (
	t: SimTarget,
): Promise<z.infer<typeof LedgerTraceSchema>["requests"][number] | null> => {
	const p = t.port();
	if (p === null) return null;
	const res = await fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${t.secrets.clientToken ?? ""}`,
		},
		body: JSON.stringify({
			model: SIM_MODEL,
			messages: [{ role: "user", content: "phase0 ledger-join probe" }],
		}),
		signal: AbortSignal.timeout(30000),
	});
	await res.arrayBuffer();
	const traceId = res.headers.get("x-klh-trace-id");
	if (!res.ok || traceId === null) return null;
	for (let i = 0; i < 15; i++) {
		const trace = parseOut(
			execIn("edge-buckle", LEDGER_SCRIPT(traceId)),
			LedgerTraceSchema,
		);
		const row = trace?.requests[0] ?? null;
		if (row !== null) return row;
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	return null;
};

// The ledger row must show the real model, a successful call, and nonzero
// usage — the W824 accounting joined to a request this run actually made.
const checkLedger = async (t: SimTarget): Promise<void> => {
	const row = await ledgerJoin(t);
	check(
		"ledger-join",
		row !== null &&
			row.target_model === SIM_MODEL &&
			row.ok === 1 &&
			(row.in_tok ?? 0) > 0 &&
			(row.out_tok ?? 0) > 0,
		`model=${row?.target_model ?? "-"} ok=${row?.ok ?? "-"} tokens=${String(row?.in_tok)}/${String(row?.out_tok)}`,
	);
};

const teardown = (mintedKeys: Minted[], envPath: string, dir: string): void => {
	for (const m of mintedKeys) {
		const r = execIn(m.service, revokeScript(m.keyId));
		const status = r.code === 0 ? Number(r.out.trim()) : 0;
		check(
			"revocation",
			r.code === 0 && status === 200,
			`${m.service}/${m.keyId.slice(0, 12)} status=${String(status)}`,
		);
	}
	if (!KEEP) {
		compose(["down", "--remove-orphans", "--timeout", "5"]);
		rmSync(dir, { recursive: true, force: true });
	} else {
		console.log(`--keep: stack left up, fixture at ${dir} (${envPath})`);
	}
};

const waitJournal = async (timeoutMs: number): Promise<boolean> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (readJournal() !== null) return true;
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	return false;
};

const runChecks = async (t: SimTarget, minted: Minted[]): Promise<boolean> => {
	await checkDiscovery(t);
	await checkStream(t);
	await checkIdentity(t);
	await checkSurface(t);
	await checkOutage(t);
	if (compose(["start", "stub"]).code !== 0) {
		check("correlation", false, "stub failed to restart after the outage");
		return checks.every((c) => c.ok);
	}
	if (!(await waitJournal(30_000))) {
		check("correlation", false, "stub journal face not back within 30s");
		return checks.every((c) => c.ok);
	}
	await checkCorrelation(t);
	await checkPacing();
	await checkQuota(minted);
	await checkLedger(t);
	return checks.every((c) => c.ok);
};

// Staged key bring-up (tmpfs-DB law: never recreate an issuer after its
// mint — the recreate wipes the DB and the issued key with it). Order:
// mint inner → inject EDGE_INNER_KEY → recreate edge → mint edge → inject
// APIM_EDGE_KEY → recreate sim; no issuer is recreated after its mint.
const mintHopKeys = async (
	envPath: string,
	lines: string[],
	minted: Minted[],
): Promise<boolean> => {
	let inner: Minted | null = null;
	for (let i = 0; i < 30 && inner === null; i++) inner = mintIn("inner-buckle");
	if (inner === null) {
		console.log("FAIL mint inner-buckle hop key");
		return false;
	}
	minted.push(inner);
	lines.push(`EDGE_INNER_KEY=${inner.key}`);
	writeFileSync(envPath, `${lines.join("\n")}\n`, { mode: 0o600 });
	compose(["up", "-d", "--force-recreate", "--no-deps", "edge-buckle"]);
	let edge: Minted | null = null;
	for (let i = 0; i < 30 && edge === null; i++) edge = mintIn("edge-buckle");
	if (edge === null) {
		console.log("FAIL mint edge-buckle key (not ready after recreate)");
		return false;
	}
	minted.push(edge);
	lines.push(`APIM_EDGE_KEY=${edge.key}`);
	writeFileSync(envPath, `${lines.join("\n")}\n`, { mode: 0o600 });
	compose(["up", "-d", "--force-recreate", "--no-deps", "apim-sim"]);
	return waitHealth(simHostPort, 60_000);
};

const main = async (): Promise<number> => {
	if (sh(["docker", "info"]).code !== 0) {
		console.log("BLOCKED: docker not reachable (Docker Desktop running?)");
		return 3;
	}
	if (!existsSync(STUB_ENTRY)) {
		console.log("BLOCKED: stub entrypoint missing — lands with W2969 merge");
		return 3;
	}
	const fixture = writeFixtureEnv();
	COMPOSE_ENV = fixture.envPath;
	COMPOSE_PROJECT = `p0-${crypto.randomUUID().slice(0, 8)}`;
	const minted: Minted[] = [];
	let exit = 1;
	try {
		compose(["up", "-d"]);
		if (!(await waitHealth(simHostPort, 120_000))) {
			console.log("FAIL stack readiness (120s)");
		} else if (!(await mintHopKeys(fixture.envPath, fixture.lines, minted))) {
			console.log("FAIL staged key bring-up");
		} else {
			const t: SimTarget = { port: simHostPort, secrets: fixture.secrets };
			exit = (await runChecks(t, minted)) ? 0 : 1;
		}
	} finally {
		teardown(minted, fixture.envPath, fixture.dir);
		const failed = checks.filter((c) => !c.ok).map((c) => c.name);
		console.log(
			exit === 0
				? `PHASE0 VERIFY: PASS (${String(checks.length)} checks)`
				: `PHASE0 VERIFY: FAIL — ${failed.join(",") || "run aborted before checks"}`,
		);
	}
	return exit;
};

const code = await main();
process.exit(code);
