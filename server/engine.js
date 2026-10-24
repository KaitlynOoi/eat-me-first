// Core logic: environment detection, shelf-life aging, and alert rules.
import crypto from "node:crypto";
import * as store from "./store.js";
import { QUICK_ADD, SEED, estimate, findFood } from "./foods.js";
import { notify } from "./ntfy.js";

const num = (k, d) => (process.env[k] ? Number(process.env[k]) : d);
export const CFG = {
  avgWindowMin: num("AVG_WINDOW_MIN", 15),
  warmAlertMin: num("WARM_ALERT_MIN", 60),
  warmThresholdC: 7,
  gasRisePct: num("GAS_RISE_PCT", 25),
  gasCooldownMin: num("GAS_ALERT_COOLDOWN_MIN", 30),
  expiryAlertDays: num("EXPIRY_ALERT_DAYS", 2),
  demoSpeed: num("DEMO_SPEED", 1),
};

const MIN = 60_000;
const DAY = 86_400_000;
const HISTORY_KEEP_MS = 2 * 60 * MIN;
const GAS_WARMUP_READINGS = 10;

// In-memory state (persisted to the store where it matters)
let history = [];          // [{t, tempC, humidity, gas}]
let items = {};            // id -> item
let alerts = [];           // newest first
let shopping = {};         // id -> {id, name, done, recipe, addedAt}
let pod = {
  env: null,               // "freezer" | "fridge" | "pantry" | null
  avgTempC: null,
  warmSince: null,         // ms timestamp when fridge went > 7°C
  warmAlerted: false,
  gasBaseline: null,
  lastGasAlert: 0,
  lastSeen: null,
};
let settings = {
  location: "auto",        // "auto" (detect from temperature) | "fridge" | "freezer" | "pantry"
  tempC: null,             // the user's own temperature, used when no pod is sending readings
  demo: false,             // run the demo pod (simulated readings) while no real pod is connected
};
let realPodSeenAt = 0;     // last reading from real hardware (not the simulator)
let lastSeq = null;
let onExpiring = null;     // hook for recipe suggestions, set by index.js

export function setExpiringHook(fn) { onExpiring = fn; }

export async function load() {
  items = (await store.get("items")) || {};
  shopping = (await store.get("shopping")) || {};
  const savedPod = await store.get("podState");
  if (savedPod) pod = { ...pod, ...savedPod, warmSince: null, warmAlerted: false };
  settings = { ...settings, ...((await store.get("settings")) || {}) };
  const savedAlerts = await store.get("alerts");
  alerts = savedAlerts ? Object.values(savedAlerts).sort((a, b) => b.t - a.t) : [];
  if (Object.keys(items).length === 0) {
    for (const s of SEED) await addItem({ name: s.name, used: s.used });
  }
}

// ---------- Readings ----------
// Called for every new reading, from the ESP32 (via Firebase or HTTP) or the simulator.
export async function ingest(reading) {
  if (reading.seq != null && reading.seq === lastSeq) return; // same reading polled twice
  if (reading.source === "simulator" && !settings.demo) return; // demo pod switched off
  lastSeq = reading.seq ?? null;
  const t = Date.now();
  history.push({
    t,
    tempC: num0(reading.tempC),
    humidity: num0(reading.humidity),
    gas: num0(reading.gas),
    source: reading.source || "pod",
  });
  history = history.filter((r) => t - r.t <= HISTORY_KEEP_MS);
  pod.lastSeen = t;
  if (reading.source !== "simulator") realPodSeenAt = t;
  await evaluate();
}

function num0(v) { return v == null || Number.isNaN(Number(v)) ? null : Number(v); }

function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }

// Strict reading of the temperature alone (null when it's in between ranges)
function detectNow(avgTemp) {
  if (avgTemp == null) return null;
  if (avgTemp < -10) return "freezer";
  if (avgTemp >= 0 && avgTemp <= 5) return "fridge";
  if (avgTemp >= 15 && avgTemp <= 25) return "pantry";
  return null;
}

