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
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
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
  const { pod, items, alerts, sim, config, stats } = state;
  const live = pod.lastSeen && Date.now() - pod.lastSeen < 15000;
  $("podStatus").textContent = live ? (pod.latest?.source === "simulator" ? "demo pod" : "pod live") : "pod offline";
  $("podStatus").classList.toggle("live", Boolean(live));

  $("stats").innerHTML = `
    <div><b>${items.length}</b><small>in the fridge</small></div>
    <div><b>${stats.eaten}</b><small>🎉 eaten (saved)</small></div>
    <div><b>${stats.tossed}</b><small>🗑️ tossed (wasted)</small></div>`;

  // Pod
  $("podEnv").textContent = ENV_LABEL[pod.env] || "Detecting…";
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
        <span class="emoji">${i.emoji}</span>
        <div class="info"><div class="name">${esc(i.name)}</div><div class="left">${fmtLeft(i.remainingDays)}</div></div>
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
    <li><span>${r.emoji}</span><span class="grow">${esc(r.name)}</span>
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

  $("scanHint").textContent = state.photoScan
    ? "Take a photo and we'll list the food in it."
    : "Photo scan is off (no Claude API key). Use Add anything or quick add below.";
  $("photoLabel").classList.toggle("hidden", !state.photoScan);

  if (!quickAddBuilt) {
    quickAddBuilt = true;
    $("quickAdd").innerHTML = state.catalog.map((c) =>
      `<button data-add="${esc(c.name)}"><span>${c.emoji}</span>${esc(c.name)}</button>`).join("");
  }

  // Re-fetch recipes whenever what's in the fridge changes
  const key = items.map((i) => i.id).sort().join(",");
  if (key !== recipesKey) { recipesKey = key; loadRecipes(); }
  renderUrgent();
}

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

function renderRecipes() {
  $("recipeList").innerHTML = recipes.fridge.length
    ? recipes.fridge.map((r) => {
      const urgentIds = new Set(state.items.filter((i) => i.remainingDays < 2).map((i) => i.id));
      return `
        <li>
          <img src="${esc(r.image)}/preview" alt="" loading="lazy">
          <div class="body">
            <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)} ↗</a>
            <div class="chipline">${r.uses.map((n, k) =>
              `<span class="chip ${urgentIds.has(r.usesIds[k]) ? "urgent" : "have"}">✓ ${esc(n)}</span>`).join("")}</div>
            <div class="chipline">${r.missingCount
              ? `<span class="muted chip">Need to buy:</span>` + r.missing.map((m) => `<span class="chip need">${esc(m)}</span>`).join("") + (r.missingCount > r.missing.length ? `<span class="chip need">+${r.missingCount - r.missing.length} more</span>` : "")
              : `<span class="chip have">You have everything!</span>`}</div>
          </div>
        </li>`;
    }).join("")
    : `<li class="muted">No recipes match yet. Add more food to your fridge.</li>`;
}

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
  const btn = e.target.closest("button");
  if (!btn || btn.id === "toastUndo") return;
  try {
    if (btn.dataset.tab) showTab(btn.dataset.tab);
    else if (btn.dataset.tabJump) showTab(btn.dataset.tabJump);
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

// "Add anything": we only know fridge days, so estimate the rest
$("customAdd").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("customName").value.trim();
  const days = Number($("customDays").value);
  if (!name || !(days > 0)) return;
  try {
    await addItems([{ name, life: { fridge: days, freezer: Math.max(30, days * 10), pantry: Math.max(0.1, days / 3) } }]);
    $("customName").value = "";
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

refresh();
setInterval(refresh, 3000);
