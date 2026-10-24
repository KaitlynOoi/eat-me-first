// Eat Me First web app - plain JS, polls the server every 3 seconds.
const $ = (id) => document.getElementById(id);
let state = null;
let quickAddBuilt = false;
let recipes = null;          // last /api/recipes result
let recipesKey = "";         // which fridge contents those recipes were made for

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

// Toast with an optional Undo button
let undoAction = null;
function toast(msg, undo) {
  $("toastMsg").textContent = msg;
  undoAction = undo || null;
  $("toastUndo").classList.toggle("hidden", !undo);
  $("toast").classList.remove("hidden");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $("toast").classList.add("hidden"), undo ? 6000 : 3000);
}
$("toastUndo").addEventListener("click", async () => {
  $("toast").classList.add("hidden");
  if (undoAction) { await undoAction(); undoAction = null; }
});

// Scanned products show their photo; everything else its food emoji
const icon = (i, cls = "emoji") => (i.image
  ? `<img class="thumb" src="${esc(i.image)}" alt="" loading="lazy">`
  : `<span class="${cls}">${i.emoji}</span>`);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtLeft(d) {
  if (d <= 0) return "Expired: check it";
  if (d < 1) return `${Math.max(1, Math.round(d * 24))} hours left`;
  return `${d.toFixed(d < 3 ? 1 : 0)} days left`;
}
function urgencyLabel(d) {
  if (d <= 0) return "Expired";
  if (d < 1) return "Due today";
  return "Expires tomorrow";
}

const ENV_LABEL = { fridge: "🧊 In the fridge", freezer: "❄️ In the freezer", pantry: "🏠 On the counter / pantry" };
const STATUS_LABEL = { eaten: "Ate it", tossed: "Tossed", removed: "Removed" };
const fmt = (v, digits = 1) => (v == null ? "--" : Number(v).toFixed(digits));

// ---------- Rendering ----------
function render() {
  const { pod, items, alerts, sim, config } = state;
  const live = pod.lastSeen && Date.now() - pod.lastSeen < 15000;
  $("podStatus").textContent = { pod: "pod live", demo: "demo pod", manual: "no pod" }[pod.mode];
  $("podStatus").classList.toggle("live", pod.mode !== "manual" && Boolean(live));

  renderWeekly();
  renderShopping();

  // Pod
  $("podEnv").textContent = ENV_LABEL[pod.env] || "Detecting…";
  $("podEnvHow").textContent = pod.location === "auto" ? (pod.mode === "manual" ? "· default" : "· auto-detected") : "· set by you";
  // No pod sending readings: show the settings we're going by instead of empty sensor boxes
  const manual = pod.mode === "manual";
  $("podGrid").classList.toggle("hidden", manual);
  $("podManual").classList.toggle("hidden", !manual);
  if (manual) {
    $("podManual").innerHTML = `No pod connected, so we're using your settings:
      <b>${PLACE[pod.env]}</b>${pod.tempSetting != null ? ` at <b>${pod.tempSetting}°C</b>` : " at a typical temperature"}.
      <button class="link" data-open-settings>Set temperature</button>`;
  }
  renderSpeed(pod.conditions);
  renderLcd();
  renderSettings();
  $("demoCard").classList.toggle("hidden", !(pod.demo && pod.mode !== "pod"));
  $("podTemp").textContent = fmt(pod.latest?.tempC);
  $("podAvg").textContent = fmt(pod.avgTempC);
  $("podHum").textContent = fmt(pod.latest?.humidity, 0);
  $("podGas").textContent = pod.latest?.gas ?? "--";
  $("podBase").textContent = pod.gasBaseline ?? "--";
  const warm = pod.warmMinutes > 0;
  $("podWarn").classList.toggle("hidden", !warm);
  if (warm) $("podWarn").textContent = `⚠️ Fridge above 7°C for ${pod.warmMinutes} min (alert at ${config.warmAlertMin})`;

  // Items, grouped by urgency
  const groups = [
    { title: "🔴 Eat today", items: items.filter((i) => i.remainingDays < 1), cls: "urgent" },
    { title: "🟠 Eat soon", items: items.filter((i) => i.remainingDays >= 1 && i.remainingDays < 3), cls: "soon" },
    { title: "🟢 Fresh", items: items.filter((i) => i.remainingDays >= 3), cls: "" },
  ].filter((g) => g.items.length);
  $("emptyItems").classList.toggle("hidden", items.length > 0);
  $("itemGroups").innerHTML = groups.map((g) => `
    <h2 class="group-title">${g.title} <span class="count">${g.items.length}</span></h2>
    <ul class="items">${g.items.map((i) => `
      <li class="${g.cls}">
        ${icon(i)}
        <div class="info" data-edit="${i.id}"><div class="name">${esc(i.name)}</div><div class="left">${fmtLeft(i.remainingDays)}</div>${forecastNote(i)}</div>
        <div class="actions">
          <button class="ate" data-done="${i.id}" data-status="eaten" data-name="${esc(i.name)}">✓ Ate it</button>
          <button class="toss" data-done="${i.id}" data-status="tossed" data-name="${esc(i.name)}">Tossed</button>
        </div>
      </li>`).join("")}
    </ul>`).join("");

  // Recently removed (restore = undo for anything)
  const removed = state.recentlyRemoved;
  $("removedBox").classList.toggle("hidden", !removed.length);
  $("removedList").innerHTML = removed.map((r) => `
    <li>${icon(r, "")}<span class="grow">${esc(r.name)}</span>
      <span class="tag">${STATUS_LABEL[r.status]}</span>
      <button class="secondary" data-restore="${r.id}" data-name="${esc(r.name)}">Restore</button></li>`).join("");

  $("alertList").innerHTML = alerts.length
    ? alerts.slice(0, 5).map((a) => `<li><b>${esc(a.title)}</b>${esc(a.message)}<br><time>${new Date(a.t).toLocaleTimeString()}</time></li>`).join("")
    : `<li class="muted">No alerts yet.</li>`;

  $("simButtons").innerHTML = Object.entries(sim.scenarios).map(([k, s]) =>
    `<button data-sim="${k}" class="${sim.scenario === k ? "on" : ""}">${esc(s.label)}</button>`).join("");
  $("ntfyInfo").textContent = config.ntfyTopic
    ? `Phone alerts: install the ntfy app and subscribe to "${config.ntfyTopic}".`
    : "Phone alerts are off: set NTFY_TOPIC in .env.";

  // AI photo scan only shows up once a Claude API key is set on the server
  $("photoCard").classList.toggle("hidden", !state.photoScan);

  if (!quickAddBuilt) {
    quickAddBuilt = true;
    $("quickAdd").innerHTML = state.quickAdd.map((sec) => `
      <div class="quick-section">
        <h3>${esc(sec.section)}</h3>
        <div class="quick">${sec.foods.map((f) =>
          `<button data-add="${esc(f.name)}"><span>${f.emoji}</span>${esc(f.name)}<small class="muted">${f.days < 1 ? "<1" : Math.round(f.days)}d</small></button>`).join("")}</div>
      </div>`).join("");
  }

  // Re-fetch recipes whenever what's in the fridge (or how urgent it is) changes
  const key = items.map((i) => `${i.id}:${i.remainingDays < 1 ? 2 : i.remainingDays < 2 ? 1 : i.remainingDays < 4 ? 0 : ""}`).sort().join(",");
  if (key !== recipesKey) { recipesKey = key; loadRecipes(); }
  renderUrgent();
}