function classify(avgTemp, prev) {
  if (avgTemp == null) return prev;
  if (avgTemp < -10) return "freezer";
  if (avgTemp >= 0 && avgTemp <= 5) return "fridge";
  if (avgTemp >= 15 && avgTemp <= 25) return "pantry";
  // In-between temps (door open, warming fridge): keep the last known environment
  if (prev) return prev;
  // First boot in an in-between range: pick the closest
  if (avgTemp < 0) return "freezer";
  if (avgTemp < 10) return "fridge";
  return "pantry";
}

async function evaluate() {
  const now = Date.now();
  const window = history.filter((r) => now - r.t <= CFG.avgWindowMin * MIN && r.tempC != null);
  pod.avgTempC = avg(window.map((r) => r.tempC));
  pod.env = classify(pod.avgTempC, pod.env); // what the pod detects (used when location is "auto")

  await checkWarmFridge(now);
  await checkGas(now);
  await store.set("podState", pod);
}

// Fridge sustained above 7°C (15-min average) for WARM_ALERT_MIN -> food safety alert
async function checkWarmFridge(now) {
  const warm = pod.avgTempC != null && pod.avgTempC > CFG.warmThresholdC;
  if (!warm) { pod.warmSince = null; pod.warmAlerted = false; return; }
  if (pod.warmSince == null) {
    if (currentEnv() !== "fridge") return;   // only a fridge can be "too warm"
    pod.warmSince = now;
  }
  const mins = (now - pod.warmSince) / MIN;
  if (!pod.warmAlerted && mins >= CFG.warmAlertMin) {
    pod.warmAlerted = true;
    const risky = activeItems().filter((i) => i.life.fridge < 10).map((i) => i.name);
    await raise("safety", "Fridge too warm",
      `Your fridge has averaged ${pod.avgTempC.toFixed(1)}°C for ${Math.round(mins)} min (safe is under 5°C). ` +
      (risky.length ? `Check: ${risky.join(", ")}.` : "Check perishables."),
      { priority: 5, tags: "warning,thermometer" });
  }
}

// Gas rising steadily above the calibrated baseline -> ripening alert
async function checkGas(now) {
  const gasReadings = history.filter((r) => r.gas != null);
  if (pod.gasBaseline == null && gasReadings.length >= GAS_WARMUP_READINGS) {
    pod.gasBaseline = Math.round(avg(gasReadings.slice(-GAS_WARMUP_READINGS).map((r) => r.gas)));
  }
  if (pod.gasBaseline == null) return;
  const last = gasReadings.slice(-6).map((r) => r.gas);
  if (last.length < 6) return;
  const threshold = pod.gasBaseline * (1 + CFG.gasRisePct / 100);
  const allAbove = last.slice(-3).every((g) => g > threshold);
  const rising = avg(last.slice(3)) > avg(last.slice(0, 3));
  const cooledDown = now - pod.lastGasAlert > CFG.gasCooldownMin * MIN;
  if (allAbove && rising && cooledDown) {
    pod.lastGasAlert = now;
    // Ripening gas comes from fruit and veg, so list those first
    const produce = activeItems().filter((i) => sectionOf(i) === "Produce");
    const soon = (produce.length ? produce : activeItems()).slice(0, 3).map((i) => `${i.name} (${fmtDays(i.remainingDays)})`);
    await raise("ripening", "Something is ripening",
      `Gas level is ${Math.round((last.at(-1) / pod.gasBaseline - 1) * 100)}% above normal and climbing. ` +
      `Check these first: ${soon.join(", ") || "your produce"}.`,
      { priority: 4, tags: "banana,nose" });
  }
}

export async function calibrateGas() {
  const recent = history.filter((r) => r.gas != null).slice(-GAS_WARMUP_READINGS);
  if (!recent.length) throw new Error("No gas readings yet");
  pod.gasBaseline = Math.round(avg(recent.map((r) => r.gas)));
  pod.lastGasAlert = 0;
  await store.set("podState", pod);
  return pod.gasBaseline;
}

