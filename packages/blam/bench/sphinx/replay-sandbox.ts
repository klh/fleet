import { z } from "zod";

const image =
	"swebench/sweb.eval.x86_64.sphinx-doc_1776_sphinx-9461@sha256:7002375c0d6c01c893097a1214c94186f573b15d71d3ead09f50e0d5002deee0";
export const ReplayImageSchema = z
	.string()
	.regex(/^[a-z0-9][a-z0-9._/:-]*@sha256:[a-f0-9]{64}$/)
	.default(image);
export const ReplayShellSchema = z
	.enum(["legacy", "pipefail"])
	.default("legacy");
const ReplayCommandSchema = z.string().min(1).max(10000);
export function replayShellCommand(commandInput: unknown, modeInput?: unknown) {
	const command = ReplayCommandSchema.parse(commandInput),
		mode = ReplayShellSchema.parse(modeInput);
	const prepared = `export PATH=/opt/miniconda3/envs/testbed/bin:$PATH; ${command}`;
	return mode === "pipefail"
		? ["bash", "--noprofile", "--norc", "-o", "pipefail", "-c", prepared]
		: ["sh", "-lc", prepared];
}
async function collect(stream: ReadableStream<Uint8Array>, limit: number) {
	const reader = stream.getReader(),
		decoder = new TextDecoder();
	let remaining = limit,
		text = "",
		bytes = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		bytes += value.length;
		const kept = value.subarray(0, remaining);
		remaining -= kept.length;
		text += decoder.decode(kept, { stream: true });
	}
	return { text: text + decoder.decode(), bytes, truncated: bytes > limit };
}
async function docker(
	args: string[],
	limit = 1024,
	signal = AbortSignal.timeout(15000),
) {
	const child = Bun.spawn(["docker", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		signal,
	});
	const [exit, stdout, stderr] = await Promise.all([
		child.exited,
		collect(child.stdout, limit),
		collect(child.stderr, 700),
	]);
	return {
		exit,
		stdout,
		stderr,
		timedOut: exit === 124 || exit === 137 || signal.aborted,
	};
}
export function createSandbox(
	workspace: string,
	signal: AbortSignal,
	imageInput?: unknown,
	shellInput?: unknown,
) {
	const image = ReplayImageSchema.parse(imageInput);
	ReplayShellSchema.parse(shellInput);
	function boot(name: string, readonly: boolean) {
		return docker([
			"run",
			"--platform",
			"linux/amd64",
			"--user",
			"1000:1000",
			"--pull",
			"never",
			"--rm",
			"-d",
			"--name",
			name,
			"--network",
			"none",
			"--read-only",
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			"--pids-limit",
			"64",
			"--memory",
			"2g",
			"--cpus",
			"1",
			"--tmpfs",
			"/tmp:rw,nosuid,size=32m",
			"--mount",
			`type=bind,source=${workspace},target=/workspace${readonly ? ",readonly" : ""}`,
			"--mount",
			`type=bind,source=${workspace}/.git,target=/workspace/.git,readonly`,
			"--workdir",
			"/workspace",
			"--entrypoint",
			"sleep",
			image,
			"infinity",
		]);
	}
	function guest(
		name: string,
		command: string,
		limit: number,
		seconds: number,
	) {
		return docker(
			[
				"exec",
				name,
				"timeout",
				"-k",
				"2s",
				`${seconds}s`,
				...replayShellCommand(command, shellInput),
			],
			limit,
			AbortSignal.any([signal, AbortSignal.timeout((seconds + 8) * 1000)]),
		);
	}
	return {
		boot,
		guest,
		remove: (...names: string[]) => docker(["rm", "-f", ...names]),
	};
}
