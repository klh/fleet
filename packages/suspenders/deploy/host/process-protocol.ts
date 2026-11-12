import { isAbsolute } from "node:path";
import { z } from "zod";

export const MAX_CONTROL_BYTES = 256 * 1024;
export const MAX_FRAME_BYTES = 32 * 1024;
export const CHUNK_BYTES = 16 * 1024;
export const StartSchema = z
	.strictObject({
		argv: z.array(z.string().max(65536)).min(1).max(256),
		cwd: z.string().min(1).max(4096).refine(isAbsolute),
		timeoutMs: z
			.number()
			.int()
			.positive()
			.max(20 * 60 * 1000),
		maxBytes: z
			.number()
			.int()
			.positive()
			.max(8 * 1024 * 1024),
	})
	.refine(
		(value) =>
			new TextEncoder().encode(JSON.stringify(value)).length <
			MAX_CONTROL_BYTES,
		"HOST command control byte bound",
	);
export const FrameSchema = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("ready"),
		pid: z.number().int().positive(),
		pgid: z.number().int().positive(),
		sid: z.number().int().positive(),
	}),
	z.strictObject({
		type: z.literal("data"),
		channel: z.enum(["stdout", "stderr"]),
		data: z
			.string()
			.max(24 * 1024)
			.regex(/^[A-Za-z0-9+/]*={0,2}$/),
	}),
	z.strictObject({
		type: z.literal("exit"),
		code: z.number().int().nonnegative().max(255).nullable(),
		signal: z.string().max(64).nullable(),
	}),
	z.strictObject({
		type: z.literal("failure"),
		reason: z.enum(["spawn", "overflow", "protocol"]),
	}),
]);