// ---------- Items ----------
// Add anything. Shelf life comes from (first that's given):
//   life (all three places) -> days (fridge days, others scaled) -> our estimate from the name
export async function addItem({ name, emoji, life, days, image, kind, used = 0 }) {
  name = String(name ?? "").trim().slice(0, 60);
  if (!name) throw Object.assign(new Error("Type a food name"), { status: 400 });
  const est = estimate(name);
  let full = est.life;
  if (life && Number(life.fridge) > 0) full = life;
  else if (Number(days) > 0) {
    const scale = Number(days) / est.life.fridge;
    full = Object.fromEntries(Object.entries(est.life).map(([k, v]) => [k, v * scale]));
  }
  const item = {
    id: crypto.randomUUID().slice(0, 8),
    name,
    emoji: emoji || est.emoji,
    // Product photo from a barcode scan (only Open Food Facts images are allowed)
    image: typeof image === "string" && image.startsWith("https://images.openfoodfacts.org/") ? image : null,
    // Generic food name used for recipe matching ("Kirkland 2% Milk" -> "Milk")
    kind: String(kind || est.kind || "").slice(0, 40) || null,
    section: est.section,
    life: {
      fridge: Math.max(0.05, Number(full.fridge) || 5),
      freezer: Math.max(0.05, Number(full.freezer) || 60),
      pantry: Math.max(0.05, Number(full.pantry) || 1),
    },
    estimated: !life && !(Number(days) > 0),
    used: Math.min(0.99, Math.max(0, used)),
    addedAt: Date.now(),
    lastAged: Date.now(),
    status: "active",
    alerted: false,
  };
  items[item.id] = item;
  await store.set(`items/${item.id}`, item);
  return item;
}

export async function setStatus(id, status) {
  const item = items[id];
  if (!item) throw new Error("Unknown item");
  item.status = status; // "eaten" | "tossed" | "removed" (added by mistake)
  item.closedAt = Date.now();
  await store.set(`items/${id}`, item);
}

// Undo: put an eaten/tossed/removed item back in the fridge.
// lastAged is untouched, so it catches up on the time it was "gone" (it was in the fridge all along).
export async function restore(id) {
  const item = items[id];
  if (!item) throw new Error("Unknown item");
  item.status = "active";
  delete item.closedAt;
  await store.set(`items/${id}`, item);
}

// Fix an item's estimate ("I opened it", "it's going off early", "the date says 10 days").
// Sets remaining life in the current environment; other environments scale with it.
export async function setDaysLeft(id, days) {
  const item = items[id];
  if (!item) throw new Error("Unknown item");
  days = Number(days);
  if (!(days >= 0) || days > 3650) throw Object.assign(new Error("Days must be between 0 and 3650"), { status: 400 });
  const c = conditions();
  const env = c.lifeEnv;
  // The user means "days left as things are now", so account for today's spoilage speed
  const normalDays = days * speedOf(item, c).factor;
  if (normalDays > item.life[env]) {
    // Longer than its normal life: stretch the base life, start fresh
    const scale = normalDays / item.life[env];
    for (const k of Object.keys(item.life)) item.life[k] *= scale;
    item.used = 0;
  } else {
    item.used = 1 - normalDays / item.life[env];
  }
  item.lastAged = Date.now();
  item.alerted = days < CFG.expiryAlertDays ? item.alerted : false; // can alert again later
  await store.set(`items/${id}`, item);
}

// ---------- Shopping list ----------
export async function addToShopping(names, recipe = null) {
  const have = new Set(Object.values(shopping).filter((s) => !s.done).map((s) => s.name.toLowerCase()));
  const added = [];
  for (const raw of names) {
    const name = String(raw).trim().slice(0, 60);
    if (!name || have.has(name.toLowerCase())) continue;
    have.add(name.toLowerCase());
    const entry = { id: crypto.randomUUID().slice(0, 8), name, done: false, recipe, addedAt: Date.now() };
    shopping[entry.id] = entry;
    added.push(entry);
  }
  await store.set("shopping", shopping);
  return added;
}

export async function toggleShopping(id) {
  if (!shopping[id]) throw new Error("Unknown list item");
  shopping[id].done = !shopping[id].done;
  await store.set("shopping", shopping);
}

export async function removeShopping(ids) {
  for (const id of ids) delete shopping[id];
  await store.set("shopping", shopping);
}

// ---------- Weekly waste summary ----------
const ITEM_VALUE = 2.5; // rough average $ per grocery item, for the "money saved" line

