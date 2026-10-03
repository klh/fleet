// hooks/lib/theme.ts — W269: the klh dark/light theme layer, one source of
// truth for every suspenders GUI (board SPA, console pages, /usage) and the
// copy-verbatim reference for belt / klh-local dashboards (docs/theme-tokens.md).
//
// Contract: `data-theme="dark|light"` on <html> swaps a CSS custom-property
// token set — components never carry their own colors, only var(--klh-*).
// The user's preference (light | dark | system) persists in localStorage
// `klh-theme` (absent = system); system follows prefers-color-scheme. The
// pre-paint script runs in <head> before first render: no flash of wrong theme.

export type Theme = "dark" | "light";
export type ThemePref = Theme | "system";

export const THEME_KEY = "klh-theme";
export const THEME_PREFS: readonly ThemePref[] = ["light", "dark", "system"];

// token → [dark, light]. Dark is the board's historical palette, value for
// value; light is the same roles on a warm paper base.
export const TOKENS: Readonly<Record<string, readonly [string, string]>> = {
	"--klh-bg": ["#141413", "#f6f4ef"],
	"--klh-field": ["#121110", "#ffffff"],
	"--klh-panel": ["#171614", "#fbfaf7"],
	"--klh-surface": ["#1c1b19", "#ffffff"],
	"--klh-overlay": ["#1a1917", "#ffffff"],
	"--klh-surface-hi": ["#232220", "#ece9e2"],
	"--klh-ink": ["#e8e6e1", "#1c1b19"],
	"--klh-ink-2": ["#c3c2b7", "#3b3934"],
	"--klh-ink-3": ["#a5a29a", "#55524b"],
	"--klh-dim": ["#98958e", "#6b675f"],
	"--klh-accent": ["#d8900f", "#a86a00"],
	"--klh-on-accent": ["#141413", "#ffffff"],
	"--klh-accent-bg": ["#221f14", "#fbf1dc"],
	"--klh-accent-wash": ["rgba(216,144,15,.12)", "rgba(168,106,0,.10)"],
	"--klh-warm": ["#221f1c", "#f8efe4"],
	"--klh-danger": ["#af2f12", "#af2f12"],
	"--klh-danger-ink": ["#c96a4f", "#a3361a"],
	"--klh-danger-bg": ["#221512", "#fbe9e4"],
	"--klh-danger-edge": ["rgba(175,47,18,.6)", "rgba(175,47,18,.5)"],
	"--klh-danger-wash": ["rgba(175,47,18,.16)", "rgba(175,47,18,.10)"],
	"--klh-ok": ["#5c7a35", "#5c7a35"],
	"--klh-ok-ink": ["#7da652", "#3f6a1c"],
	"--klh-ok-hi": ["#a5c78a", "#35591a"],
	"--klh-ok-bg": ["#1a2015", "#eaf3e0"],
	"--klh-ok-wash": ["rgba(92,122,53,.18)", "rgba(92,122,53,.14)"],
	"--klh-info": ["#8cbbad", "#2f7a68"],
	"--klh-wash": ["rgba(255,255,255,.03)", "rgba(0,0,0,.025)"],
	"--klh-edge-faint": ["rgba(255,255,255,.07)", "rgba(0,0,0,.07)"],
	"--klh-edge-soft": ["rgba(255,255,255,.10)", "rgba(0,0,0,.10)"],
	"--klh-edge": ["rgba(255,255,255,.12)", "rgba(0,0,0,.13)"],
	"--klh-edge-mid": ["rgba(255,255,255,.18)", "rgba(0,0,0,.18)"],
	"--klh-edge-strong": ["rgba(255,255,255,.24)", "rgba(0,0,0,.24)"],
	"--klh-edge-hover": ["rgba(255,255,255,.4)", "rgba(0,0,0,.4)"],
	"--klh-rule": ["#2c2c2a", "#e2dfd8"],
	"--klh-shadow": ["rgba(0,0,0,.5)", "rgba(0,0,0,.14)"],
	"--klh-chart-grid": ["#2c2c2a", "#e2dfd8"],
	"--klh-chart-hair": ["#383835", "#cfcbc2"],
	"--klh-chart-axis": ["#898781", "#6b675f"],
};

export const isPref = (v: unknown): v is ThemePref =>
	v === "light" || v === "dark" || v === "system";

const block = (i: 0 | 1): string =>
	Object.entries(TOKENS)
		.map(([k, v]) => `${k}:${v[i]};`)
		.join("");

// Dark is the no-JS default (the historical look); the media block covers a
// light-preferring browser before/without the pre-paint script.
export const THEME_CSS = `:root,:root[data-theme="dark"]{color-scheme:dark;${block(0)}}:root[data-theme="light"]{color-scheme:light;${block(1)}}@media (prefers-color-scheme: light){:root:not([data-theme]){color-scheme:light;${block(1)}}}`;

