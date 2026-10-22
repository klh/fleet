// W1067 acceptance probe: N-request burst at the live :4000 router.
// Usage: bun scratch-burst.ts [n] [port]
const n = Number(process.argv[2] ?? 12);
const port = Number(process.argv[3] ?? 4000);
const PROMPT =
	"Design a distributed rate-limiter for a multi-region API gateway: " +
	"discuss token-bucket vs sliding-window-log trade-offs, hot-key mitigation, " +
	"clock skew handling, and failure modes under partition. Include pseudo-code.";
const t0 = performance.now();
const jobs = Array.from({ length: n }, (_, i) =>
	fetch(`http://127.0.0.1:${port}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-4",
			max_tokens: 64,
			messages: [{ role: "user", content: `${PROMPT} (variant ${i})` }],
		}),
		signal: AbortSignal.timeout(120_000),
	})
		.then(async (r) => ({
			i,
			status: r.status,
			ms: Math.round(performance.now() - t0),
			hop: r.headers.get("x-klh-hop"),
			refusal: r.headers.get("x-klh-refusal"),
			retryAfter: r.headers.get("retry-after"),
			body: (await r.text()).slice(0, 200),
		}))
		.catch((e: unknown) => ({
			i,
			status: 0,
			ms: Math.round(performance.now() - t0),
			hop: "-",
			refusal: "transport",
			retryAfter: "-",
			body: String(e).slice(0, 200),
		})),
);
const results = await Promise.all(jobs);
results.sort((a, b) => a.i - b.i);
for (const r of results)
	console.log(
		`#${String(r.i).padStart(2, "0")} ${r.status} ${String(r.ms).padStart(6)}ms hop=${r.hop} refusal=${r.refusal} retry-after=${r.retryAfter}`,
	);
const ok = results.filter((r) => r.status === 200).length;
const refused = results.filter((r) => r.status === 429).length;
const other = results.filter((r) => r.status !== 200 && r.status !== 429).length;
console.log(
	`SUMMARY ${ok}x200 ${refused}x429 ${other}xother of ${n} in ${Math.round(performance.now() - t0)}ms`,
);
