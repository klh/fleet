// test/w1124-14-fetch-counter.ts — W1124.14 harness: wraps globalThis.fetch
// to COUNT attempts per origin, then runs ONE real keepwarm pass in-process.
// Child-side counting — spawned children cannot reliably reach a parent-held
// loopback listener on this macOS. Prints `<origin>=<n>` cells on one line.
const KEEPWARM = new URL("../hooks/bin/llm-keepwarm.ts", import.meta.url)
	.pathname;
const real = globalThis.fetch;
const originOf = (url: string): string => {
	try {
		return new URL(url).origin;
	} catch {
		return url;
	}
};
const counts = new Map<string, number>();
globalThis.fetch = ((input, init) => {
	const url =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.href
				: input.url;
	counts.set(originOf(url), (counts.get(originOf(url)) ?? 0) + 1);
	return real(input, init);
}) as typeof fetch;
try {
	await import(KEEPWARM);
} finally {
	console.log(
		[...counts.entries()].map(([o, n]) => `${o}=${n}`).join(" ") ||
			"NO-FETCHES",
	);
}
