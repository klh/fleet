// hooks/board-html/orch.ts — orchestrate box (W157 client chunk).
// String.raw matches the original single-template semantics; bun's
// non-ASCII escaping in String.raw reproduces the served page bytes.
// biome-ignore lint/complexity/noUselessStringRaw: byte-compat (W157)
export const ORCH = String.raw`// --- W57 orchestrate box: LLM proposes a plan + parallel children from a
// goal; the human registers it as a plan-gated work split (POST
// /api/orchestrate → /api/orchestrate/register). Target = the global project
// filter; the proposal is read-only until registered.
var orch = { busy: false, regBusy: false, err: null, prop: null, model: '', ms: 0, proj: '' };
var orchDraftKey = 'fleet.orchestrate.draft.v1';
function orchSaveDraft(){
  try {
    var goal = byId('orchGoal').value;
    if (!goal.trim() && !orch.prop) { localStorage.removeItem(orchDraftKey); return; }
    localStorage.setItem(orchDraftKey, JSON.stringify({ goal: goal, project: orch.proj || orchProject(), proposal: orch.prop, model: orch.model, ms: orch.ms }));
  } catch (e) { /* storage may be disabled; orchestration still works */ }
}
function orchRestoreDraft(){
  try {
    var raw = localStorage.getItem(orchDraftKey);
    if (!raw) return;
    var saved = JSON.parse(raw);
    if (!saved || typeof saved.goal !== 'string') return;
    byId('orchGoal').value = saved.goal;
    if (saved.proposal && typeof saved.proposal.title === 'string' && Array.isArray(saved.proposal.children) && typeof saved.project === 'string') {
      orch.prop = saved.proposal; orch.proj = saved.project; orch.model = saved.model || ''; orch.ms = saved.ms || 0;
    }
    renderOrch();
  } catch (e) { /* an invalid draft does not block the board */ }
}
var orchCtx = null; // {id, project, route, targets, loading, sent}
// W163 composer suggest: draft -> brief-shaped prompt via /api/suggest
var sugg = { busy: false };
// W858.8 drop attachments: browser Files ride the upload (a browser File has
// no reusable local path — the bytes go up, never a path string); the board
// stores them bounded+private+expiring and hands back exact resolvable refs
var drop = { files: [], busy: false, err: null };
function orchBytes(n){
  return n >= 1048576 ? (n/1048576).toFixed(1) + ' MB' : n >= 1024 ? (n/1024).toFixed(1) + ' KB' : n + ' B';
}
function renderDrop(){
  var el = byId('orchFiles');
  if (!el) return;
  var sig = drop.files.map(function(f){ return f.url + '|' + f.name; }).join(';') + '|' + drop.busy;
  var h = '';
  for (var i = 0; i < drop.files.length; i++) {
    var f = drop.files[i];
    h += '<div class="orchfile">' +
      '<span class="orchfname">' + esc(f.name) + '</span>' +
      '<span class="dim">' + orchBytes(f.size) + '</span>' +
      '<a class="orchfref" href="' + esc(f.url) + '">' + esc(f.url) + '</a>' +
      '<button type="button" class="orchfremove" data-url="' + esc(f.url) + '" aria-label="remove attachment">remove</button>' +
      '</div>';
  }
  if (drop.busy) h += '<div class="dim">attaching…</div>';
  sigSet(el, sig, h);
}
function orchDropErr(msg){
  var el = byId('orchDropErr');
  if (!el) return;
  drop.err = msg ? String(msg) : null;
  if (drop.err) errBanner(el, drop.err, function(){ orchDropErr(null); });
  else clearErr(el);
}
function orchClearFiles(){
  drop.files = [];
  drop.err = null;
  renderDrop();
  orchDropErr(null);
}
// the bytes ride a multipart POST — never file.path (a browser File has no
// reusable local path); refs land in drop.files and render with exact links
function orchUpload(list){
  if (drop.busy || !list || !list.length) return;
  var files = Array.prototype.slice.call(list).slice(0, 8);
  if (!files.length) return;
  drop.busy = true; orchDropErr(null);
  renderDrop();
  var fd = new FormData();
  for (var i = 0; i < files.length; i++) fd.append('files', files[i], files[i].name);
  fetch('/api/orchestrate/files', { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) })
    .then(function(r){ return r.json().catch(function(){ return {}; }); })
    .then(function(j){
      drop.busy = false;
      if (j && j.ok && j.files) {
        var byName = {};
        for (var i = 0; i < j.files.length; i++) byName[j.files[i].name] = j.files[i].url;
        for (var i = 0; i < files.length; i++) {
          var u = byName[files[i].name];
          if (u && !drop.files.some(function(f){ return f.url === u; })) {
            drop.files.push({ url: u, name: files[i].name, size: files[i].size });
          }
        }
      } else {
        orchDropErr(String((j && j.error) || 'attach failed (HTTP ' + (j && j.status) + ')'));
      }
      renderDrop();
    })
    .catch(function(e){ drop.busy = false; orchDropErr(String((e && e.message) || e)); renderDrop(); });
}
function orchProject(){
  var v = sel.value;
  return v && v !== 'all' ? v : null;
}
function renderOrch(){
	var host = byId('orch');
	if (host && (orch.busy || orch.regBusy || orch.prop || orch.err || orchCtx)) host.open = true;
  renderOrchContext();
  var errEl = byId('orchErr');
  if (orch.err) errBanner(errEl, orch.err, function(){ orch.err = null; renderOrch(); });
  else clearErr(errEl);
  var go = byId('orchGo');
  if (go) {
    go.disabled = orch.busy || !!(orchCtx && (orchCtx.loading || !orchCtx.targets || !orchCtx.targets[orchCtx.route]));
    setText(go, orch.busy ? (orchCtx ? 'sending…' : 'proposing…') : (orchCtx ? 'send to ' + orchCtx.route : 'orchestrate'));
  }
  var sb = byId('orchSuggest');
  if (sb) { sb.disabled = sugg.busy; setText(sb, sugg.busy ? 'suggesting…' : 'suggest'); }
  var out = byId('orchOut');
  if (!out) return;
  if (!orch.prop) { sigSet(out, 'idle', ''); return; }
  var h = '<div class="orchplan">';
  h += '<div class="orchtitle">' + esc(orch.prop.title) + '</div>';
  h += '<div class="orchmeta dim">proposed by ' + esc(orch.model || 'llm') + ' in ' + (orch.ms/1000).toFixed(1) + 's · ' + esc(projShort(orch.proj)) + '</div>';
  for (var i = 0; i < orch.prop.children.length; i++) {
    var c = orch.prop.children[i];
    h += '<div class="orchkid"><span class="orchkidn">' + (i+1) + '.</span> ' + esc(c.title) +
      (c.brief ? '<div class="orchbrief dim">' + esc(c.brief) + '</div>' : '') + '</div>';
  }
  h += '<div class="orchactions">' +
    '<span class="dim">Draft proposal · no tasks created yet</span> ' +
    '<button type="button" class="kstart" id="orchReg">create tasks from plan</button> ' +
    '<button type="button" class="orchdisc" id="orchDisc">discard</button></div></div>';
  sigSet(out, JSON.stringify(orch.prop) + orch.busy + orch.regBusy, h);
}
function renderOrchContext(){
  var row = byId('orchContext'), pp = byId('orchPreview');
  if (!row) return;
  row.hidden = !orchCtx;
  if (pp) pp.hidden = !!orchCtx;
  if (!orchCtx) return;
  setText(byId('orchWorkPill'), orchCtx.id + ' · ' + projShort(orchCtx.project));
  var selRoute = byId('orchRoute');
  for (var i = 0; i < selRoute.options.length; i++) {
    var opt = selRoute.options[i];
    opt.disabled = !orchCtx.targets || !orchCtx.targets[opt.value];
  }
  selRoute.value = orchCtx.route;
  setText(byId('orchDestination'), orchCtx.loading ? 'resolving recipient…' :
    (orchCtx.targets && orchCtx.targets[orchCtx.route] ? orchCtx.targets[orchCtx.route] : 'no recipient available') +
    (orchCtx.sent ? ' · ' + orchCtx.sent : ''));
}
function activateOrchForTask(id, project){
  if (!id || !project) return;
  var ctx = { id: id, project: project, route: 'lane', targets: null, loading: true, sent: '' };
  orchCtx = ctx; orch.err = null; orch.prop = null;
  var pp = byId('orchPreview'); if (pp && pp.clear) pp.clear();
  renderOrch();
  byId('orch').scrollIntoView({ behavior: 'smooth', block: 'start' });
  fetch('/api/orchestrate/targets?project=' + encodeURIComponent(project) + '&id=' + encodeURIComponent(id), { signal: AbortSignal.timeout(8000) })
    .then(function(r){ return r.json().then(function(j){ if (!r.ok || !j.ok) throw new Error(j.error || 'recipient lookup failed'); return j.targets; }); })
    .then(function(targets){
      if (orchCtx !== ctx) return;
      ctx.targets = targets; ctx.loading = false;
      ctx.route = targets.lane ? 'lane' : targets.parent ? 'parent' : 'supervisor';
      renderOrch(); byId('orchGoal').focus();
    })
    .catch(function(e){ if (orchCtx !== ctx) return; ctx.loading = false; orch.err = String(e); renderOrch(); });
}
function orchRouteMessage(goal){
  var ctx = orchCtx;
  if (!ctx || !ctx.targets || !ctx.targets[ctx.route]) { orch.err = 'no recipient for this work item'; renderOrch(); return; }
  if (goal.length > 2000) { orch.err = 'message exceeds 2000 characters'; renderOrch(); return; }
  orch.busy = true; orch.err = null; ctx.sent = ''; renderOrch();
  postJSON('/api/message', { id: ctx.id, project: ctx.project, target: ctx.route, note: goal })
    .then(function(j){
      if (orchCtx !== ctx) return;
      orch.busy = false;
      if (j && j.ok) { ctx.sent = 'sent'; byId('orchGoal').value = ''; }
      else orch.err = String((j && (j.error || j.output)) || 'send failed');
      renderOrch();
    })
    .catch(function(e){ if (orchCtx !== ctx) return; orch.busy = false; orch.err = String(e); renderOrch(); });
}
// W270 — debug/log mode previews the transformed prompt first; the preview
// element emits klh-dispatch ("dispatch anyway") to send it
function orchPreviewEl(){
  var pp = byId('orchPreview');
  return pp && pp.gated ? pp : null;
}
function doOrchestrate(){
  if (orch.busy || orch.regBusy) return;
  if (orchCtx) {
    var message = (byId('orchGoal').value || '').trim();
    if (!message) { orch.err = 'type a message first'; renderOrch(); return; }
    orchRouteMessage(message);
    return;
  }
  var proj = orchProject();
  if (!proj) { orch.err = 'pick a project in the header filter first'; orch.prop = null; renderOrch(); return; }
  var goal = (byId('orchGoal').value || '').trim();
  if (!goal) { orch.err = 'type a goal first'; renderOrch(); return; }
  var pp = orchPreviewEl();
  if (pp) {
    if (pp.ready(goal)) { pp.dispatch(); return; }
    orch.err = null; renderOrch();
    pp.prepare(proj, goal, drop.files.map(function(f){ return f.url; }));
    return;
  }
  orchSend(proj, goal, null);
}
function orchSend(proj, goal, previewId){
  if (orch.busy || orch.regBusy) return;
  orch.busy = true; orch.err = null; renderOrch();
  var status = 0;
  fetch('/api/orchestrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: proj, goal: goal, attachments: drop.files.map(function(f){ return f.url; }), previewId: previewId || undefined }), signal: AbortSignal.timeout(130000) })
    .then(function(r){ status = r.status; return r.json().catch(function(){ return {}; }); })
    .then(function(j){
      j = j || {};
      orch.busy = false;
      if (j.ok) {
        orch.prop = j.proposal; orch.model = j.model || ''; orch.ms = j.ms || 0; orch.proj = proj;
        orchClearFiles();
        orchSaveDraft();
      } else {
        orch.err = String(j.error || 'orchestrate failed (HTTP ' + status + ')');
      }
      renderOrch();
    })
    .catch(function(e){ orch.busy = false; orch.err = String((e && e.message) || e); renderOrch(); });
}
function orchReg(){
  if (!orch.prop || orch.busy || orch.regBusy) return;
  orch.regBusy = true;
  postJSON('/api/orchestrate/register', { project: orch.proj, title: orch.prop.title, children: orch.prop.children.map(function(c){ return { title: c.title }; }) }).then(function(j){
    orch.regBusy = false;
    if (j && j.ok) {
      toast('registered ' + j.plan + ' → ' + (j.children || []).length + ' children');
      orch.prop = null; byId('orchGoal').value = '';
      orchSaveDraft();
      orchClearFiles();
      var pp = byId('orchPreview'); if (pp && pp.clear) pp.clear();
      pollTasks();
    } else {
      orch.err = String((j && j.error) || 'register failed');
    }
    renderOrch();
  });
}
function orchDisc(){ if (orch.busy || orch.regBusy) return; orch.prop = null; orchSaveDraft(); renderOrch(); }
(function(){
  var host = byId('orch');
  if (host) {
    var hoverOpened = false;
    host.addEventListener('mouseenter', function(){
      if (!host.open) { host.open = true; hoverOpened = true; }
    });
    host.querySelector('summary').addEventListener('click', function(e){
      if (hoverOpened) { e.preventDefault(); hoverOpened = false; }
    });
    host.addEventListener('mouseleave', function(){
      hoverOpened = false;
      if (orch.busy || orch.regBusy || orch.prop || orch.err || orchCtx || byId('orchGoal').value.trim() || host.contains(document.activeElement)) return;
      host.open = false;
    });
  }
  var inp = byId('orchGoal');
  orchRestoreDraft();
  byId('orchRoute').addEventListener('change', function(e){ if (orchCtx) { orchCtx.route = e.target.value; orchCtx.sent = ''; renderOrch(); } });
  byId('orchClear').addEventListener('click', function(){ orchCtx = null; orch.err = null; byId('orchGoal').value = ''; renderOrch(); });
  if (inp) inp.addEventListener('keydown', function(e){ if (e.key === 'Enter') { e.preventDefault(); doOrchestrate(); } });
  if (inp) inp.addEventListener('input', function(){ var pp = byId('orchPreview'); if (pp && pp.clear) pp.clear(); orchSaveDraft(); });
  document.addEventListener('klh-dispatch', function(e){ var d = e.detail || {}; if (d.project && d.goal) orchSend(d.project, d.goal, d.previewId); });
  var go = byId('orchGo');
  if (go) go.addEventListener('click', doOrchestrate);
  // W858.8 dropzone: drag-drop or picker → multipart upload → refs render
  // with exact links; remove buttons DELETE the store entry
  var dz = byId('orchDrop');
  if (dz) {
    dz.addEventListener('dragover', function(e){ e.preventDefault(); dz.classList.add('drag'); });
    dz.addEventListener('dragleave', function(){ dz.classList.remove('drag'); });
    dz.addEventListener('drop', function(e){
      e.preventDefault(); dz.classList.remove('drag');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) orchUpload(e.dataTransfer.files);
    });
  }
  var pick = byId('orchPick');
  if (pick) pick.addEventListener('click', function(){ var inp = byId('orchFile'); if (inp) inp.click(); });
  var finp = byId('orchFile');
  if (finp) finp.addEventListener('change', function(){
    if (finp.files && finp.files.length) orchUpload(finp.files);
    finp.value = '';
  });
  document.addEventListener('click', function(e){
    var r = e.target.closest && e.target.closest('.orchfremove');
    if (r) {
      var url = r.getAttribute('data-url');
      drop.files = drop.files.filter(function(f){ return f.url !== url; });
      fetch(url, { method: 'DELETE', signal: AbortSignal.timeout(8000) }).catch(function(){});
      renderDrop();
    }
  });
  document.addEventListener('click', function(e){
    var t = e.target.closest && e.target.closest('#orchReg');
    if (t) { orchReg(); return; }
    var d = e.target.closest && e.target.closest('#orchDisc');
    if (d) orchDisc();
  });
})();

`;
