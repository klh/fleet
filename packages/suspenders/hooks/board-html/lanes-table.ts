// hooks/board-html/lanes-table.ts — W2269.2: the #lanes per-lane table view
// (the owner directive 2026-11-06: #lanes renders the W892 lanes table, not
// the W65 kanban). Renders FROM /api/lanes-table (lanes-face.ts → the SAME
// reportRows/buildReportContract spine + the SAME exported cell helpers the
// CLI table uses — pre-formatted cells ride the contract, this chunk never
// re-implements a cell). Card board stays reachable behind the toggle
// (#lanes?view=cards) — the kanban specs pin it. DOM rides the chunk sinks
// (sigSet + esc) per the UI law; glyph+word cells, `—` = unreported.
export const LANES_TABLE = String.raw`// --- W2269.2: the per-lane W892 table (#lanes default view) ---
var lanesData = null; var lanesOkAt = 0; var lanesErr = null;
var lanesView = (function(){ try { return localStorage.getItem('sb.lanesView') === 'cards' ? 'cards' : 'table'; } catch (e) { return 'table'; } })();
function paintLanesView(){
  var cards = lanesView === 'cards';
  var tog = byId('lanesViewToggle');
  if (tog) tog.setAttribute('aria-pressed', String(cards));
  var tw = byId('lanesTableWrap');
  if (tw) tw.hidden = cards;
  var kn = byId('kstatusnav');
  if (kn) kn.hidden = !cards;
  var kw = document.querySelector('#tab-lanes .kwrap');
  if (kw) kw.hidden = !cards;
}
function setLanesView(v, persist){
  lanesView = v;
  if (persist) { try { localStorage.setItem('sb.lanesView', v); } catch (e) {} }
  paintLanesView();
  if (v === 'cards') renderKanban();
  else feeds.kick('lanesTable', true);
}
function lanesRowText(l){
  var it = l.item || {};
  return [l.sid, l.name, it.id, it.title, (l.cells && l.cells.model) || it.model];
}
function renderLanesTable(){
  if (curTab !== 'lanes' || lanesView === 'cards') return;
  var el = byId('lanesTable');
  if (!el) return;
  if (lanesErr && !lanesData) { sigSet(el, 'err', '<div class="state dim">lanes table unavailable — ' + esc(String(lanesErr)) + '</div>'); return; }
  if (!lanesData) return;
  var ls = lanesData.lanes || [];
  var lf = lanesData.launch_failures || { lanes: 0, worst_attempts: 0 };
  setText(byId('lanesStamp'), ls.length + ' lanes' + (lf.lanes ? ' · ' + lf.lanes + ' launch-failed (worst ×' + lf.worst_attempts + ')' : '') + ' · checked ' + ago(msAgo(lanesOkAt)));
  var shown = ls.filter(function(l){ var t = lanesRowText(l); return (!hashFilter || hashMatch(t)) && (!boardQuery || boardMatch(t)); });
  if (!shown.length) { sigSet(el, 'empty', '<div class="state dim">no lanes in scope</div>'); return; }
  var sig = shown.map(function(l){ var it = l.item || {}; return [l.sid, it.id, it.glyph, l.verdict, l.degraded ? 1 : 0, l.cells ? l.cells.launch : ''].join('\u0001'); }).join('|');
  var secs = lanesData.sections || {};
  var html = '<table class="ltbl"><thead><tr><th scope="col">LANE</th><th scope="col">ITEM</th><th scope="col">ST</th><th scope="col">TASK</th><th scope="col">TOKENS</th><th scope="col">OUT/MIN</th><th scope="col">MODEL</th><th scope="col">EFFORT</th><th scope="col">CONSULT</th></tr></thead><tbody>';
  var lastSec = '';
  shown.forEach(function(l){
    var it = l.item || {}; var c = l.cells || {};
    if (it.section && it.section !== lastSec) {
      lastSec = it.section;
      html += '<tr class="lsec"><td colspan="9">' + esc(lanesSectionLabel(it.section)) + ' · ' + (secs[it.section] != null ? secs[it.section] : '') + '</td></tr>';
    }
    var tip = (l.sid || '') + (l.verdict ? ' · ' + l.verdict : '') + (l.name ? ' · ' + l.name : '');
    html += '<tr class="lrow' + (l.degraded ? ' degraded' : '') + '" data-task="' + esc(it.id || '') + '" data-proj="' + esc(lanesData.project || '') + '" title="' + esc(it.best_action || it.title || '') + '">' +
      '<td class="llane" title="' + esc(tip) + '">' + esc(c.sid || '—') + (c.launch ? ' <span class="lchip">' + esc(c.launch) + '</span>' : '') + '</td>' +
      '<td class="litem">' + esc(c.item || it.id || '') + '</td>' +
      '<td class="lst">' + esc(c.st || '') + '</td>' +
      '<td class="ltask">' + esc(c.task || '') + '</td>' +
      '<td class="lnum">' + esc(c.tokens || '—') + '</td>' +
      '<td class="lnum">' + esc(c.out_min || '—') + '</td>' +
      '<td class="lmodel">' + esc(c.model || '—') + '</td>' +
      '<td>' + esc(c.effort || '—') + '</td>' +
      '<td>' + esc(c.consult || '—') + '</td>' +
      '</tr>';
  });
  html += '</tbody></table>';
  sigSet(el, sig, html);
}
function lanesSectionLabel(s){
  if (s === 'needs_you') return 'needs you';
  if (s === 'done') return 'recent done';
  return s;
}
byId('lanesViewToggle').addEventListener('click', function(){ setLanesView(lanesView === 'cards' ? 'table' : 'cards', true); });
byId('lanesTable').addEventListener('click', function(e){
  var b = e.target.closest && e.target.closest('tr[data-task]');
  if (b) openTask(b.getAttribute('data-task'), b.getAttribute('data-proj'), b);
});
paintLanesView();
`;
