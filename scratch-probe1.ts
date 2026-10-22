// W1067: one probe, echo live routing prefs (allow_cloud / cost mode) + hop.
const r = await fetch("http://127.0.0.1:4000/v1/messages", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({
		model: "claude-sonnet-4",
		max_tokens: 24,
		messages: [{ role: "user", content: "Reply with the single word OK." }],
	}),
	signal: AbortSignal.timeout(90_000),
});
type ProbeBody = {
	_routing?: {
		prefs?: Record<string, unknown>;
		note?: string;
		port?: number;
		model?: string;
	};
};
const d = (await r.json()) as ProbeBody;
console.log(
	JSON.stringify(
		{
			status: r.status,
			hop: r.headers.get("x-klh-hop"),
			prefs: d._routing?.prefs,
			note: d._routing?.note?.slice(0, 160),
			port: d._routing?.port,
			model: d._routing?.model,
		},
		null,
		1,
	),
);