// ---------- Pod screen preview (same 16x2 text the ESP32's LCD shows) ----------
let lcdIndex = 0;
function renderLcd() {
  const screens = state?.pod?.lcd?.screens || [];
  if (!screens.length) return;
  lcdIndex %= screens.length;
  const [top, bottom] = screens[lcdIndex];
  $("lcd").textContent = `${top.padEnd(16)}\n${(bottom || "").padEnd(16)}`;
  $("lcd").classList.toggle("alert", top.startsWith("!!"));
}
setInterval(() => { lcdIndex++; renderLcd(); }, 3000);

// ---------- Spoilage forecast ----------
// "⚡ 1.2 days sooner · ripening gas +40%" when conditions make an item spoil noticeably faster
function forecastNote(i) {
  const f = i.forecast;
  if (!f || f.speed < 1.15) return "";
  const lost = f.normalDays - f.remainingDays;
  const howMuch = lost >= 1 ? `${lost.toFixed(lost < 3 ? 1 : 0)} days sooner` : `${Math.max(1, Math.round(lost * 24))}h sooner`;
  return `<span class="fc">⚡ ${howMuch} · ${esc(f.reasons.join(", "))}</span>`;
}

function renderSpeed(c) {
  const lines = [];
  if (c.temp >= 1.15) lines.push(`⚡ Food is spoiling ${c.temp.toFixed(1)}× faster than normal because it's warm`);
  else if (c.temp <= 0.85) lines.push("❄️ Colder than usual: food lasts a bit longer");
  if (c.gas >= 1.15) lines.push(`🍌 Ripening gas is up ${c.gasAbovePct}%: fruit & veg aging ${c.gas.toFixed(1)}× faster`);
  $("podSpeed").innerHTML = lines.length ? lines.map(esc).join("<br>") : "✅ Normal conditions: food is aging at its usual pace";
  $("podSpeed").classList.toggle("fast", lines.some((l) => !l.startsWith("❄️")));
}

// ---------- Settings ----------
const PLACE = { fridge: "🧊 Fridge", freezer: "❄️ Freezer", pantry: "🏠 Pantry / counter" };

