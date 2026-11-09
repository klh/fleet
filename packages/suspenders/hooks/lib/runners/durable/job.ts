import { readFile, realpath } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, type HarnessOptions } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { atomicWrite0600 } from "@klh/kernel/src/kernel.atomic.module.ts";
import {
	type Authorize,
	JobInputSchema,
	JobManifestSchema,
	JobSpecSchema,
} from "./contracts.ts";
import { acquireHostWriter } from "./host-writer.ts";
import { existingEntry, privateDirectory } from "./private-paths.ts";

type Runtime = Pick<
	HarnessOptions,
	"models" | "registry" | "env" | "settings" | "onReport"
>;

/** Local durable foundation, not a sandbox or a remote control endpoint. */
export async function openDurableJob(options: {
	root: string;
	spec: unknown;
	runtime: Runtime;
	authorize: Authorize;
}) {
	const spec = JobSpecSchema.parse(options.spec),
		context = BACKGROUND_CONTEXT;
	await options.authorize("open", spec);
	const root = await realpath(options.root),
		directory = join(root, spec.runId);
	await privateDirectory(directory);
	return openExisting();
	async function openExisting() {
		const release = await acquireHostWriter(directory);
		try {
			const path = join(directory, "manifest.json"),
				manifest = JobManifestSchema.parse({
					spec,
					runtime: "pi-durable@1.5.0",
					host: hostname(),
				});
			const entry = await existingEntry(path);
			if (entry?.isSymbolicLink())
				throw new Error("Durable manifest must not be a symlink");
			if (entry) {
				const old = JobManifestSchema.parse(
					JSON.parse(await readFile(path, "utf8")),
				);
				if (JSON.stringify(old) !== JSON.stringify(manifest))
					throw new Error(
						"Durable job manifest changed; explicit migration required",
					);
			} else atomicWrite0600(path, `${JSON.stringify(manifest)}\n`);
			await privateDirectory(join(directory, "state"));
			const { executionGuard } = await import("./execution-guard.ts");
			const guarded = executionGuard(options.runtime, options.authorize, spec);
			const storage = await openNodeJsonlStorage(
				join(directory, "state"),
				context,
				{ fsync: true },
			);
			let harness: Harness;
			try {
				harness = await Harness.open(
					storage,
					{
						...options.runtime,
						registry: guarded.registry,
						models: guarded.models,
					},
					context,
				);
			} catch (error) {
				await storage.close(context);
				throw error;
			}
			try {
				const conversation = await harness.root(context, {
					agent: { model: { provider: spec.provider, modelId: spec.model } },
				});
				await conversation.configure(
					{ extensions: { add: [guarded.guard] } },
					context,
				);
				let closed = false;
				const check = async (
					action: "read" | "submit" | "resume" | "abort",
				) => {
					if (closed) throw new Error("Durable job closed");
					await options.authorize(action, spec);
				};
				return {
					conversationId: conversation.id,
					async submit(input: unknown) {
						const value = JobInputSchema.parse(input);
						await check("submit");
						const submission = await conversation.submit(
							{
								type: "input",
								content: value.text,
								requestId: value.requestId,
								...(value.whenBusy ? { whenBusy: value.whenBusy } : {}),
							},
							context,
						);
						return {
							id: submission.id,
							async wait(signal?: AbortSignal) {
								await check("read");
								const { withAbortSignal } = await import(
									"@earendil-works/chord/context"
								);
								return submission.wait(
									signal ? withAbortSignal(signal, context) : context,
								);
							},
							async status() {
								await check("read");
								return submission.status(context);
							},
							async abort() {
								await check("abort");
								return submission.abort(context);
							},
						};
					},
					async read() {
						await check("read");
						return {
							inspection: await harness.inspect(context),
							usage: await harness.usage(context),
						};
					},
					async resume() {
						await check("resume");
						harness.resume();
					},
					async abort() {
						await check("abort");
						await conversation.abort(context);
					},
					async close() {
						if (closed) return;
						closed = true;
						try {
							await harness.close(context);
						} finally {
							await release();
						}
					},
				};
			} catch (error) {
				await harness.close(context);
				throw error;
			}
		} catch (error) {
			await release();
			throw error;
		}
	}
}
