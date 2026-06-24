// Single-file panel UI. Served by src/panel.ts at "/". No build step, no
// dependencies: the page talks to /api/* with fetch and renders with vanilla
// DOM. Keep it this way until the frontend strategy settles — anything that
// can render an iframe or a webview can host this panel.
export const PANEL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ARC — Memory</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #0d0b08;
  --bg-raised: #14110c;
  --bg-hover: #1a160f;
  --line: #29231a;
  --line-strong: #3a3225;
  --ink: #e8e2d4;
  --ink-dim: #97917f;
  --ink-faint: #5f5a4c;
  --amber: #e2a33c;
  --amber-dim: rgba(226, 163, 60, 0.14);
  --green: #8fb573;
  --red: #d96c5a;
  --blue: #7da7c4;
  --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --serif: "Instrument Serif", Georgia, serif;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
  background: var(--bg);
  background-image: radial-gradient(ellipse 90% 60% at 50% -10%, rgba(226, 163, 60, 0.05), transparent);
  color: var(--ink);
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.55;
}
#app { display: flex; flex-direction: column; height: 100vh; }

header {
  display: flex; align-items: baseline; gap: 18px;
  padding: 14px 22px 12px;
  border-bottom: 1px solid var(--line);
}
.wordmark { font-family: var(--serif); font-style: italic; font-size: 26px; letter-spacing: 0.01em; color: var(--ink); }
.wordmark em { color: var(--amber); font-style: italic; }
.ws { color: var(--ink-dim); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.counts { display: flex; gap: 16px; color: var(--ink-dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; }
.counts b { color: var(--ink); font-weight: 600; }
.pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--amber); align-self: center; animation: pulse 2.4s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }

nav { display: flex; gap: 2px; padding: 0 22px; border-bottom: 1px solid var(--line); }
nav button {
  appearance: none; background: none; border: none; cursor: pointer;
  font-family: var(--mono); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--ink-faint); padding: 11px 14px 10px;
  border-bottom: 1px solid transparent; margin-bottom: -1px;
}
nav button:hover { color: var(--ink-dim); }
nav button.active { color: var(--amber); border-bottom-color: var(--amber); }

main { flex: 1; min-height: 0; display: flex; }
.pane { display: none; flex: 1; min-height: 0; }
.pane.active { display: flex; }

/* Capsules */
.list-col { width: 360px; min-width: 280px; border-right: 1px solid var(--line); display: flex; flex-direction: column; }
.search-row { padding: 12px 14px; border-bottom: 1px solid var(--line); }
.search-row input {
  width: 100%; background: var(--bg-raised); border: 1px solid var(--line);
  color: var(--ink); font-family: var(--mono); font-size: 12px; padding: 7px 10px; outline: none;
}
.search-row input:focus { border-color: var(--line-strong); }
.search-row input::placeholder { color: var(--ink-faint); }
#capsule-list { overflow-y: auto; flex: 1; }
.capsule-item { padding: 12px 14px; border-bottom: 1px solid var(--line); cursor: pointer; }
.capsule-item:hover { background: var(--bg-hover); }
.capsule-item.selected { background: var(--amber-dim); box-shadow: inset 2px 0 0 var(--amber); }
.capsule-item h3 { font-size: 12.5px; font-weight: 500; color: var(--ink); margin-bottom: 5px; }
.capsule-item.dead h3 { color: var(--ink-faint); text-decoration: line-through; }
.meta-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 10.5px; color: var(--ink-faint); }
.chip { border: 1px solid var(--line-strong); padding: 0 6px; border-radius: 2px; text-transform: uppercase; letter-spacing: 0.08em; font-size: 9.5px; color: var(--ink-dim); }
.chip.ok { color: var(--green); border-color: rgba(143, 181, 115, 0.4); }
.chip.bad { color: var(--red); border-color: rgba(217, 108, 90, 0.4); }
.chip.warn { color: var(--amber); border-color: rgba(226, 163, 60, 0.4); }
.conf { display: inline-flex; gap: 2px; align-items: flex-end; height: 10px; }
.conf i { width: 3px; background: var(--line-strong); display: block; }
.conf i.on { background: var(--amber); }