function renderSettings() {
  const { pod, config } = state;
  const detected = pod.detectedEnv
    ? `${PLACE[pod.detectedEnv]}${pod.avgTempC != null ? ` (${pod.avgTempC.toFixed(1)}°C)` : ""}`
    : pod.mode === "manual" ? (pod.tempSetting != null ? `${PLACE[pod.env]} from your ${pod.tempSetting}°C` : "needs a pod, using Fridge") : "not sure yet";
  const opts = [["auto", "🤖 Auto (recommended)", `Detected: ${detected}`], ...Object.entries(PLACE).map(([k, v]) => [k, v, ""])];
  $("locationChoices").innerHTML = opts.map(([k, label, sub]) =>
    `<button data-location="${k}" class="${pod.location === k ? "on" : ""}"><span>${label}</span><small>${esc(sub)}</small></button>`).join("");
  $("locationNote").innerHTML = pod.mismatch
    ? `<span class="mismatch">⚠️ You set ${PLACE[pod.location]}, but the temperature looks like ${PLACE[pod.mismatch]}. Was the pod moved?</span>`
    : pod.location !== "auto"
      ? "Using your setting. Switch back to Auto any time."
      : pod.mode === "manual"
        ? "With a pod, this is detected from temperature. Without one, we use your temperature below (or assume a fridge)."
        : "The pod works this out from temperature (15-minute average), so opening the door won't confuse it.";
  $("ntfyInfo").textContent = config.ntfyTopic
    ? `Install the ntfy app and subscribe to "${config.ntfyTopic}".`
    : "Phone alerts are off on this server (no NTFY_TOPIC set).";
  $("tempNote").textContent = pod.mode === "pod"
    ? `Your pod measures this automatically (now ${pod.avgTempC?.toFixed(1)}°C). A saved temperature is only used if the pod goes offline.`
    : "If you know your fridge/freezer/pantry temperature, enter it. Food ages faster when it's warmer. Leave empty for a typical temperature.";
  if (document.activeElement !== $("tempInput")) $("tempInput").value = pod.tempSetting ?? "";
  $("podSourceNote").textContent = pod.mode === "pod"
    ? "A real pod is connected, so the demo pod stays off."
    : "Turn on to simulate a pod (realistic readings + demo buttons) when you don't have the hardware with you.";
  $("demoToggle").checked = pod.demo;
}

const openSettings = () => { renderSettings(); $("settingsSheet").showModal(); };
$("settingsBtn").addEventListener("click", openSettings);
document.addEventListener("click", (e) => { if (e.target.closest("[data-open-settings]")) openSettings(); });
$("settingsClose").addEventListener("click", () => $("settingsSheet").close());
$("locationChoices").addEventListener("click", async (e) => {
  const loc = e.target.closest("[data-location]")?.dataset.location;
  if (!loc) return;
  try {
    await api("/api/settings", { location: loc });
    toast(loc === "auto" ? "Location: auto-detect" : `Location set to ${PLACE[loc]}`);
    await refresh();
  } catch (err) { toast(err.message); }
});
async function saveSettings(body, message) {
  try { await api("/api/settings", body); toast(message); await refresh(); } catch (err) { toast(err.message); }
}
$("demoToggle").addEventListener("change", (e) =>
  saveSettings({ demo: e.target.checked }, e.target.checked ? "Demo pod on" : "Demo pod off"));
$("tempForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("tempInput").value.trim();
  if (v === "") return;
  saveSettings({ tempC: Number(v) }, `Temperature set to ${v}°C`);
  $("tempInput").blur();
});
$("tempClear").addEventListener("click", () => { $("tempInput").value = ""; saveSettings({ tempC: null }, "Using a typical temperature"); });

// ---------- Weekly waste summary ----------
function renderWeekly() {
  const w = state.weekly;
  const total = w.eaten + w.tossed;
  $("weekly").innerHTML = `
    <h2>📊 This week</h2>
    ${total ? `
      <div class="nums">
        <div><b>${w.eaten}</b><small>🎉 eaten</small></div>
        <div><b>${w.tossed}</b><small>🗑️ tossed</small></div>
        <div><b>${w.saveRate}%</b><small>saved</small></div>
      </div>
      <div class="bar" title="${w.saveRate}% saved"><span style="width:${w.saveRate}%"></span></div>
      <p>≈ <b>$${w.moneySaved}</b> of food saved${w.moneyWasted ? `, $${w.moneyWasted} wasted` : ""}.</p>
      ${w.mostTossed && w.mostTossed.count > 1
        ? `<p>💡 You tossed <b>${esc(w.mostTossed.name)}</b> ${w.mostTossed.count}× this week. Try buying less of it.</p>`
        : w.tossed === 0 ? `<p>🌱 Nothing wasted so far this week!</p>` : ""}`
    : `<p class="muted">Tap <b>✓ Ate it</b> or <b>Tossed</b> when food leaves the fridge to see your weekly score.</p>`}`;
}

// ---------- Shopping list ----------
function renderShopping() {
  const list = state.shopping;
  const open = list.filter((s) => !s.done).length;
  $("shopBadge").textContent = open;
  $("shopBadge").classList.toggle("hidden", !open);
  $("shopEmpty").classList.toggle("hidden", list.length > 0);
  $("shopClear").classList.toggle("hidden", !list.some((s) => s.done));
  $("shopList").innerHTML = list.map((s) => `
    <li data-shop="${s.id}" class="${s.done ? "done" : ""}">
      <span class="box">${s.done ? "✓" : ""}</span>
      <span class="name">${esc(s.name)}${s.recipe ? `<span class="from">for ${esc(s.recipe)}</span>` : ""}</span>
    </li>`).join("");
}

