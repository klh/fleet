// test/catalog-server.ts — the catalog e2e harness face: serves the
// GENERATED catalog/elements pages (bun scripts/build-catalog.ts output)
// statically over loopback and stops cleanly. Test kit's serveStub is a
// JSON face; static file service is the catalog's own need.
import { join } from "node:path";

export const catalogDir = (): string =>
	join(import.meta.dir, "../catalog/elements");

export const startCatalogServer = (): {
	url: string;
	stop: () => void;
} => {
	const root = catalogDir();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const path = new URL(req.url).pathname;
			const rel = path === "/" ? "index.html" : path.slice(1);
			const file = Bun.file(join(root, rel));
			return new Response(file);
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		stop: () => server.stop(true),
	};
};