// Pre-paint: resolves the stored pref BEFORE first render and exposes
// window.klhTheme {pref, resolve, apply, set}. Fires `klh-themechange` on
// document with detail {theme, pref} whenever the resolved theme is applied.
export const THEME_PREPAINT_JS = `(function(){var K="${THEME_KEY}",d=document.documentElement,mq=window.matchMedia?window.matchMedia("(prefers-color-scheme: light)"):null;
function pref(){var v=null;try{v=window.localStorage.getItem(K);}catch(e){}return v==="light"||v==="dark"?v:"system";}
function resolve(p){return p==="light"||p==="dark"?p:(mq&&mq.matches?"light":"dark");}
function apply(){var p=pref(),t=resolve(p);d.setAttribute("data-theme",t);d.setAttribute("data-theme-pref",p);
if(typeof CustomEvent==="function"&&document.dispatchEvent)document.dispatchEvent(new CustomEvent("klh-themechange",{detail:{theme:t,pref:p}}));return t;}
function set(p){try{if(p==="light"||p==="dark")window.localStorage.setItem(K,p);else window.localStorage.removeItem(K);}catch(e){}return apply();}
apply();
if(mq){var on=function(){if(pref()==="system")apply();};if(mq.addEventListener)mq.addEventListener("change",on);else if(mq.addListener)mq.addListener(on);}
if(window.addEventListener)window.addEventListener("storage",function(e){if(e.key===K)apply();});
window.klhTheme={pref:pref,resolve:resolve,apply:apply,set:set};})();`;

// Everything a page needs in <head>: tokens + pre-paint, in that order.
export const THEME_HEAD = `<style id="klh-theme-tokens">${THEME_CSS}</style><script>${THEME_PREPAINT_JS}</script>`;

// ─── settings region (gear → panel) ───────────────────────────────────────
// Native <details> disclosure: no framework, keyboard-reachable for free.
// Other klh GUIs copy this markup + THEME_SETTINGS_JS + THEME_SETTINGS_CSS
// verbatim and add their own fieldsets below the theme one.
const GEAR =
	'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/></svg>';

const themeRadio = (p: ThemePref): string =>
	`<label><input type="radio" name="${THEME_KEY}" value="${p}"${p === "system" ? " checked" : ""}> ${p}</label>`;

export const settingsBlock = (extra = ""): string =>
	`<details class="klh-settings" id="klh-settings"><summary aria-label="settings" title="settings">${GEAR}</summary><div class="klh-settings-panel" role="group" aria-label="settings"><fieldset class="klh-theme"><legend>theme</legend>${THEME_PREFS.map(themeRadio).join("")}</fieldset>${extra}</div></details>`;

export const THEME_SETTINGS_CSS = `.klh-settings{position:relative;}
.klh-settings>summary{list-style:none;cursor:pointer;color:var(--klh-dim);display:flex;padding:2px;border-radius:2px;}
.klh-settings>summary::-webkit-details-marker{display:none;}
.klh-settings>summary:hover,.klh-settings[open]>summary{color:var(--klh-accent);}
.klh-settings-panel{position:absolute;right:0;top:28px;width:220px;background:var(--klh-surface);border:1px solid var(--klh-edge);border-radius:3px;padding:10px 12px;box-shadow:0 4px 18px var(--klh-shadow);z-index:60;font-size:12px;color:var(--klh-ink);}
.klh-settings-panel fieldset{border:none;margin:0 0 8px;padding:0;}
.klh-settings-panel legend{font-size:10px;color:var(--klh-dim);text-transform:uppercase;letter-spacing:.06em;padding:0;margin-bottom:4px;}
.klh-settings-panel label{display:flex;align-items:center;gap:6px;padding:2px 0;cursor:pointer;}
.klh-settings-panel input[type=radio]{accent-color:var(--klh-accent);margin:0;}
.klh-settings-panel a{color:var(--klh-accent);font-size:11px;text-decoration:none;}
.klh-settings-panel a:hover{text-decoration:underline;}
.klh-settings-panel a[aria-current]{color:var(--klh-ink);}`;

// Binds the radios to window.klhTheme (set by the pre-paint script); closes
// the panel on outside click / Escape. No DOM construction, no innerHTML.
export const THEME_SETTINGS_JS = `(function(){var box=document.getElementById("klh-settings");if(!box||!window.klhTheme)return;
var radios=box.querySelectorAll('input[name="${THEME_KEY}"]');
function sync(){var p=window.klhTheme.pref();for(var i=0;i<radios.length;i++)radios[i].checked=radios[i].value===p;}
for(var i=0;i<radios.length;i++)radios[i].addEventListener("change",function(e){window.klhTheme.set(e.target.value);});
document.addEventListener("klh-themechange",sync);sync();
document.addEventListener("click",function(e){if(box.open&&e.target instanceof Node&&!box.contains(e.target))box.open=false;});
document.addEventListener("keydown",function(e){if(box.open&&e.key==="Escape"){box.open=false;var s=box.querySelector("summary");if(s)s.focus();}});})();`;