.detail-col { flex: 1; overflow-y: auto; padding: 22px 28px 60px; }
.empty { color: var(--ink-faint); padding: 40px; text-align: center; font-style: italic; font-family: var(--serif); font-size: 17px; }
.detail-title { font-family: var(--serif); font-size: 25px; line-height: 1.25; margin-bottom: 4px; }
.detail-sub { color: var(--ink-faint); font-size: 11px; margin-bottom: 18px; }
.detail-summary { color: var(--ink-dim); font-size: 13px; max-width: 72ch; margin-bottom: 22px; }
section.block { margin-bottom: 20px; }
section.block h4 {
  font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; font-weight: 600;
  color: var(--amber); margin-bottom: 7px;
}
section.block ul { list-style: none; max-width: 76ch; }
section.block li { padding: 3px 0 3px 16px; position: relative; color: var(--ink-dim); }
section.block li::before { content: "—"; position: absolute; left: 0; color: var(--ink-faint); }
section.block li.cmd { font-size: 12px; color: var(--ink); }
.kv { display: grid; grid-template-columns: 160px 1fr; gap: 4px 14px; max-width: 76ch; }
.kv dt { color: var(--ink-faint); font-size: 11px; padding-top: 2px; }
.kv dd { color: var(--ink-dim); }
.actions { display: flex; gap: 10px; align-items: center; margin: 4px 0 26px; }
.actions label { font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-faint); }
.actions select {
  background: var(--bg-raised); color: var(--ink); border: 1px solid var(--line-strong);
  font-family: var(--mono); font-size: 11.5px; padding: 4px 8px;
}
.saved-note { font-size: 11px; color: var(--green); opacity: 0; transition: opacity 0.4s; }
.saved-note.show { opacity: 1; }

