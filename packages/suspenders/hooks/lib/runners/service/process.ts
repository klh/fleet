import { settings } from "@klh/settings";
import { runnerHostConfig } from "./config.ts";
import { openRunnerHost } from "./host.ts";

type RuntimeFactory = Pick<Parameters<typeof openRunnerHost>[0], "openRuntime">;

/** Wait for termination even when it arrives during startup. */
export async function runRunnerService(runtime: RuntimeFactory) {
	const shutdown = Promise.withResolvers<void>();
	const stop = () => shutdown.resolve();
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	try {
		const config = runnerHostConfig(settings({ mode: "service" }).runner);
		const host = await openRunnerHost({ ...config, ...runtime });
		try {
			console.log(JSON.stringify({ control: "listening", url: host.url.href }));
			await shutdown.promise;
		} finally {
			await host.stop();
		}
	} finally {
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
	}
}
