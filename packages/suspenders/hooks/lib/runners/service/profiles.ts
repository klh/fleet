import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { z } from "zod";
import { RunnerProfileSchema } from "../api/contracts.ts";
import { requirePrivateFile } from "./state.ts";

const profilesSchema = z
	.record(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), RunnerProfileSchema)
	.refine(
		(profiles) =>
			Object.keys(profiles).length > 0 && Object.keys(profiles).length <= 128,
	);
const maxBytes = 65_536;

export function readRunnerProfiles(path: string) {
	const descriptor = openSync(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const info = fstatSync(descriptor);
		requirePrivateFile(info);
		if (info.size > maxBytes) throw new Error("runner.profiles_too_large");
		const buffer = Buffer.alloc(maxBytes + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const count = readSync(
				descriptor,
				buffer,
				offset,
				buffer.length - offset,
				null,
			);
			if (!count) break;
			offset += count;
		}
		if (offset > maxBytes) throw new Error("runner.profiles_too_large");
		return profilesSchema.parse(
			JSON.parse(buffer.subarray(0, offset).toString("utf8")),
		);
	} finally {
		closeSync(descriptor);
	}
}
