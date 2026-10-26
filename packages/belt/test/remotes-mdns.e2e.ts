import { expect, test } from "@playwright/test";
import { untrustedAdvertisement } from "../bin/remotes.ts";

test("mDNS advertisements remain display-only until independently admitted @unit", () => {
	expect(
		untrustedAdvertisement({ name: "nas-llm", host: "nas-threads-dk.local" }),
	).toEqual({ name: "nas-llm", host: "nas-threads-dk.local", port: 0 });
});
