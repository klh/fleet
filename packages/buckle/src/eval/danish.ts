// src/eval/danish.ts — the danish shape bucket. Answer keys are computed:
// number words come from the formatter below (digit→word and word→digit share
// it), and sentence/translation keys are assembled from the same lexicon rows
// that build the prompt. Lexicon anchors are pinned once here (corpus input),
// never per-task keys.
import {
	containsCheck,
	exactCheck,
	metaOf,
	numCheck,
	norm,
} from "./graders.ts";
import { makeRng, type Rng } from "./rng.ts";
import type { Task } from "./types.ts";

const ONES = [
	"nul",
	"en",
	"to",
	"tre",
	"fire",
	"fem",
	"seks",
	"syv",
	"otte",
	"ni",
] as const;
const TEENS = [
	"ti",
	"elleve",
	"tolv",
	"tretten",
	"fjorten",
	"femten",
	"seksten",
	"sytten",
	"atten",
	"nitten",
] as const;
// Danish counts in twenties: 50 halvtreds, 60 tres, 70 halvfjerds, 80 firs,
// 90 halvfems; 21-99 compounds unit-first (enogtyve, treoghalvtreds).
const TENS = [
	"",
	"",
	"tyve",
	"tredive",
	"fyrre",
	"halvtreds",
	"tres",
	"halvfjerds",
	"firs",
	"halvfems",
] as const;

export function danishNumber(n: number): string {
	if (!Number.isInteger(n) || n < 0 || n > 99) {
		throw new Error(`danishNumber: out of range ${String(n)}`);
	}
	if (n < 10) return ONES[n] as string;
	if (n < 20) return TEENS[n - 10] as string;
	const t = Math.floor(n / 10);
	const u = n % 10;
	if (u === 0) return TENS[t] as string;
	return `${ONES[u] as string}og${TENS[t] as string}`;
}

// ── lexicon (fixed singular→plural + Danish→English anchors) ──
interface Noun {
	da: string; // Danish plural form as used in templates
	en: string; // English plural
}
const NOUNS: Noun[] = [
	{ da: "æbler", en: "apples" },
	{ da: "bøger", en: "books" },
	{ da: "kopper", en: "cups" },
	{ da: "biler", en: "cars" },
	{ da: "cykler", en: "bicycles" },
	{ da: "blyanter", en: "pencils" },
];
const NAMES = [
	"Klaus",
	"Mette",
	"Søren",
	"Anna",
	"Lars",
	"Freja",
	"Emil",
	"Ida",
] as const;
const CITIES = [
	"Aarhus",
	"Odense",
	"Aalborg",
	"Esbjerg",
	"Randers",
	"Kolding",
	"Herning",
	"Roskilde",
] as const;
const VERBS = ["købte", "fandt", "mistede", "solgte", "talte"] as const;

const EN_NUMBERS: Record<string, string> = {
	"0": "zero",
	"1": "one",
	"2": "two",
	"3": "three",
	"4": "four",
	"5": "five",
	"6": "six",
	"7": "seven",
	"8": "eight",
	"9": "nine",
	"10": "ten",
	"11": "eleven",
	"12": "twelve",
	"13": "thirteen",
	"14": "fourteen",
	"15": "fifteen",
	"16": "sixteen",
	"17": "seventeen",
	"18": "eighteen",
	"19": "nineteen",
	"20": "twenty",
};

const replyDa = (what: string): string => `Svar med kun ${what}.`;

// ── families ──

/** Family word2digit: given a Danish number word, reply with the digits. */
function word2digit(rng: Rng, i: number): Task {
	const n = 1 + rng.int(99);
	const word = danishNumber(n);
	return {
		id: `danish-w2d-${String(i)}`,
		shape: "danish",
		system: "Du er en hjælpsom assistent der svarer kort og præcist.",
		prompt: `Skriv tallet som cifre: "${word}"\n${replyDa("tallet i cifre")}`,
		key: String(n),
		check: numCheck(n),
		meta: metaOf("word2digit", { n }),
	};
}