async function addToShopping(names, recipe) {
  const { added } = await api("/api/shopping", { names, recipe });
  if (!added.length) return toast("Already on your list");
  toast(`Added ${added.length} to shopping list`, async () => {
    await api("/api/shopping/remove", { ids: added.map((a) => a.id) });
    refresh();
  });
  refresh();
}

// ---------- Edit an item ----------
let editing = null;
function openEdit(id) {
  editing = state.items.find((i) => i.id === id);
  if (!editing) return;
  $("editTitle").textContent = `${editing.emoji} ${editing.name}`;
  $("editDays").value = Math.round(editing.remainingDays * 2) / 2;
  $("editSheet").showModal();
}
$("editSheet").addEventListener("click", (e) => {
  const q = e.target.closest("[data-quick]")?.dataset.quick;
  if (!q) return;
  const cur = Number($("editDays").value) || 0;
  $("editDays").value = q === "half" ? Math.round(cur) / 2 : q.startsWith("+") ? cur + Number(q) : Number(q);
});
$("editSheet").addEventListener("close", async () => {
  if ($("editSheet").returnValue !== "save" || !editing) return;
  const item = editing;
  const before = Math.round(item.remainingDays * 100) / 100;
  try {
    await api(`/api/items/${item.id}/days`, { days: Number($("editDays").value) });
    toast(`${item.name}: ${fmtLeft(Number($("editDays").value))}`, async () => {
      await api(`/api/items/${item.id}/days`, { days: before });
      refresh();
    });
    refresh();
  } catch (err) { toast(err.message); }
});
$("editRemove").addEventListener("click", async () => {
  const item = editing;
  $("editSheet").close("cancel");
  await api(`/api/items/${item.id}/status`, { status: "removed" });
  toast(`Removed ${item.name}`, restore(item.id, item.name));
  refresh();
});

// "Cook today" list: shared by the Fridge card and the Recipes tab
function urgentHtml() {
  return recipes.urgent.map((u) => {
    const head = `<div class="who">${urgencyLabel(u.days)}: ${esc(u.item)}</div>`;
    if (u.recipe) {
      return `<li><img src="${esc(u.recipe.image)}/preview" alt="" loading="lazy">
        <div>${head}<a href="${esc(u.recipe.url)}" target="_blank" rel="noopener">${esc(u.recipe.title)} ↗</a>
        <div class="muted">Also uses: ${u.recipe.uses.filter((n) => n !== u.item).map(esc).join(", ") || "nothing else"}</div></div></li>`;
    }
    return `<li><span class="tipicon">💡</span><div>${head}<div class="tip">${esc(u.tip)}</div></div></li>`;
  }).join("");
}

function renderUrgent() {
  const has = Boolean(recipes?.urgent.length);
  $("cookToday").classList.toggle("hidden", !has);
  $("recipesUrgentBox").classList.toggle("hidden", !has);
  if (has) $("urgentList").innerHTML = $("recipesUrgent").innerHTML = urgentHtml();
}

function recipeCard(r) {
  const urgentIds = new Set(state.items.filter((i) => i.remainingDays < 2).map((i) => i.id));
  return `
    <li>
      <img src="${esc(r.image)}/preview" alt="" loading="lazy">
      <div class="body">
        <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)} ↗</a>
        <div class="chipline">${r.uses.length
          ? r.uses.map((n, k) => `<span class="chip ${urgentIds.has(r.usesFirstIds[k]) ? "urgent" : "have"}">✓ ${esc(n)}</span>`).join("")
          : `<span class="chip need">Uses nothing from your fridge</span>`}</div>
        <div class="need-line">${r.missingCount
          ? `Also need: ${r.missing.slice(0, 3).map(esc).join(", ")}${r.missingCount > 3 ? ` +${r.missingCount - 3} more` : ""}`
          : "✅ You have everything"}</div>
        ${r.missingCount ? `<button class="addlist" data-shoprecipe="${esc(r.id)}">🛒 Add ${r.missingCount} to list</button>` : ""}
      </div>
    </li>`;
}

function renderRecipes() {
  $("recipeList").innerHTML = recipes.fridge.length
    ? recipes.fridge.map(recipeCard).join("")
    : `<li class="muted">No recipes match yet. Add more food to your fridge, or search above.</li>`;
}

// ---------- Recipe search (ranked by what's in your fridge) ----------
let searchResults = [];
async function searchRecipes(q) {
  $("searchBox").classList.remove("hidden");
  $("fridgeRecipes").classList.add("hidden");
  $("searchTitle").textContent = `Results for “${q}”`;
  $("searchList").innerHTML = `<li class="muted">Searching…</li>`;
  try {
    ({ results: searchResults } = await api(`/api/recipes/search?q=${encodeURIComponent(q)}`));
    $("searchList").innerHTML = searchResults.length
      ? searchResults.map(recipeCard).join("")
      : `<li class="muted">No recipes found for “${esc(q)}”. Try one word, like “pasta” or “chicken”.</li>`;
  } catch (err) {
    $("searchList").innerHTML = `<li class="muted">Search failed: ${esc(err.message)}</li>`;
  }
}
$("recipeSearch").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("recipeQuery").value.trim();
  if (q.length >= 2) searchRecipes(q);
});
$("searchClear").addEventListener("click", () => {
  $("recipeQuery").value = "";
  $("searchBox").classList.add("hidden");
  $("fridgeRecipes").classList.remove("hidden");
});

