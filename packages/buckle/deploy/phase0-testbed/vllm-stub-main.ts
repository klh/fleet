// deploy/phase0-testbed/vllm-stub-main.ts — compose entrypoint for the
// Phase 0 rehearsal stub (fleet-flash wiring, C384/#121218): reads the
// compose-owned env names exactly, never defaults to a published surface.
//
//   STUB_HOST=0.0.0.0   bind for peer containers on the internal bridge
//                       (loopback is the DEFAULT when unset — tests keep
//                       their ephemeral 127.0.0.1 bind)
//   STUB_PORT=8191      fixed compose port
//   STUB_TOKEN=<value>  the inner Buckle's api_key_env reads the SAME var;
//                       injected from the up-time fixture, never committed
//
// No port is published by the compose service — the stub is reachable only
// inside the rehearsal network (the /__log journal face is likewise
// internal-network only).
import { startVllmStub } from "./vllm-stub.ts";

const port = Number(process.env.STUB_PORT ?? 8191);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
	console.error(`vllm-stub-main: bad STUB_PORT "${process.env.STUB_PORT}"`);
	process.exit(1);
}

const stub = startVllmStub({
	hostname: process.env.STUB_HOST || "127.0.0.1",
	port,
	token: process.env.STUB_TOKEN || undefined,
	model: process.env.STUB_MODEL || "test-model",
});

console.log(
	`vllm-stub: serving ${stub.model} on ${stub.hostname}:${stub.port} ` +
		`(auth ${process.env.STUB_TOKEN ? "from STUB_TOKEN" : "default test token"})`,
);

const shutdown = async (): Promise<void> => {
	await stub.stop();
	process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
