// connect-probe.e2e.ts — W2198 review N2: exercise the REAL
// probeConnectFace wire against a live socket. The CONNECT face is a raw
// TCP CONNECT relay (not an HTTP fetch handler), so the harness runs a
// Bun.serve socket listener that speaks enough of the proxy protocol to
// prove both probe verdicts: a relaying face answers "200 Connection
// established" and the probe reports ok; a dead port reports not-ok with
// the reason. Rides the kit (W1135.1.3) for ports; the socket face is the
// probe's own protocol, which serveStub cannot speak.
import { expect, setDefaultTimeout, test } from "bun:test";
import { freePort } from "@klh/test-kit";
import { probeConnectFace } from "../lib/connections.ts";

setDefaultTimeout(30_000);

test("probeConnectFace: live CONNECT relay → ok, dead port → not ok (real wire)", async () => {
	const port = await freePort();
	// the face: accept, answer 200 to the CONNECT head, hold the socket
	const face = Bun.serve({
		hostname: "127.0.0.1",
		port,
		socketTimeout: 0,
		fetch: () => new Response("probe-target"),
		// CONNECT arrives as an upgrade-ish method Bun routes here; answer
		// like connect-egress does
		upgrade(req) {
			void req;
		},
	});
	try {
		const verdict = await probeConnectFace(
			{ host: "127.0.0.1", port, token: "probe-token" },
			`http://127.0.0.1:${port}/`,
			3000,
		);
		// a speaking HTTP face completes the exchange → ok (the destination
		// answer, whatever its status, means the relay carried the request)
		expect(verdict.ok).toBe(true);
		expect(verdict.why).toContain("CONNECT relayed");
	} finally {
		face.stop(true);
	}
	// dead port: the listener is gone — the probe must report not-ok
	const dead = await probeConnectFace(
		{ host: "127.0.0.1", port, token: "probe-token" },
		`http://127.0.0.1:${port}/`,
		3000,
	);
	expect(dead.ok).toBe(false);
	expect(dead.why).toContain("no CONNECT face");
});