function weekly() {
  const since = Date.now() - 7 * DAY;
  const week = Object.values(items).filter((i) => i.closedAt >= since);
  const eaten = week.filter((i) => i.status === "eaten");
  const tossed = week.filter((i) => i.status === "tossed");
  const counts = {};
  for (const i of tossed) counts[i.name] = (counts[i.name] || 0) + 1;
  const mostTossed = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const total = eaten.length + tossed.length;
  return {
    eaten: eaten.length,
    tossed: tossed.length,
    saveRate: total ? Math.round((eaten.length / total) * 100) : null,
    moneySaved: Math.round(eaten.length * ITEM_VALUE),
    moneyWasted: Math.round(tossed.length * ITEM_VALUE),
    mostTossed: mostTossed ? { name: mostTossed[0], count: mostTossed[1] } : null,
  };
}

// ---------- Where the food is ----------
export function realPodConnected() { return Date.now() - realPodSeenAt < 60_000; }

// The user's setting wins; otherwise what the pod detects from temperature
export const demoOn = () => settings.demo;

// Is a pod (real or demo) sending readings right now?
const sensing = () => pod.lastSeen != null && Date.now() - pod.lastSeen < 2 * MIN;

// "pod" = real hardware, "demo" = simulated, "manual" = no readings, use the user's settings
function mode() {
  if (realPodConnected()) return "pod";
  return sensing() ? "demo" : "manual";
}

// Temperature we go by: the pod's 15-min average, else what the user told us (may be null)
function currentTemp() {
  return sensing() ? pod.avgTempC : settings.tempC;
}

// The user's setting wins; otherwise detected from the pod's (or the user's) temperature
export function currentEnv() {
  if (settings.location !== "auto") return settings.location;
  if (sensing()) return pod.env || "fridge";
  return classify(settings.tempC, null) || "fridge";
}

export async function updateSettings({ location, tempC, demo }) {
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
  if (location !== undefined) {
    if (!["auto", "fridge", "freezer", "pantry"].includes(location)) throw bad("Location must be auto, fridge, freezer or pantry");
    settings.location = location;
  }
  if (tempC !== undefined) {
    if (tempC === null || tempC === "") settings.tempC = null;
    else if (Number(tempC) >= -30 && Number(tempC) <= 40) settings.tempC = Math.round(Number(tempC) * 10) / 10;
    else throw bad("Temperature must be between -30 and 40 °C");
  }
  if (demo !== undefined) {
    settings.demo = Boolean(demo);
    if (!settings.demo) forgetDemoReadings();
  }
  await store.set("settings", settings);
  await store.set("podState", pod);
}

// Turning the demo off: drop simulated readings so they don't count as real conditions
function forgetDemoReadings() {
  history = history.filter((r) => r.source !== "simulator");
  if (!history.length) {
    Object.assign(pod, { env: null, avgTempC: null, lastSeen: null, gasBaseline: null, warmSince: null, warmAlerted: false });
  }
}

// ---------- Spoilage model ----------
// Every item has a normal shelf life per place (foods.js). Right now it ages faster or slower than
// normal depending on conditions the pod measures:
//   * Temperature (Q10 rule): food spoils ~3x faster for every 10°C above the place's typical
//     temperature (fridge 4°C, pantry 21°C), and slower when colder. A thawing freezer counts as a fridge.
//   * Gas: the MQ-3 picks up ripening/fermenting gases. When it's above its normal baseline,
//     fruit and veg age faster (up to 3x). Other food isn't affected by ripening gas.
const TYPICAL_C = { fridge: 4, pantry: 21 };
const Q10 = 3;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function recentGas() {
  const g = history.filter((r) => r.gas != null).slice(-6).map((r) => r.gas);
  return g.length ? avg(g) : null;
}

function conditions() {
  const env = currentEnv();
  const t = currentTemp();
  // Which shelf life applies: a freezer warmer than -5°C is thawing, so treat its food as fridge food
  const lifeEnv = env === "freezer" && t != null && t > -5 ? "fridge" : env;
  const temp = lifeEnv === "freezer" || t == null ? 1 : clamp(Q10 ** ((t - TYPICAL_C[lifeEnv]) / 10), 0.5, 6);
  const g = sensing() ? recentGas() : null;   // no pod, no gas reading
  const ratio = pod.gasBaseline && g != null ? g / pod.gasBaseline : 1;
  const gas = clamp(1 + Math.max(0, ratio - 1.1) * 2.5, 1, 3);
  return { env, lifeEnv, temp, gas, gasAbovePct: Math.round((ratio - 1) * 100) };
}

