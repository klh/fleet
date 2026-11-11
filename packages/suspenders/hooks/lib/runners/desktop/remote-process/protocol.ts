import { z } from "zod";

const bytes = (value: string) => Buffer.byteLength(value);
export const TransportOptionsSchema = z.strictObject({
	containerId: z.string().regex(/^[a-f0-9]{64}$/),
	expectedPinnedImageRef: z.string().regex(/^\S+@sha256:[a-f0-9]{64}$/),
	deadlineAt: z.number().int().positive(),
	dockerBin: z.string().min(1).default("docker"),
	controlTimeoutMs: z.number().int().min(100).max(10_000).default(2000),
});
export const StartFrameSchema = z
	.strictObject({
		type: z.literal("start"),
		argv: z
			.array(
				z
					.string()
					.max(8192)
					.refine((s) => !s.includes("\0") && bytes(s) <= 8192),
			)
			.min(1)
			.max(256)
			.refine(
				(a) => Boolean(a[0]) && a.reduce((n, s) => n + bytes(s), 0) <= 65536,
			),
		stdin: z.string().refine((s) => bytes(s) <= 65536),
	})
	.refine((frame) => bytes(JSON.stringify(frame)) < 524288);
export const GuestFrameSchema = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("ready"),
		pid: z.number().int().min(2),
		pgrp: z.number().int().min(2),
		session: z.number().int().min(2),
		startTime: z.string().regex(/^\d+$/),
	}),
	z.strictObject({
		type: z.literal("output"),
		stream: z.enum(["stdout", "stderr"]),
		data: z
			.string()
			.max(21848)
			.regex(
				/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
			),
	}),
	z.strictObject({
		type: z.literal("exit"),
		code: z.number().int().min(0).max(255),
	}),
	z.strictObject({
		type: z.literal("error"),
		code: z.literal("invalid-control"),
	}),
]);
export const InspectSchema = z
	.array(
		z.object({
			Id: z.string().regex(/^[a-f0-9]{64}$/),
			Config: z.object({ Image: z.string(), Cmd: z.array(z.string()) }),
			State: z.object({
				Running: z.literal(true),
				Pid: z.number().int().positive(),
			}),
		}),
	)
	.length(1);
export const RunLimitsSchema = z.strictObject({
	timeoutMs: z.number().int().positive().max(86_400_000).optional(),
	maxBytes: z.number().int().positive().max(1_048_576).default(1_048_576),
});