/* Activity */
#activity { flex: 1; overflow-y: auto; padding: 22px 28px; }
.event-row { display: flex; gap: 14px; padding: 7px 0; border-bottom: 1px solid var(--line); align-items: baseline; }
.event-time { color: var(--ink-faint); font-size: 11px; white-space: nowrap; width: 150px; }
.event-type { width: 190px; font-size: 11px; letter-spacing: 0.06em; white-space: nowrap; }
.event-type.create { color: var(--green); }
.event-type.inject { color: var(--amber); }
.event-type.fail { color: var(--red); }
.event-type.neutral { color: var(--blue); }
.event-detail { color: var(--ink-dim); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Probe */
#probe { flex: 1; overflow-y: auto; padding: 26px 28px; }
.probe-intro { font-family: var(--serif); font-style: italic; font-size: 18px; color: var(--ink-dim); margin-bottom: 16px; max-width: 60ch; }
.probe-row { display: flex; gap: 10px; max-width: 760px; margin-bottom: 22px; }
.probe-row input {
  flex: 1; background: var(--bg-raised); border: 1px solid var(--line-strong);
  color: var(--ink); font-family: var(--mono); font-size: 13px; padding: 9px 12px; outline: none;
}
.probe-row input:focus { border-color: var(--amber); }
.probe-row button {
  background: var(--amber); color: #181307; border: none; cursor: pointer;
  font-family: var(--mono); font-weight: 600; font-size: 11px; letter-spacing: 0.12em;
  text-transform: uppercase; padding: 0 20px;
}
.probe-row button:hover { filter: brightness(1.1); }
.verdict { font-family: var(--serif); font-size: 22px; margin-bottom: 6px; }
.verdict.yes { color: var(--green); }
.verdict.no { color: var(--ink-faint); font-style: italic; }
.probe-reason { color: var(--ink-dim); margin-bottom: 16px; }
pre.inject-msg {
  background: var(--bg-raised); border: 1px solid var(--line); border-left: 2px solid var(--amber);
  padding: 14px 16px; white-space: pre-wrap; word-break: break-word;
  font-size: 12px; color: var(--ink-dim); max-width: 860px;
}
footer { padding: 8px 22px; border-top: 1px solid var(--line); color: var(--ink-faint); font-size: 10.5px; display: flex; justify-content: space-between; gap: 12px; }
footer span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
::-webkit-scrollbar { width: 10px; }
::-webkit-scrollbar-thumb { background: var(--line-strong); }
::-webkit-scrollbar-track { background: transparent; }

/* Narrow hosts (in-app dock column): stack list over detail, loosen grids. */
@media (max-width: 720px) {
  header { padding: 10px 14px 9px; gap: 10px; flex-wrap: wrap; }
  .wordmark { font-size: 20px; }
  .ws { display: none; }
  nav { padding: 0 10px; }
  nav button { padding: 9px 10px 8px; }
  #pane-capsules { flex-direction: column; }
  .list-col { width: 100%; min-width: 0; max-height: 42%; border-right: none; border-bottom: 1px solid var(--line); }
  .detail-col { padding: 14px 14px 40px; }
  .detail-title { font-size: 20px; }
  .kv { grid-template-columns: 1fr; gap: 0 0; }
  .kv dt { padding-top: 6px; }
  #activity { padding: 14px; }
  .event-row { flex-wrap: wrap; gap: 4px 10px; }
  .event-time { width: auto; }
  .event-type { width: auto; }
  .event-detail { flex-basis: 100%; white-space: normal; }
  #probe { padding: 16px 14px; }
  .probe-row { flex-direction: column; }
  .probe-row button { padding: 9px 0; }
  footer { padding: 7px 14px; }
}
</style>
</head>
<body>
<div id="app">
  <header>
    <div class="wordmark">A<em>R</em>C&nbsp;<span style="font-size:18px;color:var(--ink-dim)">memory</span></div>
    <div class="ws" id="ws-path"></div>
    <div class="counts">
      <span><b id="count-capsules">–</b> capsules</span>
      <span><b id="count-events">–</b> events</span>
    </div>
    <div class="pulse" title="watching .agent-run-cache"></div>
  </header>
  <nav>
    <button data-tab="capsules" class="active">Capsules</button>
    <button data-tab="activity">Activity</button>
    <button data-tab="probe">Probe</button>
  </nav>
  <main>
    <div class="pane active" id="pane-capsules">
      <div class="list-col">
        <div class="search-row"><input id="search" placeholder="filter capsules…" autocomplete="off"></div>
        <div id="capsule-list"></div>
      </div>
      <div class="detail-col" id="detail"><div class="empty">No capsule selected.</div></div>
    </div>
    <div class="pane" id="pane-activity"><div id="activity"></div></div>
    <div class="pane" id="pane-probe">
      <div id="probe">
        <p class="probe-intro">Ask the vault what it would whisper to the agent before a prompt like this.</p>
        <div class="probe-row">
          <input id="probe-input" placeholder="e.g. how do we run the desktop contract check?" autocomplete="off">
          <button id="probe-run">Probe</button>
        </div>
        <div id="probe-result"></div>
      </div>
    </div>
  </main>
  <footer>
    <span id="cache-path"></span>
    <span id="refreshed"></span>
  </footer>
</div>
<script>
(function () {
  var state = { capsules: [], events: [], selected: null, filter: "", status: null };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function fetchJson(path, options) {
    return fetch(path, options).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) throw new Error(body.error || ("HTTP " + response.status));
        return body;
      });
    });
  }

  function timeAgo(iso) {
    var ms = Date.now() - Date.parse(iso);
    if (!isFinite(ms) || ms < 0) return iso || "";
    var minutes = Math.floor(ms / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return minutes + "m ago";
    var hours = Math.floor(minutes / 60);
    if (hours < 48) return hours + "h ago";
    return Math.floor(hours / 24) + "d ago";
  }

  function outcomeChipClass(status) {
    if (status === "success") return "chip ok";
    if (status === "failed" || status === "aborted") return "chip bad";
    if (status === "partial") return "chip warn";
    return "chip";
  }

  function confidenceBars(value) {
    var wrap = el("span", "conf");
    for (var i = 0; i < 5; i++) {
      var bar = el("i", value > i / 5 ? "on" : "");
      bar.style.height = (4 + i * 1.5) + "px";
      wrap.appendChild(bar);
    }
    wrap.title = "confidence " + Number(value).toFixed(2);
    return wrap;
  }

  function matchesFilter(capsule, filter) {
    if (!filter) return true;
    var haystack = (capsule.title + " " + capsule.summary + " " + capsule.kind + " " +
      capsule.reuseWhen.join(" ") + " " + capsule.workflow.commands.join(" ")).toLowerCase();
    return filter.toLowerCase().split(/\\s+/).every(function (term) { return haystack.indexOf(term) >= 0; });
  }

  function renderList() {
    var list = document.getElementById("capsule-list");
    list.textContent = "";
    var visible = state.capsules.filter(function (capsule) { return matchesFilter(capsule, state.filter); });
    visible.sort(function (a, b) { return Date.parse(b.updatedAt) - Date.parse(a.updatedAt); });
    if (!visible.length) {
      list.appendChild(el("div", "empty", state.capsules.length ? "No capsules match." : "No capsules yet. Run a session; ARC saves what it learns."));
      return;
    }
    visible.forEach(function (capsule) {
      var dead = capsule.status === "rejected" || capsule.status === "superseded" || !capsule.reusable;
      var item = el("div", "capsule-item" + (state.selected === capsule.id ? " selected" : "") + (dead ? " dead" : ""));
      item.appendChild(el("h3", "", capsule.title));
      var meta = el("div", "meta-row");
      meta.appendChild(el("span", "chip", capsule.kind));
      meta.appendChild(el("span", outcomeChipClass(capsule.outcomeStatus), capsule.outcomeStatus));
      if (capsule.status !== "local") meta.appendChild(el("span", "chip", capsule.status));
      meta.appendChild(confidenceBars(capsule.confidence));
      meta.appendChild(el("span", "", timeAgo(capsule.updatedAt)));
      if (capsule.useCount) meta.appendChild(el("span", "", "used " + capsule.useCount + "×"));
      item.appendChild(meta);
      item.onclick = function () { state.selected = capsule.id; renderList(); renderDetail(); };
      list.appendChild(item);
    });
  }

  function block(title, items, cls) {
    if (!items || !items.length) return null;
    var section = el("section", "block");
    section.appendChild(el("h4", "", title));
    var ul = el("ul");
    items.forEach(function (item) { ul.appendChild(el("li", cls || "", item)); });
    section.appendChild(ul);
    return section;
  }

  function selectControl(label, value, choices, onChange) {
    var wrap = el("span");
    wrap.appendChild(el("label", "", label + " "));
    var select = el("select");
    choices.forEach(function (choice) {
      var option = el("option", "", choice);
      option.value = choice;
      if (choice === value) option.selected = true;
      select.appendChild(option);
    });
    select.onchange = function () { onChange(select.value); };
    wrap.appendChild(select);
    return wrap;
  }

  function patchCapsule(id, patch, note) {
    fetchJson("/api/capsules/" + encodeURIComponent(id), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch)
    }).then(function () {
      note.classList.add("show");
      setTimeout(function () { note.classList.remove("show"); }, 1600);
      refresh(true);
    }).catch(function (error) {
      note.textContent = String(error.message || error);
      note.style.color = "var(--red)";
      note.classList.add("show");
    });
  }

  function renderDetail() {
    var detail = document.getElementById("detail");
    detail.textContent = "";
    var capsule = state.capsules.find(function (item) { return item.id === state.selected; });
    if (!capsule) {
      detail.appendChild(el("div", "empty", "No capsule selected."));
      return;
    }
    detail.appendChild(el("h2", "detail-title", capsule.title));
    detail.appendChild(el("div", "detail-sub",
      capsule.id.slice(0, 8) + " · " + capsule.kind + " · created " + timeAgo(capsule.createdAt) +
      " · updated " + timeAgo(capsule.updatedAt) + " · sessions " + capsule.sourceSessionIds.length));

    var actions = el("div", "actions");
    var note = el("span", "saved-note", "saved");
    actions.appendChild(selectControl("status", capsule.status,
      ["local", "shareable", "private", "rejected", "superseded"],
      function (value) { patchCapsule(capsule.id, { status: value }, note); }));
    actions.appendChild(selectControl("privacy", capsule.privacyLabel,
      ["local", "shareable", "private", "redacted"],
      function (value) { patchCapsule(capsule.id, { privacyLabel: value }, note); }));
    actions.appendChild(note);
    detail.appendChild(actions);

    if (capsule.summary) detail.appendChild(el("p", "detail-summary", capsule.summary));

    [
      block("Reuse when", capsule.reuseWhen),
      block("Do not reuse when", capsule.doNotReuseWhen),
      block("Steps", capsule.workflow.steps),
      block("Commands", capsule.workflow.commands, "cmd"),
      block("Success criteria", capsule.workflow.successCriteria),
      block("Failed attempts", capsule.workflow.failedAttempts),
      block("Evidence", capsule.evidence),
      block("Provenance", capsule.provenance)
    ].forEach(function (section) { if (section) detail.appendChild(section); });

    var facts = el("section", "block");
    facts.appendChild(el("h4", "", "Record"));
    var kv = el("dl", "kv");
    [
      ["confidence", Number(capsule.confidence).toFixed(2) + (capsule.confidenceReason ? " — " + capsule.confidenceReason : "")],
      ["outcome", capsule.outcomeStatus],
      ["use / success / failure", capsule.useCount + " / " + capsule.successCount + " / " + capsule.failureCount],
      ["next-run instruction", capsule.nextRunInstruction],
      ["purpose", capsule.workflow.purpose],
      ["supersedes", capsule.supersedes.join(", ")],
      ["superseded by", capsule.supersededBy.join(", ")],
      ["contributors", capsule.contributors.join(", ")],
      ["id", capsule.id]
    ].forEach(function (pair) {
      if (!pair[1]) return;
      kv.appendChild(el("dt", "", pair[0]));
      kv.appendChild(el("dd", "", pair[1]));
    });
    facts.appendChild(kv);
    detail.appendChild(facts);
  }

  function eventClass(type) {
    if (type === "review.saved") return "create";
    if (type === "review.failed") return "fail";
    if (type.indexOf("created") >= 0 || type.indexOf("updated") >= 0 || type.indexOf("finalized") >= 0) return "create";
    if (type.indexOf("injected") >= 0) return "inject";
    if (type.indexOf("failed") >= 0 || type.indexOf("rejected") >= 0 || type.indexOf("superseded") >= 0) return "fail";
    return "neutral";
  }

  function eventType(event) {
    var details = event.details || {};
    if (event.type === "capsule.checkpointed" && typeof details.outcome === "string" && details.outcome) {
      return "review." + details.outcome;
    }
    return event.type;
  }

  function describeEvent(event) {
    var details = event.details || {};
    var parts = [];
    if (details.title) parts.push(String(details.title));
    if (details.reason) parts.push(String(details.reason));
    if (event.type === "capsule.checkpointed") {
      if (!parts.length && details.review) parts.push(String(details.review));
      if (typeof details.eventCount === "number") parts.push(String(details.eventCount) + " events");
    }
    if (event.capsuleId && !details.title) parts.push("capsule " + String(event.capsuleId).slice(0, 8));
    if (event.sessionId) parts.push("session " + String(event.sessionId).slice(0, 8));
    return parts.join(" · ");
  }

  function renderActivity() {
    var container = document.getElementById("activity");
    container.textContent = "";
    if (!state.events.length) {
      container.appendChild(el("div", "empty", "No memory activity recorded yet."));
      return;
    }
    state.events.forEach(function (event) {
      var type = eventType(event);
      var row = el("div", "event-row");
      row.appendChild(el("span", "event-time", event.timestamp.slice(0, 19).replace("T", " ")));
      row.appendChild(el("span", "event-type " + eventClass(type), type));
      row.appendChild(el("span", "event-detail", describeEvent(event)));
      container.appendChild(row);
    });
  }

  function renderProbe(plan) {
    var result = document.getElementById("probe-result");
    result.textContent = "";
    result.appendChild(el("div", "verdict " + (plan.shouldInject ? "yes" : "no"),
      plan.shouldInject ? "Yes — memory would be injected." : "No injection for this prompt."));
    result.appendChild(el("p", "probe-reason", plan.reason + (plan.source ? " (" + plan.source + ")" : "")));
    if (plan.capsule) {
      var link = el("p", "probe-reason", "capsule: " + plan.capsule.title);
      link.style.cursor = "pointer";
      link.style.color = "var(--amber)";
      link.onclick = function () {
        state.selected = plan.capsule.id;
        switchTab("capsules");
        renderList();
        renderDetail();
      };
      result.appendChild(link);
    }
    if (plan.message) result.appendChild(el("pre", "inject-msg", plan.message));
  }

  function switchTab(name) {
    document.querySelectorAll("nav button").forEach(function (button) {
      button.classList.toggle("active", button.dataset.tab === name);
    });
    document.querySelectorAll(".pane").forEach(function (pane) {
      pane.classList.toggle("active", pane.id === "pane-" + name);
    });
  }

  function refresh(force) {
    fetchJson("/api/status").then(function (status) {
      document.getElementById("ws-path").textContent = status.workspace;
      document.getElementById("cache-path").textContent = status.cacheDir;
      document.getElementById("count-capsules").textContent = status.capsuleCount;
      document.getElementById("count-events").textContent = status.eventCount;
      document.getElementById("refreshed").textContent = "refreshed " + new Date().toLocaleTimeString();
      var changed = !state.status || state.status.capsuleCount !== status.capsuleCount || state.status.eventCount !== status.eventCount;
      state.status = status;
      if (!changed && !force) return;
      return Promise.all([fetchJson("/api/capsules"), fetchJson("/api/events?limit=500")]).then(function (results) {
        state.capsules = results[0].capsules;
        state.events = results[1].events;
        renderList();
        renderDetail();
        renderActivity();
      });
    }).catch(function () {
      document.getElementById("refreshed").textContent = "connection lost — is arc panel still running?";
    });
  }

  document.querySelectorAll("nav button").forEach(function (button) {
    button.onclick = function () { switchTab(button.dataset.tab); };
  });
  document.getElementById("search").oninput = function (event) {
    state.filter = event.target.value;
    renderList();
  };
  function runProbe() {
    var prompt = document.getElementById("probe-input").value.trim();
    if (!prompt) return;
    document.getElementById("probe-result").textContent = "probing…";
    fetchJson("/api/probe?prompt=" + encodeURIComponent(prompt)).then(renderProbe).catch(function (error) {
      document.getElementById("probe-result").textContent = String(error.message || error);
    });
  }
  document.getElementById("probe-run").onclick = runProbe;
  document.getElementById("probe-input").onkeydown = function (event) { if (event.key === "Enter") runProbe(); };

  refresh(true);
  setInterval(refresh, 4000);
})();
</script>
</body>
</html>
`;
