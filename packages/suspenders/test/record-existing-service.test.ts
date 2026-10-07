import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { recordExistingService } from "../scripts/lib/record-existing-service.ts";
import {
	digestUnit,
	type ActivationReceipt,
	type Inspect,
} from "../scripts/lib/service-drift.ts";
const unit = "reviewed unit",
	manifest = "reviewed immutable manifest";
const service = {
	label: "com.suspenders.fleet-loop",
	unit: "/unit",
	unitSha256: digestUnit(unit),
	arguments: ["/bun", "/loop"],
	resident: true,
};
const receipt: ActivationReceipt = {
	schema: "fleet.service-activation.v1",
	platform: "darwin",
	domain: "gui/501",
	manifest: "/manifest",
	manifestSha256: digestUnit(manifest),
	services: [],
};
function fixture(
	options: { drift?: boolean; unknown?: boolean; changed?: boolean } = {},
) {
	const calls: string[][] = [],
		published: ActivationReceipt[] = [];
	let births = 0;
	const inspect: Inspect = (args) => {
		calls.push(args);
		return args[1] === "print-disabled"
			? { code: 0, out: "", error: "" }
			: {
					code: 0,
					out: "\n arguments = {\n /bun\n /loop\n }\n pid = 12\n",
					error: "",
				};
	};
	const run = () =>
		recordExistingService(
			receipt,
			service,
			unit,
			{
				...receipt,
				services: [{ ...service, label: "com.suspenders.cloud-gateway" }],
			},
			{
				inspect,
				read: (path) =>
					path === "/manifest" ? manifest : options.drift ? "modified" : unit,
				birth: () =>
					options.unknown
						? null
						: {
								birth: options.changed && ++births > 1 ? "new" : "original",
								command: "bun",
							},
				publish: (value) => published.push(value),
			},
		);
	return { run, calls, published };
}
test("explicit reconciliation retains prior intent and records running controller without lifecycle actions", () => {
	const f = fixture();
	expect(f.run()).toBe(12);
	expect(f.published[0].services.map((entry) => entry.label)).toEqual([
		"com.suspenders.cloud-gateway",
		"com.suspenders.fleet-loop",
	]);
	expect(
		f.calls.every(
			(args) => args[1] === "print" || args[1] === "print-disabled",
		),
	).toBe(true);
});
test("unit drift or unknown or changed birth refuses publication", () => {
	for (const options of [
		{ drift: true },
		{ unknown: true },
		{ changed: true },
	]) {
		const f = fixture(options);
		expect(f.run).toThrow();
		expect(f.published).toHaveLength(0);
	}
});
test("registration command has no bootstrap, kickstart, bootout, signal or installer actuator", () => {
	const source = readFileSync(
		new URL("../scripts/record-fleet-loop-activation.ts", import.meta.url),
		"utf8",
	);
	expect(source).not.toMatch(
		/\b(?:bootstrap|kickstart|bootout|process\.kill|install\.sh)\b/,
	);
	expect(source).toContain("--record-existing");
	expect(source).toContain("inspectActivatedDispatch");
});
test("serialization changes are accepted only when all parsed declaration fields match", () => {
	const actual = '{"env":{"TOKEN":"private"},"args":["/bun","/loop"]}';
	const expected = '{ "args": ["/bun", "/loop"], "env": {"TOKEN": "private"} }';
	let publications = 0;
	const f = fixture();
	const deps = {
		inspect: (args: string[]) =>
			args[1] === "print-disabled"
				? { code: 0, out: "", error: "" }
				: {
						code: 0,
						out: "\n arguments = {\n /bun\n /loop\n }\n pid = 12\n",
						error: "",
					},
		read: (path: string) => (path === "/manifest" ? manifest : actual),
		birth: () => ({ birth: "original", command: "bun" }),
		parseUnit: JSON.parse,
		publish: () => {
			publications++;
		},
	};
	expect(
		recordExistingService(
			receipt,
			{ ...service, unitSha256: digestUnit(actual) },
			expected,
			undefined,
			deps,
		),
	).toBe(12);
	expect(publications).toBe(1);
	expect(() =>
		recordExistingService(
			receipt,
			{ ...service, unitSha256: digestUnit(actual) },
			expected.replace("private", "changed"),
			undefined,
			deps,
		),
	).toThrow();
	expect(publications).toBe(1);
	expect(f.published).toHaveLength(0);
});
