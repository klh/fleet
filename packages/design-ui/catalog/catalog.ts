// catalog.ts — W2269.1.1: catalog harness skeleton. Hosts each component
// next to its native prototype in light and dark; W2269.1.5 fills the deep
// catalog detail. DOM via createElement / replaceChildren only.
const swatch = (name: string): HTMLElement => {
	const cell = document.createElement("div");
	cell.className = "swatch";
	cell.title = name;
	const chip = document.createElement("div");
	chip.className = "chip";
	chip.style.background = `var(${name})`;
	const label = document.createElement("code");
	label.textContent = name;
	cell.append(chip, label);
	return cell;
};

const fill = (hostId: string): void => {
	const host = document.getElementById(hostId);
	if (!host) return;
	const names = JSON.parse(
		document.querySelector<HTMLScriptElement>("#token-names")?.textContent ??
			"[]",
	) as string[];
	host.replaceChildren(...names.map(swatch));
};

fill("swatches-dark");
fill("swatches-light");
