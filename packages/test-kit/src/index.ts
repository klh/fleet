// src/index.ts — the kit's one export face: exactly the four audited
// primitives (W1135.1.3). No other surface; migration lanes import from
// here (`@klh/test-kit` once installed, or the relative src path).
export {
	type ScratchWorld,
	scratchWorld,
} from "./scratch-world.ts";
export { type CliResult, type RunCliOpts, runCli } from "./run-cli.ts";
export {
	freePort,
	freePortSync,
	type WaitUpOpts,
	waitUp,
} from "./ports.ts";
export {
	type ServeStub,
	serveStub,
	type StubHandler,
	type StubRequest,
} from "./serve-stub.ts";