function sectionOf(item) {
  return item.section || findFood(item.kind || item.name)?.section || null;
}

// How fast this item is aging right now (1 = normal) and why
function speedOf(item, c = conditions()) {
  const gas = sectionOf(item) === "Produce" ? c.gas : 1;
  // Short labels for the item list; the pod card explains the details
  const reasons = [];
  if (c.env === "freezer" && c.lifeEnv === "fridge") reasons.push("thawing");
  else if (c.temp >= 1.15) reasons.push("warm");
  if (gas >= 1.15) reasons.push("ripening gas");
  return { factor: c.temp * gas, reasons };
}

// Age every active item by the time since we last aged it, at today's speed
export async function ageItems() {
  const now = Date.now();
  const c = conditions();
  const expiring = [];
  for (const item of Object.values(items)) {
    if (item.status !== "active") continue;
    const dtDays = ((now - item.lastAged) / DAY) * CFG.demoSpeed;
    item.used = Math.min(1, item.used + (dtDays * speedOf(item, c).factor) / item.life[c.lifeEnv]);
    item.lastAged = now;
    if (!item.alerted && forecast(item, c).remainingDays < CFG.expiryAlertDays) {
      item.alerted = true;
      expiring.push(item);
    }
  }
  await store.set("items", items);
  if (expiring.length) {
    const list = expiring.map((i) => `${i.name} (${fmtDays(forecast(i, c).remainingDays)})`).join(", ");
    let ideas = "";
    try { ideas = onExpiring ? await onExpiring(expiring.map(({ id, name, kind }) => ({ id, name, kind }))) : ""; } catch (e) { console.warn("Recipe idea failed:", e.message); }
    await raise("expiry", "Eat me first!",
      `Use soon: ${list}.` + (ideas ? `\nIdeas: ${ideas}` : ""),
      { priority: 4, tags: "hourglass,fork_and_knife" });
  }
}

// Prediction: days left if today's conditions continue, vs. days left under normal conditions
function forecast(item, c = conditions()) {
  const left = Math.max(0, 1 - item.used);
  const normalDays = left * item.life[c.lifeEnv];
  const { factor, reasons } = speedOf(item, c);
  return { remainingDays: normalDays / factor, normalDays, speed: factor, reasons };
}

export function activeItems() {
  const c = conditions();
  return Object.values(items)
    .filter((i) => i.status === "active")
    .map((i) => {
      const f = forecast(i, c);
      return { ...i, remainingDays: f.remainingDays, forecast: f };
    })
    .sort((a, b) => a.remainingDays - b.remainingDays);
}

export function fmtDays(d) {
  if (d <= 0) return "expired";
  if (d < 1) return `${Math.max(1, Math.round(d * 24))}h left`;
  return `${d.toFixed(d < 3 ? 1 : 0)} days left`;
}

// ---------- Alerts ----------
async function raise(type, title, message, opts) {
  const alert = { id: crypto.randomUUID().slice(0, 8), t: Date.now(), type, title, message };
  alerts.unshift(alert);
  alerts = alerts.slice(0, 50);
  await store.set(`alerts/${alert.id}`, alert);
  console.log(`[alert:${type}] ${title} - ${message}`);
  await notify(title, message, opts);
}

export async function testAlert() {
  await raise("test", "Eat Me First test", "Phone alerts are working.", { priority: 3, tags: "white_check_mark" });
}

// ---------- What the pod's 16x2 LCD shows ----------
// Plain ASCII only (LCDs can't show emoji or °), 16 characters per line, 2 lines per screen.
const lcdText = (s) => String(s).normalize("NFKD").replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim().slice(0, 16);
// Final pass on a finished line: keep its spacing (alignment), just make it LCD-safe
const lcdLine = (s) => String(s).normalize("NFKD").replace(/[^\x20-\x7E]/g, "").slice(0, 16);

