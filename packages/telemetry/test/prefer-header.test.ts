import { describe, expect, test } from "bun:test";
import { encodePreferHeader, parsePreferHeader } from "../src/prefer-header.ts";

describe(".prefer trace header", () => {
	test("captures the selected rule without the raw file", () => {
		const value = encodePreferHeader({
			source: "dotfile",
			directive: "can",
			line: 7,
			index: 0,
			target: "glm-5.3-flash",
			can: "active",
		});
		expect(value).toBe(
			"v=1;source=dotfile;directive=can;line=7;index=0;target=glm-5.3-flash;can=active",
		);
		expect(parsePreferHeader(value)).toBe(value);
	});

	test("rejects prompt, path, newline and malformed field injection", () => {
		const base = {
			source: "dotfile",
			directive: "must",
			line: 1,
			index: 0,
			can: "absent",
		} as const;
		expect(
			encodePreferHeader({ ...base, target: "secret key here" }),
		).toBeNull();
		expect(
			encodePreferHeader({ ...base, target: "glm\nx-admin: yes" }),
		).toBeNull();
		expect(
			parsePreferHeader(
				"v=1;source=dotfile;directive=must;line=1;index=0;target=x;can=absent;token=secret",
			),
		).toBeNull();
	});
});
