import { z } from "zod";
export { readHttp } from "./qualification-http.ts";

// The caller injects the reviewed HOST guardian; no unbounded fallback.
export type ProcessRunner = (
	argv: readonly string[],
	options: { timeoutMs: number; maxBytes: number },
) => Promise<{
	code: number | null;
	signal: string | null;
	stdout: Uint8Array;
	stderr: Uint8Array;
}>;
const FullIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
const OwnedSchema = z
	.array(
		z.object({
			Id: FullIdSchema,
			Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }),
			State: z
				.object({ Running: z.boolean(), ExitCode: z.number().int() })
				.optional(),
		}),
	)
	.length(1);

export function createQualificationDriver(run: ProcessRunner, runId: string) {
	async function docker(args: readonly string[], timeoutMs = 10000) {
		const result = await run(["docker", ...args], {
			timeoutMs,
			maxBytes: 1024 * 1024,
		});
		if (result.code !== 0 || result.signal)
			throw Error(`Docker ${args[0]} failed`);
		return new TextDecoder().decode(result.stdout).trim();
	}
	async function owned(id: string, timeoutMs = 10000) {
		FullIdSchema.parse(id);
		const [record] = OwnedSchema.parse(
			JSON.parse(await docker(["inspect", id], timeoutMs)),
		);
		if (
			!record ||
			record.Id !== id ||
			record.Config.Labels?.["io.klh.seed.qualifier"] !== runId
		)
			throw Error("Container ownership refused");
		return record;
	}
	async function remove(id: string, drain = false) {
		const record = await owned(id),
			failures: Error[] = [];
		const remember = (error: unknown) =>
			failures.push(error instanceof Error ? error : Error(String(error)));
		let drained = false,
			joinedClean = false;
		if (drain && record.State?.Running)
			try {
				const output = await docker([
					"exec",
					id,
					"bun",
					"-e",
					"const r=await fetch('http://127.0.0.1:4101/v1/admin/drain',{method:'POST',headers:{authorization:'Bearer '+process.env.BUCKLE_ROOT_KEY,'content-type':'application/json'},body:JSON.stringify({reason:'isolated-seed-qualification',grace_ms:250}),signal:AbortSignal.timeout(3000)});console.log(JSON.stringify({drainStatus:r.status}));void r.body?.cancel();process.exit(r.status===200?0:1)",
				]);
				z.object({ drainStatus: z.literal(200) }).parse(JSON.parse(output));
				drained = true;
			} catch (error) {
				remember(error);
			}
		try {
			let current = drain ? await owned(id) : record;
			const until = performance.now() + 2000;
			while (drained && current.State?.Running && performance.now() < until) {
				await Bun.sleep(50);
				current = await owned(id, 1000);
			}
			if (!drain || current.State?.Running) {
				await docker(["stop", "--time", "5", id], 8000);
				current = await owned(id);
			}
			if (
				!current.State ||
				current.State.Running ||
				current.State.ExitCode !== 0
			)
				throw Error(
					"Owned producer did not join cleanly; exit=" +
						String(current.State?.ExitCode),
				);
			joinedClean = true;
		} catch (error) {
			remember(error);
		}
		if (joinedClean)
			try {
				await docker(["rm", id]);
				const remaining = await docker([
					"container",
					"ls",
					"--all",
					"--quiet",
					"--no-trunc",
					"--filter",
					`id=${id}`,
				]);
				if (remaining) throw Error("Owned container absence not proved");
			} catch (error) {
				remember(error);
			}
		if (failures.length > 1)
			throw new AggregateError(
				failures,
				failures.map((error) => error.message).join("; "),
			);
		if (failures[0]) throw failures[0];
	}
	async function recoverCreated() {
		const [record] = OwnedSchema.parse(
			JSON.parse(await docker(["inspect", `buckle-qualifier-${runId}`])),
		);
		if (!record || record.Config.Labels?.["io.klh.seed.qualifier"] !== runId)
			throw Error("Container ownership refused after uncertain create");
		await owned(record.Id);
		return record.Id;
	}
	return { docker, owned, remove, recoverCreated };
}

export async function finishQualificationCleanup(
	primary: Error | undefined,
	cleanup: () => Promise<void>,
) {
	try {
		await cleanup();
	} catch (error) {
		const failure = error instanceof Error ? error : Error(String(error));
		if (primary)
			throw new AggregateError(
				[primary, failure],
				`Primary qualification refusal: ${primary.message}; cleanup refusal: ${failure.message}`,
			);
		throw failure;
	}
}