function lcdDays(d) {
  if (d <= 0) return "EXPIRED";
  if (d < 1) return `${Math.max(1, Math.round(d * 24))}h`;
  return d < 10 ? `${d.toFixed(1)}d` : `${Math.round(d)}d`;
}

// "Milk" + "1.2d" -> "Milk        1.2d" (name cut to fit, days right-aligned)
function lcdRow(left, right) {
  left = lcdText(left);
  right = lcdText(right);
  const room = 16 - right.length - 1;
  return (left.length > room ? left.slice(0, room) : left).padEnd(room) + " " + right;
}

export function podScreens() {
  // The LCD only answers "what should I eat?": the 3 most urgent foods, one per screen.
  // Everything else (temperature, alerts, weekly score) lives in the app; the LED shows urgency.
  const c = conditions();
  const list = activeItems();
  const screens = list.length
    ? list.slice(0, 3).map((item, n) => [n === 0 ? "EAT FIRST:" : "NEXT:", lcdRow(item.name, lcdDays(item.remainingDays))])
    : [["Nothing to eat", "Add food in app"]];
  const recent = alerts.find((a) => a.type !== "test" && Date.now() - a.t < 60 * MIN);
  return { screens: screens.map((sc) => sc.map(lcdLine)), alert: Boolean(recent), level: urgencyLevel(c, list) };
}

// Colour for the pod's RGB LED:
//   red    = act now: food due today or expired, fridge too warm (alerted), freezer thawing
//   yellow = soon: food due within 3 days, or conditions a bit off (warm, ripening gas)
//   green  = all good
function urgencyLevel(c, list) {
  const soonest = list[0]?.remainingDays ?? Infinity;
  const thawing = c.env === "freezer" && c.lifeEnv === "fridge";
  if (soonest < 1 || pod.warmAlerted || thawing) return "red";
  if (soonest < 3 || c.temp >= 1.15 || c.gas >= 1.15) return "yellow";
  return "green";
}

// ---------- Snapshot for the web app ----------
export function snapshot() {
  const all = Object.values(items);
  return {
    pod: {
      ...pod,
      location: settings.location,          // user setting ("auto" = detected)
      tempSetting: settings.tempC,          // user's own temperature (used with no pod)
      demo: settings.demo,
      mode: mode(),                         // "pod" | "demo" | "manual"
      tempC: currentTemp(),                 // temperature the forecasts use
      env: currentEnv(),                    // where we treat the food as being
      detectedEnv: sensing() ? pod.env : null, // what the pod's temperature says
      // Manual setting that disagrees with a clear temperature reading
      mismatch: sensing() && settings.location !== "auto" && detectNow(pod.avgTempC) && detectNow(pod.avgTempC) !== settings.location
        ? detectNow(pod.avgTempC) : null,

      conditions: (({ temp, gas, gasAbovePct }) => ({ temp, gas, gasAbovePct }))(conditions()),
      lcd: podScreens(),                    // what the pod's screen shows
      // Pod is online but its temperature sensor returns nothing (wiring problem)
      sensorProblem: realPodConnected() && history.filter((r) => r.source !== "simulator").slice(-3).every((r) => r.tempC == null),
      latest: history.at(-1) || null,
      warmMinutes: pod.warmSince ? Math.round((Date.now() - pod.warmSince) / MIN) : 0,
      history: history.slice(-90),
    },
    items: activeItems(),
    recentlyRemoved: all
      .filter((i) => i.status !== "active")
      .sort((a, b) => b.closedAt - a.closedAt)
      .slice(0, 10)
      .map(({ id, name, emoji, image, status, closedAt }) => ({ id, name, emoji, image, status, closedAt })),
    stats: {
      eaten: all.filter((i) => i.status === "eaten").length,
      tossed: all.filter((i) => i.status === "tossed").length,
    },
    weekly: weekly(),
    shopping: Object.values(shopping).sort((a, b) => a.done - b.done || b.addedAt - a.addedAt),
    alerts: alerts.slice(0, 20),
    quickAdd: QUICK_ADD,
    config: { ...CFG, ntfyTopic: process.env.NTFY_TOPIC || null, firebase: store.usingFirebase },
  };
}
