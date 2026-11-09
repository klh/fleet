// Run with bun from a host that has both native pinned images cached.
// Stdout is the sealed BLAM receipt. Per-run diagnostics go to stderr.
import {
	dockerCaps,
	dockerImageIdentity,
} from "../../blam/bench/artifact/docker-driver.ts";
import {
	receiptLines,
	runScenario,
} from "../../blam/bench/artifact/harness.ts";
import type { ScenarioSpec } from "../../blam/bench/artifact/types.ts";
import { runSandboxCanary } from "./runner-live-sandbox.fixture.ts";

const [bed, first, second, extra] = process.argv.slice(2);
const pinned = (image: string) => /@sha256:[a-f0-9]{64}$/.test(image);
if (
	!bed ||
	!first ||
	!second ||
	extra ||
	first === second ||
	!pinned(first) ||
	!pinned(second)
)
	throw new Error(
		"Usage: bun test/runner-live-sandbox.bench.ts <bed> <pinned-image-a> <pinned-image-b>",
	);
// Match runnerDockerArgv so receipt metadata and sandbox execution use one daemon.
if (process.platform === "linux") {
	delete process.env.DOCKER_CONTEXT;
	process.env.DOCKER_HOST = "unix:///var/run/docker.sock";
} else {
	process.env.DOCKER_CONTEXT = "desktop-linux";
}
const caps = await dockerCaps(bed);
const images = await Promise.all(
	[first, second].map((image) => dockerImageIdentity(caps, image)),
);
const spec: ScenarioSpec = {
	id: "runner-http-first-tool-result",
	title: "Runner HTTP to first sandbox tool result",
	decision:
		"Lower median time to the verified seed read wins this fixture comparison.",
	rule: { stat: "median", lowerWins: true, tieEpsilon: 0.05 },
	reps: 5,
	seed: 2937,
	arms: images.map(({ image }) => ({
		kind: "image",
		id: image,
		label: image,
		pinned: true,
	})),
};
const run = await runScenario(spec, {
	bed,
	caps,
	async measure(arm, rep) {
		const sample = await runSandboxCanary(arm.id);
		console.error(JSON.stringify({ rep, ...sample }));
		return sample.usefulMs;
	},
});
if (run.failures.length) {
	console.error(JSON.stringify(run.failures));
	process.exit(1);
}
console.log(
	receiptLines(
		run,
		images.map((image) => ({ kind: "image-identity", ...image })),
	).join("\n"),
);