async function loadRecipes() {
  try {
    recipes = await api("/api/recipes", {});
    renderUrgent();
    renderRecipes();
  } catch (e) {
    $("recipeList").innerHTML = `<li class="muted">Couldn't load recipes: ${esc(e.message)}</li>`;
  }
}

async function refresh() {
  try {
    state = await api("/api/state");
    render();
  } catch {
    $("podStatus").textContent = "server offline";
    $("podStatus").classList.remove("live");
  }
}

function showTab(name) {
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${name}`));
  window.scrollTo(0, 0);
}

// ---------- Actions ----------
const restore = (id, name) => async () => {
  await api(`/api/items/${id}/restore`, {});
  toast(`${name} is back in the fridge`);
  refresh();
};

async function addItems(list) {
  const { added } = await api("/api/items", { items: list });
  const label = added.length === 1 ? added[0].name : `${added.length} items`;
  // Undo an accidental add = mark it "removed" (doesn't count as waste)
  toast(`Added ${label}`, async () => {
    for (const a of added) await api(`/api/items/${a.id}/status`, { status: "removed" });
    toast(`Removed ${label}`);
    refresh();
  });
  refresh();
}

document.addEventListener("click", async (e) => {
  const edit = e.target.closest("[data-edit]");
  if (edit) return openEdit(edit.dataset.edit);
  const shop = e.target.closest("[data-shop]");
  if (shop) {
    await api(`/api/shopping/${shop.dataset.shop}/toggle`, {}).catch((err) => toast(err.message));
    return refresh();
  }
  const btn = e.target.closest("button");
  if (!btn || btn.id === "toastUndo") return;
  try {
    if (btn.dataset.tab) showTab(btn.dataset.tab);
    else if (btn.dataset.tabJump) showTab(btn.dataset.tabJump);
    else if (btn.dataset.shoprecipe) {
      const r = [...recipes.fridge, ...searchResults].find((x) => x.id === btn.dataset.shoprecipe);
      await addToShopping(r.missingAll, r.title);
    } else if (btn.id === "shopClear") {
      const done = state.shopping.filter((s) => s.done);
      await api("/api/shopping/remove", { ids: done.map((s) => s.id) });
      toast(`Cleared ${done.length} item(s)`);
      refresh();
    }
    else if (btn.dataset.done) {
      const { done: id, status, name } = btn.dataset;
      await api(`/api/items/${id}/status`, { status });
      toast(status === "eaten" ? `Ate ${name}: food saved! 🎉` : `Tossed ${name}`, restore(id, name));
      refresh();
    } else if (btn.dataset.restore) {
      await restore(btn.dataset.restore, btn.dataset.name)();
    } else if (btn.dataset.add) {
      await addItems([{ name: btn.dataset.add }]);
    } else if (btn.dataset.sim) {
      await api("/api/sim", { scenario: btn.dataset.sim });
      refresh();
    } else if (btn.id === "calibrateBtn") {
      const r = await api("/api/calibrate", {});
      toast(`Gas baseline set to ${r.gasBaseline}`);
    } else if (btn.id === "testAlertBtn") {
      await api("/api/test-alert", {});
      toast("Test alert sent");
      refresh();
    } else if (btn.id === "recipesRefresh") {
      $("recipeList").innerHTML = `<li class="muted">Loading recipes…</li>`;
      await loadRecipes();
    } else if (btn.id === "addScanned") {
      const picked = [...document.querySelectorAll("#scanResult input:checked")].map((c) => scanned[c.value]);
      if (!picked.length) return;
      $("scanResult").innerHTML = "";
      await addItems(picked);
    }
  } catch (err) {
    toast(err.message);
  }
});

$("shopAdd").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("shopName").value.trim();
  if (!name) return;
  try { await addToShopping([name], null); $("shopName").value = ""; } catch (err) { toast(err.message); }
});

// "Type any food": we estimate how long it lasts as you type; the user can change the days
let estTimer = null;
let estFor = "";
$("customName").addEventListener("input", () => {
  clearTimeout(estTimer);
  const name = $("customName").value.trim();
  if (name.length < 2) { $("customEstimate").classList.add("hidden"); return; }
  estTimer = setTimeout(async () => {
    try {
      const est = await api(`/api/estimate?name=${encodeURIComponent(name)}`);
      if ($("customName").value.trim() !== name) return; // user kept typing
      estFor = name;
      $("estEmoji").textContent = est.emoji;
      $("customDays").value = Math.round(est.life.fridge * 2) / 2;
      $("estHint").textContent = est.matched
        ? `Estimated from “${est.matched}”. Change it if the pack says otherwise.`
        : "We don't know this one, so we guessed. Change it if you know better.";
      $("customEstimate").classList.remove("hidden");
    } catch {}
  }, 250);
});
$("customAdd").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("customName").value.trim();
  if (!name) return toast("Type a food name");
  const days = Number($("customDays").value);
  try {
    // No days (or an estimate for different text)? The server estimates from the name.
    await addItems([estFor === name && days > 0 ? { name, days } : { name }]);
    $("customName").value = "";
    $("customEstimate").classList.add("hidden");
  } catch (err) { toast(err.message); }
});

// ---------- Photo scan ----------
let scanned = [];

// Shrink the photo before upload: faster and cheaper
function shrink(file, max = 1024) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

$("photoInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  $("scanResult").innerHTML = `<p class="muted">Looking at your groceries…</p>`;
  try {
    const { items } = await api("/api/scan", { image: await shrink(file) });
    scanned = items;
    $("scanResult").innerHTML = items.length
      ? items.map((i, n) => `<label><input type="checkbox" value="${n}" checked> ${i.emoji || "🍽️"} ${esc(i.name)}
          <span class="muted">· ${i.life.fridge}d fridge</span></label>`).join("") +
        `<button id="addScanned">Add selected</button>`
      : `<p class="muted">No food found. Try another photo.</p>`;
  } catch (err) {
    $("scanResult").innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
});

// ---------- Barcode scanner (free: zxing-cpp in the browser + Open Food Facts) ----------
// We run our own camera loop so every frame is decoded at full camera resolution.
// (Shrinking frames to the on-screen box, as many scanner widgets do, blurs the thin bars together.)
const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"];
let detector = null;
let stream = null;
let scanning = false;
let product = null; // last looked-up product
const frame = document.createElement("canvas");
const frameCtx = frame.getContext("2d", { willReadFrequently: true });

const bcStatus = (msg) => { $("bcStatus").textContent = msg; };

// The phone's built-in barcode reader when it has one (Android Chrome), otherwise zxing-cpp (WebAssembly)
async function getDetector() {
  if (detector) return detector;
  const forceZxing = new URLSearchParams(location.search).has("zxing"); // test the iPhone path on a desktop
  if (!forceZxing && "BarcodeDetector" in window) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      if (FORMATS.every((f) => supported.includes(f))) return (detector = new window.BarcodeDetector({ formats: FORMATS }));
    } catch {}
  }
  const zx = window.BarcodeDetectionAPI;
  if (!zx) throw new Error("Scanner didn't load");
  zx.prepareZXingModule({
    overrides: { locateFile: (path, prefix) => (path.endsWith(".wasm") ? `vendor/${path}` : prefix + path) },
    fireImmediately: true,
  });
  return (detector = new zx.BarcodeDetector({ formats: FORMATS }));
}

// ---- Camera permission: explain first, then let the phone ask ----
const CAM_OK_KEY = "emf-camera-ok";
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const isAndroid = /Android/.test(navigator.userAgent);

async function cameraPermission() {
  try { return (await navigator.permissions.query({ name: "camera" })).state; } // granted | prompt | denied
  catch { return "unknown"; } // older Safari can't tell us
}
function rememberedCameraOk() {
  try { return localStorage.getItem(CAM_OK_KEY) === "1"; } catch { return false; }
}

function showCamAsk() {
  bcStatus("");
  $("camAsk").innerHTML = `
    <div class="cam-icon">📷</div>
    <b class="cam-title">Allow camera to scan barcodes</b>
    <p class="muted">The camera is only used while this screen is open, to read barcodes. Nothing is recorded or uploaded.</p>
    <button class="wide" data-cam="allow">Allow camera</button>
    <p class="muted small">Your phone will ask next. Tap <b>Allow</b>.</p>`;
  $("camAsk").classList.remove("hidden");
}

function showCamBlocked() {
  bcStatus("");
  const chromeIOS = isIOS && /CriOS/.test(navigator.userAgent);
  const steps = chromeIOS
    ? ["Open your iPhone <b>Settings</b>", "Tap <b>Apps → Chrome</b>", "Turn on <b>Camera</b>", "Come back and tap <b>Try again</b>"]
    : isIOS
      ? ["Tap <b>aA</b> in the address bar", "Tap <b>Website Settings</b>", "Set <b>Camera</b> to <b>Allow</b>", "Tap <b>Try again</b>"]
      : isAndroid
        ? ["Tap the <b>⚙ / 🔒</b> icon next to the web address", "Tap <b>Permissions → Camera</b>", "Choose <b>Allow</b>", "Tap <b>Try again</b>"]
        : ["Click the <b>🔒</b> icon next to the web address", "Set <b>Camera</b> to <b>Allow</b>", "Click <b>Try again</b>"];
  $("camAsk").innerHTML = `
    <div class="cam-icon">🚫</div>
    <b class="cam-title">Camera is blocked for this site</b>
    <ol>${steps.map((x) => `<li>${x}</li>`).join("")}</ol>
    <button class="wide" data-cam="allow">Try again</button>
    <p class="muted small">Or skip the camera: use a photo of the barcode or type its number below.</p>`;
  $("camAsk").classList.remove("hidden");
  $("bcAlt").open = true;
}

async function openScanner() {
  $("barcodeSheet").showModal();
  $("bcAlt").open = false;
  $("bcResult").innerHTML = "";
  $("camAsk").classList.add("hidden");
  if (!window.isSecureContext) {
    bcStatus("The camera only works on the https:// link of this app. Use a photo or type the number below.");
    $("bcAlt").open = true;
    return;
  }
  const state = await cameraPermission();
  if (state === "granted" || (state === "unknown" && rememberedCameraOk())) startCamera();
  else if (state === "denied") showCamBlocked();
  else showCamAsk();
}

async function startCamera() {
  $("bcResult").innerHTML = "";
  $("camAsk").classList.add("hidden");
  bcStatus("Starting camera…");
  let det;
  try { det = await getDetector(); } catch {
    bcStatus("Scanner didn't load. Use a photo or type the number below.");
    $("bcAlt").open = true;
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      // Ask for HD: more pixels per bar means sharper reads from further away
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (err) {
    const msg = String(err?.name || err);
    if (/NotAllowed|Permission|denied|Security/i.test(msg)) {
      try { localStorage.removeItem(CAM_OK_KEY); } catch {}
      showCamBlocked();
    } else if (/NotFound|Overconstrained/i.test(msg)) {
      bcStatus("No camera found on this device. Use a photo or type the number below.");
      $("bcAlt").open = true;
    } else {
      bcStatus("Can't open the camera right now. Close other apps using it, or use a photo / type the number below.");
      $("bcAlt").open = true;
    }
    return;
  }
  try { localStorage.setItem(CAM_OK_KEY, "1"); } catch {}

  const track = stream.getVideoTracks()[0];
  try { await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }); } catch {} // keep refocusing where supported
  setupTorch(track);
  const video = $("bcVideo");
  video.srcObject = stream;
  await video.play().catch(() => {});
  $("reader").classList.remove("hidden");
  scanning = true;
  bcStatus("Fit the barcode inside the box and hold steady");
  scanLoop(det, video);
}

async function scanLoop(det, video) {
  const started = Date.now();
  let hinted = false;
  let n = 0;
  while (scanning) {
    if (video.readyState >= 2 && video.videoWidth) {
      const vw = video.videoWidth, vh = video.videoHeight;
      frameCtx.imageSmoothingQuality = "high";
      if (n++ % 2 === 0) {
        // Middle band of the full-resolution frame (around the aim box)
        const sh = Math.round(vh * 0.6), sy = Math.round((vh - sh) / 2);
        const scale = Math.min(1, 1600 / vw);
        frame.width = Math.round(vw * scale);
        frame.height = Math.round(sh * scale);
        frameCtx.drawImage(video, 0, sy, vw, sh, 0, 0, frame.width, frame.height);
      } else {
        // 2x zoom into the centre, so small or far-away barcodes get more pixels per bar
        const cw = Math.round(vw * 0.5), ch = Math.round(vh * 0.3);
        const scale = Math.min(2, 1600 / cw);
        frame.width = Math.round(cw * scale);
        frame.height = Math.round(ch * scale);
        frameCtx.drawImage(video, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, frame.width, frame.height);
      }
      try {
        const hit = (await det.detect(frame)).find((b) => FORMATS.includes(b.format) && b.rawValue);
        if (hit && scanning) return onBarcode(hit.rawValue);
      } catch {}
      if (!hinted && Date.now() - started > 8000) {
        hinted = true;
        bcStatus("Still looking… hold the phone 15–25 cm away so the bars look sharp, and add more light.");
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function setupTorch(track) {
  const btn = $("torchBtn");
  const caps = track.getCapabilities?.() || {};
  btn.classList.toggle("hidden", !caps.torch);
  btn.classList.remove("on");
  btn.onclick = async () => {
    const on = !btn.classList.contains("on");
    try { await track.applyConstraints({ advanced: [{ torch: on }] }); btn.classList.toggle("on", on); } catch {}
  };
}

async function stopCamera() {
  scanning = false;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  $("bcVideo").srcObject = null;
  $("reader").classList.add("hidden");
}

async function onBarcode(code) {
  navigator.vibrate?.(80);
  await stopCamera();
  lookupBarcode(code);
}

// Backup: if our server can't reach Open Food Facts, ask it straight from the phone
async function lookupFromPhone(code) {
  const fields = "product_name,generic_name,brands,categories_tags,image_front_small_url,quantity";
  const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${fields}`);
  const data = res.status === 404 ? { status: 0 } : await res.json();
  return api("/api/barcode/classify", { code, data });
}

