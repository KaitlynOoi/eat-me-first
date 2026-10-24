// Core logic: environment detection, shelf-life aging, and alert rules.
import crypto from "node:crypto";
import * as store from "./store.js";
import { CATALOG, SEED } from "./catalog.js";
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
let pod = {
  env: null,               // "freezer" | "fridge" | "pantry" | null
  avgTempC: null,
  warmSince: null,         // ms timestamp when fridge went > 7°C
  warmAlerted: false,
  gasBaseline: null,
  lastGasAlert: 0,
  lastSeen: null,
};
let lastSeq = null;
let onExpiring = null;     // hook for recipe suggestions, set by index.js

export function setExpiringHook(fn) { onExpiring = fn; }

export async function load() {
  items = (await store.get("items")) || {};
  const savedPod = await store.get("podState");
  if (savedPod) pod = { ...pod, ...savedPod, warmSince: null, warmAlerted: false };
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
  await evaluate();
}

function num0(v) { return v == null || Number.isNaN(Number(v)) ? null : Number(v); }

function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }

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
  pod.env = classify(pod.avgTempC, pod.env);

  await checkWarmFridge(now);
  await checkGas(now);
  await store.set("podState", pod);
}

// Fridge sustained above 7°C (15-min average) for WARM_ALERT_MIN -> food safety alert
async function checkWarmFridge(now) {
  const warm = pod.avgTempC != null && pod.avgTempC > CFG.warmThresholdC;
  if (!warm) { pod.warmSince = null; pod.warmAlerted = false; return; }
  if (pod.warmSince == null) {
    if (pod.env !== "fridge") return;        // only a fridge can be "too warm"
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
    const soon = activeItems().slice(0, 3).map((i) => `${i.name} (${fmtDays(i.remainingDays)})`);
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
function catalogFor(name) {
  return CATALOG.find((c) => c.name.toLowerCase() === String(name).toLowerCase());
}

export async function addItem({ name, emoji, life, used = 0 }) {
  const known = catalogFor(name);
  const fullLife = life || known?.life;
  if (!fullLife) throw new Error(`No shelf life known for "${name}"`);
  const item = {
    id: crypto.randomUUID().slice(0, 8),
    name: String(name).slice(0, 60),
    emoji: emoji || known?.emoji || "🍽️",
    life: {
      fridge: Math.max(0.05, Number(fullLife.fridge) || 3),
      freezer: Math.max(0.05, Number(fullLife.freezer) || 90),
      pantry: Math.max(0.05, Number(fullLife.pantry) || 1),
    },
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
  item.status = status; // "eaten" | "tossed"
  item.closedAt = Date.now();
  await store.set(`items/${id}`, item);
}

// Which base life applies right now. Warm fridge time ages food at pantry speed.
function rateEnv() {
  if (pod.env === "fridge" && pod.avgTempC != null && pod.avgTempC > CFG.warmThresholdC) return "pantry";
  return pod.env || "fridge";
}

// Age every active item by the time since we last aged it, at the current environment's rate
export async function ageItems() {
  const now = Date.now();
  const env = rateEnv();
  const expiring = [];
  for (const item of Object.values(items)) {
    if (item.status !== "active") continue;
    const dtDays = ((now - item.lastAged) / DAY) * CFG.demoSpeed;
    item.used = Math.min(1, item.used + dtDays / item.life[env]);
    item.lastAged = now;
    if (!item.alerted && remaining(item) < CFG.expiryAlertDays) {
      item.alerted = true;
      expiring.push(item);
    }
  }
  await store.set("items", items);
  if (expiring.length) {
    const list = expiring.map((i) => `${i.name} (${fmtDays(remaining(i))})`).join(", ");
    let ideas = "";
    try { ideas = onExpiring ? await onExpiring(expiring.map((i) => i.name)) : ""; } catch (e) { console.warn("Recipe idea failed:", e.message); }
    await raise("expiry", "Eat me first!",
      `Use soon: ${list}.` + (ideas ? `\nIdeas: ${ideas}` : ""),
      { priority: 4, tags: "hourglass,fork_and_knife" });
  }
}

function remaining(item) {
  const env = pod.env || "fridge";
  return Math.max(0, (1 - item.used) * item.life[env]);
}

export function activeItems() {
  return Object.values(items)
    .filter((i) => i.status === "active")
    .map((i) => ({ ...i, remainingDays: remaining(i) }))
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

// ---------- Snapshot for the web app ----------
export function snapshot() {
  const all = Object.values(items);
  return {
    pod: {
      ...pod,
      latest: history.at(-1) || null,
      warmMinutes: pod.warmSince ? Math.round((Date.now() - pod.warmSince) / MIN) : 0,
      history: history.slice(-90),
    },
    items: activeItems(),
    stats: {
      eaten: all.filter((i) => i.status === "eaten").length,
      tossed: all.filter((i) => i.status === "tossed").length,
    },
    alerts: alerts.slice(0, 20),
    catalog: CATALOG,
    config: { ...CFG, ntfyTopic: process.env.NTFY_TOPIC || null, firebase: store.usingFirebase },
  };
}
