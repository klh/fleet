// Stable named exports; runtime browser assets stay entirely offline.
// W2269.1.2: render joins the set — the model-access leaf renders lit-html
// templates into the console's existing light-DOM #modelaccess container
// (the console's own CSS owns .access-seats/.access-vendor there).
export { css, html, LitElement, render, svg } from "lit";
