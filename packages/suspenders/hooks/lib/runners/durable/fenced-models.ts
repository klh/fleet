import type { FetchFunction } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type { Authorize, JobSpec } from "./contracts.ts";

/** The initial runner supports Buckle's HTTP OpenAI wire only. No WebSocket escape. */
export function fencedModels(
	base: Models,
	authorize: Authorize,
	spec: JobSpec,
): Models {
	const allowed = (model: { api: string }) => {
		if (model.api !== "openai-completions")
			throw new Error(
				"Fleet durable runner requires the HTTP OpenAI-compatible Buckle route",
			);
	};
	const options = <T extends { fetch?: FetchFunction }>(input?: T): T => {
		const original = input?.fetch ?? globalThis.fetch;
		const fetch = new Proxy(original, {
			async apply(target, receiver, args) {
				try {
					await authorize("execute", spec);
				} catch {
					throw new Error("Fleet execution denied before provider dispatch");
				}
				return Reflect.apply(target, receiver, args);
			},
		});
		return Object.assign({}, input, { fetch, maxRetries: 0 });
	};
	const overrides: Pick<
		Models,
		| "stream"
		| "streamSimple"
		| "complete"
		| "completeSimple"
		| "streamDeferred"
		| "fetchDeferred"
		| "cancelDeferred"
		| "generateImages"
		| "classify"
	> = {
		stream(model, context, input) {
			allowed(model);
			return base.stream(model, context, options(input));
		},
		streamSimple(model, context, input) {
			allowed(model);
			return base.streamSimple(model, context, options(input));
		},
		complete(model, context, input) {
			allowed(model);
			return base.complete(model, context, options(input));
		},
		completeSimple(model, context, input) {
			allowed(model);
			return base.completeSimple(model, context, options(input));
		},
		streamDeferred(model, handle, input) {
			allowed(model);
			return base.streamDeferred(model, handle, options(input));
		},
		fetchDeferred(model, handle, input) {
			allowed(model);
			return base.fetchDeferred(model, handle, options(input));
		},
		cancelDeferred(model, handle, input) {
			allowed(model);
			return base.cancelDeferred(model, handle, options(input));
		},
		generateImages() {
			throw new Error("Use an approved image worker adapter");
		},
		classify() {
			throw new Error("Use an approved classifier worker adapter");
		},
	};
	return new Proxy(base, {
		get(target, property) {
			if (Object.hasOwn(overrides, property))
				return Reflect.get(overrides, property);
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
