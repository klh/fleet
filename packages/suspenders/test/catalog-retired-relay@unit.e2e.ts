import { expect, test } from "@playwright/test";
import {
	resolveProvider,
	validateProviderConfig,
} from "@klh/settings/connections";
import { HubProfileSchema } from "../hooks/lib/stack-config.ts";
import { renderUpstreams } from "../deploy/hubctl.ts";

test("canonical rendering withholds retired Docker host relays but retains a remote port4100 service", () => {
	const profiles = validateProviderConfig({
		peer: {
			kind: "buckle",
			adapter: "buckle",
			endpoints: { openai: "https://peer-relay.example/v1" },
		},
	});
	const peer = resolveProvider("peer", profiles);
	if (!peer) throw Error("Peer absent");
	const retired = [
		"127.0.0.1",
		"localhost",
		"[::1]",
		"host.docker.internal",
		"gateway.docker.internal",
	];
	const groups = Object.fromEntries(
		[...retired, "remote.example"].map((host) => [
			host,
			[{ url: `http://${host}:4100`, dialect: "openai", model: "exact-model" }],
		]),
	);
	const hub = HubProfileSchema.parse({
		host: "fixture.example",
		upstreams: { groups },
	});
	const doc = JSON.parse(renderUpstreams(hub, [peer], new Map()));
	for (const host of retired) expect(doc.groups[host]).toEqual([]);
	expect(doc.groups["remote.example"][0].url).toBe(
		"http://remote.example:4100",
	);
});
