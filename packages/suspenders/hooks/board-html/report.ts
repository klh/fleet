// hooks/board-html/report.ts — W1198 live agent-status tab (W157 client
// chunk). String.raw matches the single-template semantics; the pane shows
// THE work-report table verbatim (the CLI renderer's bytes) plus per-row
// expand: lane tail + last event, refetched on a 30s cadence while open.
// DOM rides the chunk sinks (sigSet + esc) per the UI law.
export const REPORT = String.raw`// --- W1198: live work-report pane ---
var reportData = null; var reportOkAt = 0; var reportErr = null; var reportBusy = false;
var reportOpen = null; var reportDetail = null; var reportDetailBusy = false; var reportDetailErr = null;
var reportTimer = null;
function pollReport(){
  if (curTab !== 'report') { if (reportTimer) closeReportRow(); return; }
  if (reportBusy) return;
  reportBusy = true;
  var scope = projQuery();
  fetch('/api/report' + scope, { signal: AbortSignal.timeout(8000) })
    .then(function(r){ if (!r.ok) throw Error('HTTP ' + r.status); return r.json(); })
    .then(function(j){
      if (scope !== projQuery()) return;
      reportData = j; reportOkAt = Date.now(); reportErr = null;
    })
    .catch(function(e){ if (scope === projQuery()) reportErr = String(e.message || e); })
    .finally(function(){ reportBusy = false; renderReport(); });
}
function renderReport(){
  var err = byId('reportErr');
  if (reportErr) { errBanner(err, reportErr, pollReport); return; }
  clearErr(err);
  if (!reportData) return;
  setText(byId('reportStamp'), 'the work report · checked ' + ago(msAgo(reportOkAt)) + ' · ' + ((reportData.rows || []).length) + ' rows');
  setText(byId('reportTable'), reportData.table || '(no rows)');
  var rows = reportData.rows || [];
  var sig = rows.map(function(r){ return r.id + '\u0001' + r.st; }).join('|');
  var html = '';
  rows.forEach(function(r){
    html += '<button type="button" class="rptrow' + (reportOpen === r.id ? ' on' : '') + '" data-rid="' + esc(r.id) + '" title="' + esc(r.title) + '">' + esc(r.id + ' ' + r.st) + '</button>';
  });
  sigSet(byId('reportRows'), sig, html);
  renderReportDetail();
}
function reportRowEls(){
  return byId('reportRows').querySelectorAll('[data-rid]');
}
function paintReportOpen(){
  var els = reportRowEls();
  for (var i = 0; i < els.length; i++) {
    var on = els[i].getAttribute('data-rid') === reportOpen;
    if (els[i].classList.contains('on') !== on) els[i].classList.toggle('on', on);
  }
  renderReportDetail();
}
function renderReportDetail(){
  var box = byId('reportDetail');
  if (!reportOpen) { sigSet(box, '', ''); return; }
  var loading = reportDetail == null && !reportDetailErr && reportDetailBusy;
  var stamp = reportOpen + ':' + (reportDetail ? reportDetail.ts : '') + ':' + (reportDetailErr || '');
  if (loading) { sigSet(box, 'loading', 'loading row detail...'); return; }
  var head = '';
  if (reportDetailErr) head = 'row unavailable: ' + esc(reportDetailErr);
  else if (reportDetail) head = esc(reportDetail.id) + ' · ' + esc(String(reportDetail.state).toLowerCase()) + (reportDetail.ownerSid ? ' · lane ' + esc(reportDetail.ownerSid) : '') + (reportDetail.lastEventTs ? ' · last event ' + ago(msAgo(reportDetail.lastEventTs)) : ' · no events yet');
  var html = '<div class="rpthead">' + head + '</div>';
  var tail = (reportDetail && reportDetail.laneTail) || [];
  if (tail.length) {
    html += '<div class="rpttail">';
    tail.forEach(function(l){
      html += '<div class="trow">' + esc(l.ts ? '[' + l.ts + '] ' + l.text : l.text) + '</div>';
    });
    html += '</div>';
  } else if (!reportDetailErr) {
    html += '<div class="dim">no live lane transcript for this row</div>';
  }
  sigSet(box, stamp, html);
}
function closeReportRow(){
  reportOpen = null; reportDetail = null; reportDetailErr = null;
  if (reportTimer) { clearInterval(reportTimer); reportTimer = null; }
  renderReportDetail();
  paintReportOpen();
}
function openReportRow(id){
  reportOpen = id; reportDetail = null; reportDetailErr = null;
  if (reportTimer) clearInterval(reportTimer);
  fetchReportDetail();
  // W1198 bounded fallback: one row, 30s, only while expanded — the W663
  // class never fans out per-sid.
  reportTimer = setInterval(fetchReportDetail, 30000);
  paintReportOpen();
}
function fetchReportDetail(){
  if (reportDetailBusy || !reportOpen) return;
  reportDetailBusy = true;
  var project = sel.value && sel.value !== 'all' ? sel.value : (reportData ? reportData.project : '');
  fetch('/api/report-row?project=' + encodeURIComponent(project) + '&id=' + encodeURIComponent(reportOpen), { signal: AbortSignal.timeout(8000) })
    .then(function(r){ if (!r.ok) throw Error('HTTP ' + r.status); return r.json(); })
    .then(function(j){ if (j.ok === false) throw Error(j.error || 'row not found'); reportDetail = j; reportDetailErr = null; })
    .catch(function(e){ reportDetailErr = String(e.message || e); })
    .finally(function(){ reportDetailBusy = false; renderReportDetail(); });
}
byId('reportRows').addEventListener('click', function(e){
  var b = e.target.closest && e.target.closest('[data-rid]');
  if (!b) return;
  if (reportOpen === b.getAttribute('data-rid')) closeReportRow();
  else openReportRow(b.getAttribute('data-rid'));
});
`;
