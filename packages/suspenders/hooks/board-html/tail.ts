// hooks/board-html/tail.ts — live lane tail (W157 client chunk).
// String.raw matches the original single-template semantics; bun's
// non-ASCII escaping in String.raw reproduces the served page bytes.
export const TAIL = String.raw`// --- 4d: live lane tail + message-to-lane (W76, /api/tail + /api/message) ---
// #taskTail sits outside the sigSet'd drawer body like #taskDiff: the tail
// rebuilds on its own signature so the poll never blows away the message
// input mid-typing. Sources, server-chosen: the lane log (complete after the
// run finishes; streaming for codex lanes) and the transcript's recent
// assistant blocks (live for RUNNING claude lanes whose stdout buffers).
var tailView = { open: false, busy: false, err: null, data: null, okAt: 0, at: 0, msg: '', msgErr: false, draft: '', pin: true };
function resetTail(){
  tailView = { open: false, busy: false, err: null, data: null, okAt: 0, at: 0, msg: '', msgErr: false, draft: '', pin: true };
}
function toggleTail(){
  tailView.open = !tailView.open;
  if (tailView.open) { tailView.pin = true; if (!tailView.data && !tailView.err) fetchTail(); }
  renderTaskTail();
}
// the tail is the store's 'tail' feed (FEEDS): 2s cadence while open, one
// request in flight, and a scope move (task/project/closed) mid-flight
// discards the stale answer and fetches the current scope
function tailUrl(){
  if (!tailView.open || !task.id) return null;
  var proj = task.proj || (task.data && task.data.project) || '';
  return '/api/tail?id=' + encodeURIComponent(task.id) + (proj ? '&project=' + encodeURIComponent(proj) : '');
}
function tailAccept(j){ if (!j || !j.ok) throw new Error((j && j.error) || 'bad /api/tail payload'); }
function tailLanded(st){
  tailView.busy = false; tailView.at = st.at;
  if (st.err) tailView.err = st.err;
  else { tailView.err = null; tailView.data = st.data; tailView.okAt = st.okAt; }
  renderTaskTail();
}
function fetchTail(){
  feeds.kick('tail', true);
  var st = feeds.get('tail');
  tailView.busy = !!(st && st.busy); tailView.err = null;
}
function renderTaskTail(){
  var el = byId('taskTail');
  if (!task.id) { sigSet(el, 'idle', ''); return; }
  var d = tailView.data;
  var lg = d && d.log;
  var rc = d && d.recent;
  var sig = [task.id, task.proj || '', tailView.open, tailView.busy, tailView.err || '', tailView.okAt ? (lg && lg.size != null ? lg.size + '@' + lg.mtime : 'nolog') + (rc && rc.length ? '|r' + rc.length : '') : 'idle', tailView.msg ? (tailView.msgErr ? 'e' : 'o') + tailView.msg : ''].join('|');
  if (el.getAttribute('data-sig') !== sig) {
    el.setAttribute('data-sig', sig);
    var h = '<div class="tailbar"><button type="button" class="tailbtn' + (tailView.open ? ' on' : '') + '">' + (tailView.busy ? 'tail…' : 'tail') + '</button>';
    if (tailView.open) {
      var txt = null; var cap = '';
      var tr = d && d.transcript;
      if (lg && String(lg.text || '').trim()) {
        txt = String(lg.text); cap = 'lane-' + esc(d.sid) + '.log · ' + lg.size + 'B' + (lg.truncated ? ' · truncated' : '');
      } else if (rc && rc.length) {
        txt = rc.map(function(r){ return String(r.text || ''); }).join('\n');
        cap = 'transcript · live';
      } else if (tr && tr.text) {
        txt = tr.text; cap = 'transcript ' + (tr.ts ? agoShort(msAgo(Date.parse(tr.ts))) : '?') + ' ago — stdout buffers until the lane finishes';
      }
      if (txt != null) h += '<div class="tailwrap"><pre class="tailview mono">' + esc(txt.slice(-40000)) + '</pre></div>';
      else h += '<div class="tailwrap"><pre class="tailview mono"><span class="dim">(no lane output yet)</span></pre></div>';
      h += '<div class="dnote"><input class="lanemsg" placeholder="message the lane — sent as the coordinator"><button type="button" class="lanesend">send</button></div>';
      if (tailView.msg) h += '<div class="tailmsg' + (tailView.msgErr ? ' risk' : '') + '">' + esc(tailView.msg) + '</div>';
      var inp = el.querySelector('.lanemsg');
      if (inp && tailView.draft) inp.value = tailView.draft;
    }
    setNodes(el, h);
  } else if (tailView.open) {
    var keep = el.querySelector('.lanemsg');
    if (keep && document.activeElement !== keep && keep.value !== tailView.draft) keep.value = tailView.draft;
  }
  tailScroll(el);
}
function tailScroll(el){
  var pre = el.querySelector('.tailview');
  if (!pre) return;
  if (!pre._pinwired) {
    pre._pinwired = true; // the pre is replaced on each sig rebuild — listeners never stack
    pre.addEventListener('scroll', function(){
      tailView.pin = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24;
    });
  }
  if (tailView.pin) pre.scrollTop = pre.scrollHeight;
}

`;
