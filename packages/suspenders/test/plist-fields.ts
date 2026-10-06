// test/plist-fields.ts — minimal plist-XML field reader shared by the
// services-manifest tests (W488.1) and the installer launchd parity test
// (W490.2). No XML dep in the workspace: strips comments, tokenizes the
// value forms these units use, recursive-descent parses dict/array.
// Comments/whitespace/DOCTYPE ignored — field parsing only.
export type PlistVal =
	| string
	| number
	| boolean
	| PlistVal[]
	| { [k: string]: PlistVal };

function decodeEntities(s: string): string {
	return s
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&amp;", "&");
}

export function parsePlistXml(xml: string): { [k: string]: PlistVal } {
	const clean = xml.replace(/<!--[\s\S]*?-->/g, "");
	const tokenRe =
		/<plist[^>]*>|<\/plist>|<key>[\s\S]*?<\/key>|<string>[\s\S]*?<\/string>|<integer>[\s\S]*?<\/integer>|<true\/>|<false\/>|<array>|<\/array>|<dict>|<\/dict>/g;
	const tokens: string[] = [...clean.matchAll(tokenRe)].map((m) => m[0]);
	let i = 0;
	const peek = (): string | undefined => tokens[i];
	function parseValue(): PlistVal {
		const t = tokens[i];
		i += 1;
		if (t === undefined) throw new Error("plist truncated");
		if (t.startsWith("<string>")) return decodeEntities(t.slice(8, -9));
		if (t.startsWith("<integer>")) return Number.parseInt(t.slice(9, -10), 10);
		if (t === "<true/>") return true;
		if (t === "<false/>") return false;
		if (t === "<array>") {
			const arr: PlistVal[] = [];
			while (peek() !== "</array>") arr.push(parseValue());
			i += 1;
			return arr;
		}
		if (t === "<dict>") {
			const d: { [k: string]: PlistVal } = {};
			while (peek() !== "</dict>") {
				const kt = tokens[i];
				i += 1;
				if (kt === undefined || !kt.startsWith("<key>"))
					throw new Error(`expected <key>, got ${kt ?? "EOF"}`);
				const key = decodeEntities(kt.slice(5, -6));
				d[key] = parseValue();
			}
			i += 1;
			return d;
		}
		throw new Error(`unexpected plist token: ${t}`);
	}
	while (tokens[i] !== undefined && !tokens[i].startsWith("<plist")) i += 1;
	i += 1; // step past <plist ...>
	const root = parseValue();
	if (
		typeof root !== "object" ||
		Array.isArray(root) ||
		typeof root === "string" ||
		typeof root === "boolean" ||
		typeof root === "number"
	) {
		throw new Error("plist root is not a dict");
	}
	return root;
}

/** The launchd fields the installers must agree on, order/format-insensitive. */
export interface Flat {
	label: string;
	programArguments: string[];
	workingDirectory: string | null;
	environmentVariables: { [k: string]: string } | null;
	keepAlive: boolean;
	runAtLoad: boolean;
	startInterval: number | null;
	calendarHour: number | null;
	calendarMinute: number | null;
	throttleInterval: number | null;
	nice: number | null;
	standardOutPath: string;
	standardErrorPath: string;
}

export function project(d: { [k: string]: PlistVal }): Flat {
	const cal = d.StartCalendarInterval;
	const calDict =
		typeof cal === "object" && cal !== null && !Array.isArray(cal)
			? cal
			: undefined;
	const env = d.EnvironmentVariables;
	return {
		label: d.Label as string,
		programArguments: d.ProgramArguments as string[],
		workingDirectory: (d.WorkingDirectory as string) ?? null,
		environmentVariables: (typeof env === "object" &&
		env !== null &&
		!Array.isArray(env)
			? env
			: null) as { [k: string]: string } | null,
		keepAlive: d.KeepAlive === true,
		runAtLoad: d.RunAtLoad === true,
		startInterval: (d.StartInterval as number) ?? null,
		calendarHour: (calDict?.Hour as number) ?? null,
		calendarMinute: (calDict?.Minute as number) ?? null,
		throttleInterval: (d.ThrottleInterval as number) ?? null,
		nice: (d.Nice as number) ?? null,
		standardOutPath: d.StandardOutPath as string,
		standardErrorPath: d.StandardErrorPath as string,
	};
}
