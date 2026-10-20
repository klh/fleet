// hooks/board-html/boot.ts — boot (W157 client chunk).
// String.raw matches the original single-template semantics; bun's
// non-ASCII escaping in String.raw reproduces the served page bytes.
// biome-ignore lint/complexity/noUselessStringRaw: byte-compat (W157)
export const BOOT = String.raw`function renderAll(){
  renderConn();
  renderFleet();
  renderDecisions();
  renderTab();
}
function setCollapsed(v){
  decCollapsed = v;
  renderDecisions();
}
setInterval(tick, 1000);
pollExecutors(); // belt targets for the dispatch dropdown (page-load, not polled)
if (!location.hash) history.replaceState(null, '', '#decisions');
setTab(TABS[parseHashQuery(location.hash).tab] ? parseHashQuery(location.hash).tab : 'decisions', true);
applyHashRoute(); // W890: query-style tab hashes (#lanes?w=<id>, ?project=, ?q=) on first paint
applyHashFilter(); // honor #filter=<text> on first paint (deep-link from the statusline)
applyHashTask(); // honor #task=<id> on first paint (lane reports, terminal links)
tick();
renderAll();
</script></body></html>`;
