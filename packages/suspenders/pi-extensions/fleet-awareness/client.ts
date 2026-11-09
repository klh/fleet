import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import type { z } from "zod";
import {
	HubsSchema,
	PeersSchema,
	type Snapshot,
	type Source,
	WorkSchema,
} from "./contracts.ts";
export type Run = (
	command: string,
	args: string[],
	options?: ExecOptions,
) => Promise<ExecResult>;

/** Only declared read commands; argv arrays and SDK limits, no shell or model calls. */
export async function readSource<T>(
	run: Run,
	command: "coord" | "work",
	args: string[],
	cwd: string,
	schema: z.ZodType<T>,
	signal?: AbortSignal,
	now = Date.now,
	allowedCodes: readonly number[] = [0],
): Promise<Source<T>> {
	try {
		const result = await run(command, args, {
			cwd,
			signal,
			timeout: 8000,
			maxBuffer: 524288,
		});
		if (
			!allowedCodes.includes(result.code) ||
			result.killed ||
			result.truncated
		)
			return { state: "unavailable", observedAt: now(), value: null };
		let payload: unknown;
		try {
			payload = JSON.parse(result.stdout);
		} catch {
			return { state: "invalid", observedAt: now(), value: null };
		}
		const parsed = schema.safeParse(payload);
		return parsed.success
			? { state: "ok", observedAt: now(), value: parsed.data }
			: { state: "invalid", observedAt: now(), value: null };
	} catch {
		return { state: "unavailable", observedAt: now(), value: null };
	}
}

export async function loadSnapshot(
	run: Run,
	cwd: string,
	sid: string | null,
	signal?: AbortSignal,
	now = Date.now,
): Promise<Snapshot> {
	const [hubs, work, peers] = await Promise.all([
		readSource(run, "coord", ["hubs", "--json"], cwd, HubsSchema, signal, now),
		readSource(
			run,
			"work",
			["report", "--format", "json", ...(sid ? ["--as", sid] : [])],
			cwd,
			WorkSchema,
			signal,
			now,
		),
		readSource(
			run,
			"coord",
			["targets", "--json"],
			cwd,
			PeersSchema,
			signal,
			now,
		),
	]);
	return { hubs: { ...hubs, value: hubs.value?.hubs ?? null }, work, peers };
}
