import {
	existingJournalIdentity,
	JournalIdentitySchema,
	type JournalIdentity,
} from "./journal-anchor.ts";
import { readFile, realpath } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	Harness,
	ROOT_CONVERSATION_ID,
	type HarnessOptions,
} from "@earendil-works/pi-durable";
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
	existingOnly?: boolean;
	expectedJournal?: JournalIdentity;
}) {
	const spec = JobSpecSchema.parse(options.spec),
		context = BACKGROUND_CONTEXT;
	await options.authorize("open", spec);
	const root = await realpath(options.root),
		directory = join(root, spec.runId);
	if (options.existingOnly) await checkJournal();
	else await privateDirectory(directory);
	return openExisting();
	async function checkJournal() {
		const identity = await existingJournalIdentity(root, spec.runId);
		if (
			options.expectedJournal &&
			JSON.stringify(identity) !==
				JSON.stringify(JournalIdentitySchema.parse(options.expectedJournal))
		)
			throw new Error("runner: authoritative HOST journal was replaced");
		return identity;
	}
	async function openExisting() {
		const release = await acquireHostWriter(directory);
		try {
			if (options.existingOnly) await checkJournal();
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
			} else if (options.existingOnly)
				throw new Error("runner: existing HOST manifest required");
			else atomicWrite0600(path, `${JSON.stringify(manifest)}\n`);
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
				const conversation = options.existingOnly
					? await harness.conversation(ROOT_CONVERSATION_ID, context)
					: await harness.root(context, {
							agent: {
								model: { provider: spec.provider, modelId: spec.model },
							},
						});
				if (!conversation)
					throw new Error("runner: existing HOST root conversation required");
				const journalIdentity = await checkJournal();
				await conversation.configure(
					{ extensions: { add: [guarded.guard] } },
					context,
				);
				let closed = false;
				let closePromise: Promise<void> | undefined;
				const check = async (
					action: "read" | "submit" | "resume" | "abort",
				) => {
					if (closed) throw new Error("Durable job closed");
					await options.authorize(action, spec);
				};
				return {
					conversationId: conversation.id,
					manifest,
					journalIdentity,
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
					close(): Promise<void> {
						if (closePromise) return closePromise;
						closed = true;
						closePromise = (async () => {
							try {
								await harness.close(context);
							} finally {
								await release();
							}
						})();
						return closePromise;
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
