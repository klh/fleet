import { expect, test } from "bun:test";
import { untrustedAdvertisement } from "../bin/remotes.ts";

test("mDNS advertisements remain display-only until independently admitted", () => {
	expect(
		untrustedAdvertisement({ name: "nas-llm", host: "nas-threads-dk.local" }),
	).toEqual({ name: "nas-llm", host: "nas-threads-dk.local", port: 0 });
});
