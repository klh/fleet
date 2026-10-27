import { expect, test } from "bun:test";
import { untrustedAdvertisement } from "../bin/remotes.ts";

test("mDNS advertisements remain display-only until independently admitted", () => {
	// a lying advertisement may carry its own port — none of it survives:
	// only name+host are kept and the port is pinned to 0 (never dialable);
	// the admission path, not the advertisement, assigns a real port
	const lying = { name: "nas-llm", host: "nas-threads-dk.local", port: 8901 };
	expect(untrustedAdvertisement(lying)).toEqual({
		name: "nas-llm",
		host: "nas-threads-dk.local",
		port: 0,
	});
});