/** Family digit2word: given digits, reply with the Danish number word. */
function digit2word(rng: Rng, i: number): Task {
	const n = 1 + rng.int(99);
	return {
		id: `danish-d2w-${String(i)}`,
		shape: "danish",
		system: "Du er en hjælpsom assistent der svarer kort og præcist.",
		prompt: `Skriv tallet ${String(n)} med bogstaver (ét dansk ord).\n${replyDa("det danske talord")}`,
		key: danishNumber(n),
		check: (answer) => norm(answer).replace(/\s/g, "") === danishNumber(n),
		meta: metaOf("digit2word", { n }),
	};
}

/** Family slot-extract: who/what/how-many question over a generated sentence. */
function slotExtract(rng: Rng, i: number): Task {
	const variant = rng.int(3);
	const name = rng.pick(NAMES);
	const city = rng.pick(CITIES);
	const verb = rng.pick(VERBS);
	const noun = rng.pick(NOUNS);
	const count = 2 + rng.int(20);
	const sentence = `${name} ${verb} ${String(count)} ${noun.da} i ${city}.`;
	if (variant === 0) {
		return {
			id: `danish-slot-${String(i)}`,
			shape: "danish",
			system: "Du er en hjælpsom assistent der svarer kort og præcist.",
			prompt: `${sentence}\nHvor mange ${noun.da} ${verb} ${name}? ${replyDa("tallet")}`,
			key: String(count),
			check: numCheck(count),
			meta: metaOf("slot-count"),
		};
	}
	if (variant === 1) {
		return {
			id: `danish-slot-${String(i)}`,
			shape: "danish",
			system: "Du er en hjælpsom assistent der svarer kort og præcist.",
			prompt: `${sentence}\nHvad ${verb} ${name}? ${replyDa("ét ord — substantivet")}`,
			key: noun.da,
			check: containsCheck(noun.da),
			meta: metaOf("slot-noun"),
		};
	}
	return {
		id: `danish-slot-${String(i)}`,
		shape: "danish",
		system: "Du er en hjælpsom assistent der svarer kort og præcist.",
		prompt: `${sentence}\nHvor ${verb} ${name} dem? ${replyDa("byens navn")}`,
		key: city,
		check: containsCheck(city),
		meta: metaOf("slot-city"),
	};
}

/** Family translate: template sentence → English, key assembled from the
 *  same lexicon row. Count accepted as word or digit. */
function translate(rng: Rng, i: number): Task {
	const name = rng.pick(NAMES);
	const noun = rng.pick(NOUNS);
	const count = rng.int(21);
	const da = `${name} har ${danishNumber(count)} ${noun.da}.`;
	const num = EN_NUMBERS[String(count)] ?? String(count);
	const key = `${name} has ${num} ${noun.en}`;
	return {
		id: `danish-tr-${String(i)}`,
		shape: "danish",
		system: "You are a helpful assistant that answers briefly.",
		prompt: `Oversæt til engelsk:\n"${da}"\n${replyDa("den engelske sætning")}`,
		key,
		check: (answer) => {
			const a = norm(answer)
				.replace(/^["'`]+|["'`]+$/g, "")
				.replace(/\.$/u, "");
			const numDigit = a.replace(
				new RegExp(`\\b${num}\\b`, "u"),
				String(count),
			);
			return (
				a === norm(key) ||
				numDigit === norm(`${name} has ${String(count)} ${noun.en}`)
			);
		},
		meta: metaOf("translate", { count }),
	};
}

/** Family next-weekday: the day after a named weekday (fixed order). */
function nextWeekday(rng: Rng, i: number): Task {
	const DAYS = [
		"mandag",
		"tirsdag",
		"onsdag",
		"torsdag",
		"fredag",
		"lørdag",
		"søndag",
	] as const;
	const k = rng.int(7);
	const next = (k + 1) % 7;
	return {
		id: `danish-day-${String(i)}`,
		shape: "danish",
		system: "Du er en hjælpsom assistent der svarer kort og præcist.",
		prompt: `Hvilken dag kommer efter ${DAYS[k] as string}? ${replyDa("ugedagen")}`,
		key: DAYS[next] as string,
		check: exactCheck(DAYS[next] as string),
		meta: metaOf("next-weekday"),
	};
}

const FAMILIES = [word2digit, digit2word, slotExtract, translate, nextWeekday];

export function makeDanishTasks(n: number, seed: number): Task[] {
	const rng = makeRng(seed);
	return Array.from({ length: n }, (_, i) =>
		(FAMILIES[i % FAMILIES.length] as typeof word2digit)(rng, i),
	);
}
