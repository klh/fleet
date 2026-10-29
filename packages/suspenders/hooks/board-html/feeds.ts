// hooks/board-html/feeds.ts — the tab + drawer feed definitions (FeedStore,
// feed-store.ts; the store itself and the data/dec feeds live in CORE, the
// decision-history feed in HISTORY). Kept out of the renderer chunks so those
// chunks stay evaluable standalone (the board-* suites eval TASKS/SETUP bytes
// without a store); concatenated after them, before BOOT. Each url() gates on
// the active tab / open drawer, so inactive feeds never fetch.
export const FEEDS = String.raw`// --- feeds: tasks/lanes, spend sparklines, task drawer, activity, setup ---
feeds.define('tasks', {
  url: function(){
    if (curTab !== 'tasks' && curTab !== 'lanes') return null;
    // W682: the server trims terminal history to 12/project by default; the
    // opt-in completed table asks for the full feed back.
    var showDone = false;
    try { showDone = localStorage.getItem('taskShowDone') === '1'; } catch(e) {}
    var q = projQuery();
    return '/api/tasks' + q + (q ? '&' : '?') + 'done=' + (showDone ? 'all' : '12');
  },
  accept: function(j){ if (!j || j.ok === false || !Array.isArray(j.tasks)) throw new Error('bad /api/tasks payload'); },
  ok: function(j, changed){ tasksOkAt = Date.now(); tasksErr = null; tasksLoaded = true; if (!changed) return; tasksData = j; noteProjects(j.projects); renderTasks(); renderKanban(); },
  fail: function(e){ tasksErr = e; renderTasks(); renderKanban(); }
});
// sparklines are garnish — never an error surface (no fail handler)
feeds.define('spend', {
  everyMs: 30000, minGapMs: 30000, maxMs: 120000,
  url: function(){ return curTab === 'tasks' || curTab === 'lanes' || task.id ? '/api/spend-series' : null; },
  accept: function(j){ if (!j || j.ok === false || !j.series) throw new Error('bad /api/spend-series payload'); },
  ok: function(j, changed){
    spendSeriesAt = Date.now();
    if (!changed) return;
    var m = {};
    for (var k in j.series) m[k.split('\u0000').join('|')] = j.series[k];
    spendSeries = m;
    var a = {};
    if (j.attempts) for (var k2 in j.attempts) a[k2.split('\u0000').join('|')] = j.attempts[k2];
    attemptData = a;
    if (byId('kanban')) paintSparks(byId('kanban'));
    var db2 = byId('drawerBody');
    if (task.id && db2 && !byId('drawer').hidden) paintSparks(db2);
  }
});
feeds.define('task', {
  everyMs: 5000, minGapMs: 5000, // drawer refresh throttle
  url: function(){
    if (!task.id) return null;
    // the task's own project beats the global filter — 'all' must still resolve
    var qp = task.proj ? '?project=' + encodeURIComponent(task.proj) : projQuery();
    return '/api/task' + qp + (qp ? '&' : '?') + 'id=' + encodeURIComponent(task.id);
  },
  accept: function(j){ if (!j || j.ok === false) throw new Error((j && j.error) || 'bad /api/task payload'); if (!j.task || !Array.isArray(j.events)) throw new Error('bad /api/task payload'); },
  ok: function(j){ task.data = j; task.err = null; task.okAt = Date.now(); pollExecutionTrace(); fetchLaunch(); renderDrawer(); },
  fail: function(e){ task.err = e; renderDrawer(); }
});
feeds.define('exec', {
  everyMs: 30000, minGapMs: 30000, timeoutMs: 20000,
  url: function(){ var proj = task.id && (task.proj || (task.data && task.data.task && task.data.task.project)); return proj ? '/api/task/execution?project=' + encodeURIComponent(proj) + '&id=' + encodeURIComponent(task.id) : null; },
  ok: function(j){ task.execution = j; task.executionErr = null; task.executionBusy = false; renderDrawer(); },
  fail: function(e){ task.executionErr = e; task.executionBusy = false; renderDrawer(); }
});
feeds.define('act', {
  url: function(){ if (curTab !== 'activity') return null; var scope = projQuery(); return '/api/activity?limit=300' + (scope ? '&' + scope.slice(1) : ''); },
  accept: function(j){ if (!j || j.ok === false || !Array.isArray(j.events)) throw new Error('bad /api/activity payload'); },
  ok: function(j, changed){ actOkAt = Date.now(); actErr = null; actLoaded = true; if (!changed) return; actData = j; noteProjects(j.projects); renderAct(); },
  fail: function(e){ actErr = e; renderAct(); }
});
feeds.define('setup', {
  everyMs: 5000, // machine wiring checks move slowly; tab switches kick at once
  url: function(){ return curTab === 'setup' ? '/api/setup' : null; },
  accept: function(j){ if (!j || j.ok === false || !Array.isArray(j.checks)) throw new Error('bad /api/setup payload'); },
  ok: function(j, changed){ setupOkAt = Date.now(); setupErr = null; setupLoaded = true; if (changed) setupData = j; renderSetup(); },
  fail: function(e){ setupErr = e; renderSetup(); }
});
// lane tail (tail.ts): 2s while the drawer's tail is open
feeds.define('tail', { everyMs: 2000, url: tailUrl, accept: tailAccept, settle: tailLanded });
// work-report pane + its one expanded row (report.ts)
feeds.define('report', {
  everyMs: 2000,
  url: function(){ return curTab === 'report' ? '/api/report' + projQuery() : null; },
  ok: function(j){ reportData = j; reportOkAt = Date.now(); reportErr = null; renderReport(); },
  fail: function(e){ reportErr = e; renderReport(); }
});
feeds.define('reportRow', {
  everyMs: 30000, url: reportRowUrl,
  accept: function(j){ if (!j || j.ok === false) throw new Error((j && j.error) || 'row not found'); },
  ok: function(j){ reportDetail = j; reportDetailErr = null; renderReportDetail(); },
  fail: function(e){ reportDetailErr = e; renderReportDetail(); }
});
// usage view (usage.ts): manual — refetched only when the hash params move
feeds.define('usage', {
  manual: true, timeoutMs: 20000, url: usageUrl,
  ok: function(j){ usageLanded(j); },
  fail: function(e){ var s = byId('usageState'); s.hidden = false; s.textContent = 'Usage could not load: ' + e; }
});
`;
