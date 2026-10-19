// hooks/board-html/body.ts — body skeleton + client state vars (W157 client chunk).
// String.raw matches the original single-template semantics; bun's
// non-ASCII escaping in String.raw reproduces the served page bytes.
// biome-ignore lint/complexity/noUselessStringRaw: byte-compat (W157)
export const BODY = String.raw`
<header>
  <span class="mark">FLEET BOARD</span>
  <div class="right">
    <label class="board-search" for="boardSearch" hidden>Search <input id="boardSearch" type="search" placeholder="tasks, lanes, decisions" autocomplete="off" aria-label="Search tasks, lanes, and decisions"></label>
    <span id="conn"></span>
    <span id="stamp"></span>
    <span id="blockedn"></span>
    <button id="needsn" type="button"></button>
    <label class="plabel" for="proj">project</label>
    <select id="proj"><option value="all">all projects</option></select>
  </div>
</header>
<details id="orch" class="orch">
  <summary>Orchestrate <span class="dim">Turn a goal into a plan</span></summary>
  <div class="orchbody">
    <div id="orchContext" class="orchcontext" hidden>
      <span id="orchWorkPill" class="orchpill"></span>
      <label for="orchRoute">send to</label>
      <select id="orchRoute" aria-label="prompt destination">
        <option value="lane">this agent</option>
        <option value="parent">parent agent</option>
        <option value="supervisor">supervisor</option>
      </select>
      <span id="orchDestination" class="dim"></span>
      <button id="orchClear" type="button" aria-label="clear work item target">×</button>
    </div>
    <div class="orchrow">
      <textarea id="orchGoal" rows="1" placeholder="Describe the work to plan" aria-label="orchestration goal"></textarea>
      <button id="orchSuggest" type="button" hidden>suggest</button>
      <button id="orchGo" type="button">orchestrate</button>
    </div>
    <klh-prompt-preview id="orchPreview"></klh-prompt-preview>
    <div id="orchErr"></div>
    <div id="orchOut"></div>
  </div>
</details>
<klh-board-tabs id="boardTabs"></klh-board-tabs>
<div id="hashChipBar"></div>
<main>
<section id="tab-decisions">
  <section id="decisions">
    <h2><button id="decToggle" type="button"><span id="decCaret">-</span> Decisions needed</button><span id="decState" aria-live="polite">loading decisions...</span></h2>
    <div id="decErr"></div>
    <div id="decList"></div>
  </section>
  <div id="hist">
    <div class="histhead">
      <button id="histHead" type="button" aria-expanded="false"><span id="histCaret">+</span> History</button>
      <span id="histState"></span>
    </div>
    <div id="histErr"></div>
    <div id="histBody"></div>
  </div>
</section>
<section id="tab-tasks" hidden>
  <div class="taskbar">
    <label class="plabel" for="taskProj">project</label>
    <select id="taskProj"><option value="all">all projects</option></select>
    <label class="plabel" for="taskOwner">session</label>
    <select id="taskOwner"><option value="all">all sessions</option></select>
    <label class="plabel"><input type="checkbox" id="taskDone"> completed</label>
    <span id="taskCount" class="dim"></span>
  </div>

  <div id="tasksErr" class="taberr"></div>
  <table id="tasksTbl">
    <thead><tr>
      <th scope="col" data-k="id"><button type="button" class="thsort" data-label="id">id</button></th>
      <th scope="col" data-k="proj"><button type="button" class="thsort" data-label="proj">proj</button></th>
      <th scope="col" data-k="title"><button type="button" class="thsort" data-label="task">task</button></th>
      <th scope="col" data-k="state"><button type="button" class="thsort" data-label="state">state</button></th>
      <th scope="col" data-k="owner"><button type="button" class="thsort" data-label="owner">owner</button></th>
      <th scope="col" data-k="tok"><button type="button" class="thsort" data-label="tok">tok</button></th>
      <th scope="col" data-k="wall"><button type="button" class="thsort" data-label="wall">wall</button></th>
      <th scope="col" data-k="age"><button type="button" class="thsort" data-label="age">age</button></th>
      <th scope="col" data-k="decisions"><button type="button" class="thsort" data-label="decisions">decisions</button></th>
    </tr></thead>
    <tbody id="tasksBody"><tr><td colspan="9" class="dim">loading tasks...</td></tr></tbody>
  </table>
</section>
<section id="tab-lanes" hidden>
  <div id="kanbanErr" class="taberr"></div>
  <div class="kwrap"><div id="kanban"><div class="state dim">loading lanes...</div></div></div>
  <div class="dim" id="splinesLegend">— <span class="spl-key spl-block">blocked by</span> · <span class="spl-key spl-wait">shattered parent waiting on children</span></div>
</section>
<section id="tab-activity" hidden>
  <div id="actErr" class="taberr"></div>
  <div class="feed"><div id="actBody"><div class="r"><span class="dim">loading activity...</span></div></div></div>
</section>
<section id="tab-governor" hidden>
  <div class="taskbar">
    <label class="plabel" for="originHub">origin hub</label>
    <select id="originHub"><option value="all">all origins</option><option value="unknown">unknown origin</option></select>
    <label class="plabel" for="peerHub">via downstream</label>
    <select id="peerHub"><option value="all">all downstreams</option><option value="unknown">unknown downstream</option></select>
    <span class="dim">Hub filters apply to Governor and Activity. Other tabs show the project work graph.</span>
  </div>
  <p class="dim" id="hubScopeNote"></p>
  <details class="sec"><summary>Downstream observations · read-only evidence</summary><div id="downstreamObservations"></div></details>
  <klh-recovery></klh-recovery>
  <div id="fleet">
    <button id="fleetHead" type="button" aria-expanded="true"><span id="fleetCaret">-</span> <span id="fleetLine">fleet: loading...</span></button>
    <div id="fleetBody" style="display:block"></div>
  </div>
  <div class="sec"><h2>Claims <span class="dim">(file -&gt; owner -&gt; waiting -&gt; lease)</span></h2><div class="feed" id="claims"></div></div>
  <div class="sec"><h2>Facts <span class="dim">(lesson.*/finding.* · trust = rating · evidence · researched)</span></h2><div class="feed" id="facts"></div></div>
  <div class="sec"><h2>LLM telemetry <span class="dim">(global routing log + model budgets · ignores project and hub filters)</span></h2><div class="feed" id="llmview"></div></div>
  <div class="sec"><h2>Completed</h2><div class="feed" id="done"></div></div>
  <div class="sec"><h2>Event stream</h2><div class="feed"><div class="filters" id="filters"></div><div id="events"></div></div></div>
</section>
<section id="tab-setup" hidden>
  <div id="setupErr" class="taberr"></div>
  <div class="grid" id="setupBody"><div class="state dim">loading setup checks...</div></div>
</section>
<section id="tab-enterprise" hidden>
  <klh-ent-zone id="entZone"></klh-ent-zone>
</section>
</main>
<aside id="drawer" role="dialog" aria-modal="false" aria-labelledby="drawerTitle" hidden>
  <div class="dwhead"><h2 id="drawerTitle">Task</h2><button id="drawerClose" type="button" aria-label="close task details">&times;</button></div>
  <div id="drawerBody"></div>
  <div id="taskDiff"></div>
  <div id="taskTail"></div>
</aside>
<div id="toasts" aria-live="polite"></div>
<script>
var sel = document.getElementById('proj'); // global project filter (full git-common-dir paths, 'all' = no filter)
var lastData = null; // last good /api/data
var lastDataTs = 0;
var dataOkAt = 0; var dataErr = null; var dataBusy = false;
var lastDec = null; // last good /api/decisions {ts, decisions}
var decOkAt = 0; var decErr = null; var decBusy = false; var decLoaded = false; var decBaseline = false;
var seen = {}; // decision ids ever toasted (baseline on first good fetch)
var drafts = {}; // dec id -> typed-but-unsent text, survives re-renders
var selOpt = {}; // dec id -> chosen option label (selecting, not submitting)
var advising = {}; // dec id -> ms when the advise request started
var advRetry = {}; // dec id -> {n, at} advise transport-failure backoff
var advErr = {}; // dec id -> advise request error (inline)
var answering = {}; // dec id -> true while an answer POST is in flight
var ansErr = {}; // dec id -> inline answer/delivery error
var sentOk = {}; // dec id -> answer accepted (until the poll drops the card)
var decCollapsed = false;
var evFilter = 'all';
var hubOrigin = 'all'; var hubPeer = 'all';
var projBaseline = false; // suppress toast storm right after a project switch
var knownProj = {}; // distinct project paths seen in any 'projects' response
var TABS = { decisions: 1, tasks: 1, lanes: 1, activity: 1, governor: 1, setup: 1 };
var curTab = 'decisions';
var tasksData = null; var tasksOkAt = 0; var tasksErr = null; var tasksBusy = false; var tasksLoaded = false;
var actData = null; var actOkAt = 0; var actErr = null; var actBusy = false; var actLoaded = false;
var histOpen = false; var histData = null; var histOkAt = 0; var histErr = null; var histBusy = false; var histLoaded = false;
var setupData = null; var setupOkAt = 0; var setupErr = null; var setupBusy = false; var setupLoaded = false;
var task = { id: null, proj: null, data: null, err: null, busy: false, okAt: 0, trigger: null }; // open drawer state
// W55 per-item diff + line comments (state outlives the drawer's 5s rebuilds;
// the drawer body sig-changes every poll, #taskDiff keeps its own sig)
var diffView = { open: false, busy: false, err: null, data: null, okAt: 0, target: null, draft: '', msg: '', msgErr: false };
`;