async function lookupBarcode(code) {
  bcStatus(`Looking up ${code}…`);
  $("bcResult").innerHTML = "";
  try {
    product = await api(`/api/barcode/${encodeURIComponent(code)}`);
  } catch (err) {
    if (err.status && err.status < 500) {        // e.g. not a product barcode
      bcStatus(err.message);
      $("bcResult").innerHTML = `<button class="wide" data-bc="again">Scan again</button>`;
      return;
    }
    try { product = await lookupFromPhone(code); } catch {
      bcStatus("Couldn't reach the product database. Check your internet and try again.");
      $("bcResult").innerHTML = `<div class="row"><button data-bc="retry" data-code="${esc(code)}">Try again</button>
        <button class="secondary" data-bc="again">Scan another</button></div>`;
      return;
    }
  }
  renderProduct();
}

function renderProduct() {
  const p = product;
  if (p.found) {
    bcStatus("Found it! Check the days, then add it.");
    $("bcResult").innerHTML = `
      <div class="product">
        ${p.image ? `<img src="${esc(p.image)}" alt="">` : `<span class="emoji-big">${p.emoji}</span>`}
        <div><b>${esc(p.name)}</b><span class="muted">${esc([p.brand, p.quantity].filter(Boolean).join(" · "))}</span></div>
      </div>
      <div class="days-row">Lasts about <input id="bcDays" type="number" min="0.5" step="0.5" value="${p.life.fridge}"> days in the fridge</div>
      <p class="muted">${p.guessed ? "We couldn't tell what kind of food this is, so check the date on the pack." : "Estimated from the product type. Change it if the pack says otherwise."}</p>
      <div class="row"><button data-bc="add">Add to fridge</button><button class="secondary" data-bc="again">Scan another</button></div>`;
  } else if (p.storeLabel) {
    // Price sticker from the store's own scale: no product info exists, so ask what it is
    bcStatus("That's a store price sticker (meat, deli or produce counter). What is it?");
    const fresh = state.quickAdd.filter((s) => s.section === "Meat & Seafood" || s.section === "Produce")
      .flatMap((s) => s.foods).slice(0, 18);
    $("bcResult").innerHTML = `
      <div class="picks">${fresh.map((f) => `<button data-bc="pick" data-name="${esc(f.name)}">${f.emoji} ${esc(f.name)}</button>`).join("")}</div>
      <input id="bcName" type="text" placeholder="…or type it, e.g. turkey slices" maxlength="60">
      <div class="row"><button data-bc="add">Add to fridge</button><button class="secondary" data-bc="again">Scan another</button></div>`;
  } else {
    bcStatus(`Barcode ${p.code} isn't in the free product database yet. What is it?`);
    $("bcResult").innerHTML = `
      <input id="bcName" type="text" placeholder="e.g. Oat milk" maxlength="60">
      <div class="days-row">Lasts about <input id="bcDays" type="number" min="0.5" step="0.5" placeholder="auto"> days <span class="muted small">(leave empty and we'll estimate)</span></div>
      <div class="row"><button data-bc="add">Add to fridge</button><button class="secondary" data-bc="again">Scan another</button></div>`;
    $("bcName").focus();
  }
}

