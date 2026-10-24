// Eat Me First web app - plain JS, polls the server every 3 seconds.
const $ = (id) => document.getElementById(id);
let state = null;
let quickAddBuilt = false;

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

function toast(msg) {
  $("toast").textContent = msg;
  $("toast").classList.remove("hidden");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $("toast").classList.add("hidden"), 3000);
}

function fmtLeft(d) {
  if (d <= 0) return "Expired";
  if (d < 1) return `${Math.max(1, Math.round(d * 24))} hours left`;
  return `${d.toFixed(d < 3 ? 1 : 0)} days left`;
}

const ENV_LABEL = { fridge: "🧊 In the fridge", freezer: "❄️ In the freezer", pantry: "🏠 On the counter / pantry" };
const fmt = (v, digits = 1) => (v == null ? "--" : Number(v).toFixed(digits));

// ---------- Rendering ----------
function render() {
  const { pod, items, alerts, sim, config } = state;
  const live = pod.lastSeen && Date.now() - pod.lastSeen < 15000;
  $("podStatus").textContent = live ? (pod.latest?.source === "simulator" ? "demo pod" : "pod live") : "pod offline";
  $("podStatus").classList.toggle("live", Boolean(live));

  $("podEnv").textContent = ENV_LABEL[pod.env] || "Detecting…";
  $("podTemp").textContent = fmt(pod.latest?.tempC);
  $("podAvg").textContent = fmt(pod.avgTempC);
  $("podHum").textContent = fmt(pod.latest?.humidity, 0);
  $("podGas").textContent = pod.latest?.gas ?? "--";
  $("podBase").textContent = pod.gasBaseline ?? "--";
  const warm = pod.warmMinutes > 0;
  $("podWarn").classList.toggle("hidden", !warm);
  if (warm) $("podWarn").textContent = `⚠️ Fridge above 7°C for ${pod.warmMinutes} min (alert at ${config.warmAlertMin})`;

  $("emptyItems").classList.toggle("hidden", items.length > 0);
  $("itemList").innerHTML = items.map((i) => `
    <li class="${i.remainingDays < 2 ? "urgent" : i.remainingDays < 4 ? "soon" : ""}">
      <span class="emoji">${i.emoji}</span>
      <div class="info"><div class="name">${esc(i.name)}</div><div class="left">${fmtLeft(i.remainingDays)}</div></div>
      <button data-done="${i.id}" data-status="eaten" title="Ate it">✅</button>
      <button data-done="${i.id}" data-status="tossed" class="secondary" title="Threw it out">🗑️</button>
    </li>`).join("");

  $("alertList").innerHTML = alerts.length
    ? alerts.slice(0, 6).map((a) => `<li><b>${esc(a.title)}</b>${esc(a.message)}<br><time>${new Date(a.t).toLocaleTimeString()}</time></li>`).join("")
    : `<li class="muted">No alerts yet.</li>`;

  $("simButtons").innerHTML = Object.entries(sim.scenarios).map(([k, s]) =>
    `<button data-sim="${k}" class="${sim.scenario === k ? "on" : ""}">${esc(s.label)}</button>`).join("");
  $("ntfyInfo").textContent = config.ntfyTopic
    ? `Phone alerts: install the ntfy app and subscribe to "${config.ntfyTopic}".`
    : "Phone alerts are off: set NTFY_TOPIC in .env.";

  $("scanHint").textContent = state.photoScan
    ? "Take a photo and we'll list the food in it."
    : "Photo scan is off (no Claude API key). Use quick add below.";
  $("photoLabel").classList.toggle("hidden", !state.photoScan);

  if (!quickAddBuilt) {
    quickAddBuilt = true;
    $("quickAdd").innerHTML = state.catalog.map((c) =>
      `<button data-add="${esc(c.name)}"><span>${c.emoji}</span>${esc(c.name)}</button>`).join("");
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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

// ---------- Actions ----------
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  try {
    if (btn.dataset.tab) {
      document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${btn.dataset.tab}`));
    } else if (btn.dataset.done) {
      await api(`/api/items/${btn.dataset.done}/status`, { status: btn.dataset.status });
      toast(btn.dataset.status === "eaten" ? "Nice, food saved! 🎉" : "Logged as wasted");
      refresh();
    } else if (btn.dataset.add) {
      await api("/api/items", { name: btn.dataset.add });
      toast(`Added ${btn.dataset.add}`);
      refresh();
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
    } else if (btn.id === "recipesBtn") {
      await loadRecipes(btn);
    } else if (btn.id === "addScanned") {
      const picked = [...document.querySelectorAll("#scanResult input:checked")].map((c) => scanned[c.value]);
      if (!picked.length) return;
      await api("/api/items", { items: picked });
      $("scanResult").innerHTML = "";
      toast(`Added ${picked.length} item(s)`);
      refresh();
    }
  } catch (err) {
    toast(err.message);
  }
});

async function loadRecipes(btn) {
  btn.disabled = true;
  btn.textContent = "Finding recipes…";
  try {
    const { recipes } = await api("/api/recipes", {});
    $("recipeList").innerHTML = recipes.length
      ? recipes.map((r) => `
        <li>
          <img src="${esc(r.image)}/preview" alt="" loading="lazy">
          <div><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a>
          <div class="uses">Uses: ${r.uses.map(esc).join(", ")}</div></div>
        </li>`).join("")
      : `<li class="muted">No matches found. Try adding more items.</li>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Find recipes";
  }
}

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