async function addScannedProduct(pickedName) {
  let item;
  if (product.found) {
    const days = Number($("bcDays").value);
    if (!(days > 0)) return toast("Enter how many days it lasts");
    const scale = days / product.life.fridge; // keep freezer/pantry in proportion to the edited fridge days
    item = {
      name: product.name,
      emoji: product.emoji,
      image: product.image,
      kind: product.kind,
      life: Object.fromEntries(Object.entries(product.life).map(([k, v]) => [k, v * scale])),
    };
  } else {
    const name = pickedName || $("bcName").value.trim();
    if (!name) return toast("Type what it is, or tap one of the choices");
    const days = Number($("bcDays")?.value);
    item = days > 0 ? { name, days } : { name }; // no days -> estimated from the name
  }
  await addItems([item]);
  startCamera(); // groceries come in batches: go straight to the next one
}

$("barcodeBtn").addEventListener("click", openScanner);
$("camAsk").addEventListener("click", (e) => {
  if (e.target.closest("[data-cam]")) startCamera(); // this tap is what lets the phone show its own prompt
});
$("bcClose").addEventListener("click", () => $("barcodeSheet").close());
$("barcodeSheet").addEventListener("close", stopCamera);
$("bcResult").addEventListener("click", async (e) => {
  const action = e.target.closest("[data-bc]")?.dataset.bc;
  try {
    if (action === "add") await addScannedProduct();
    if (action === "pick") await addScannedProduct(e.target.closest("[data-name]").dataset.name);
    if (action === "again") startCamera();
    if (action === "retry") lookupBarcode(e.target.closest("[data-code]").dataset.code);
  } catch (err) { toast(err.message); }
});
$("bcManual").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("bcCode").value.replace(/\D/g, "");
  if (!code) return;
  await stopCamera();
  lookupBarcode(code);
});
$("bcPhoto").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  await stopCamera();
  bcStatus("Reading the barcode in your photo…");
  try {
    const det = await getDetector();
    const hit = (await det.detect(await createImageBitmap(file))).find((b) => FORMATS.includes(b.format) && b.rawValue);
    if (!hit) throw new Error("none");
    lookupBarcode(hit.rawValue);
  } catch {
    bcStatus("No barcode found in that photo. Fill the photo with the barcode, keep it sharp and well lit, or type the number.");
  }
});

refresh();
setInterval(refresh, 3000);
