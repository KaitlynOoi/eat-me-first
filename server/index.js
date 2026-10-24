import "dotenv/config";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import * as store from "./store.js";
import * as engine from "./engine.js";
import * as sim from "./simulator.js";
import { scanGroceries, claudeEnabled } from "./claude.js";
import { suggestRecipes, searchRecipes, quickIdea } from "./recipes.js";
import { estimate } from "./foods.js";
import { lookupBarcode, classify } from "./barcode.js";

const PORT = Number(process.env.PORT || 3000);
const app = express();
app.use(express.json({ limit: "12mb" })); // photos arrive as base64
// Serve the page with ?v=<this deploy> on its scripts and styles, so phones (and home-screen apps)
// always load the newest version instead of a cached old one
const BUILD = Date.now().toString(36);
const indexHtml = fs.readFileSync(path.resolve("public/index.html"), "utf8")
  .replace(/(src|href)="((?:vendor\/)?[\w./-]+\.(?:js|css))"/g, `$1="$2?v=${BUILD}"`);
app.get(["/", "/index.html"], (req, res) => {
  res.set("Cache-Control", "no-cache");
  res.type("html").send(indexHtml);
});
app.use(express.static("public"));

// Wrap async handlers so errors become JSON instead of crashing
const route = (fn) => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) {
    console.error(e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
};

app.get("/api/state", route(() => ({ ...engine.snapshot(), sim: { scenario: sim.getScenario(), scenarios: sim.SCENARIOS }, photoScan: claudeEnabled() })));


// What the pod's LCD and LED should show, as plain text so the ESP32 needs no JSON library:
// first line "<LED colour> <ALERT|OK>" (e.g. "RED ALERT", "GREEN OK"), then 2 lines per screen.
// The pod gets this as the reply to its reading (POST /api/pod/reading?lcd=1); GET works too for testing.
function lcdReply(res) {
  const { screens, alert, level } = engine.podScreens();
  res.type("text/plain").send([`${level.toUpperCase()} ${alert ? "ALERT" : "OK"}`, ...screens.flat()].join("\n"));
}
app.get("/api/pod/screen.txt", (req, res) => lcdReply(res));
app.use("/api/pod/reading", (req, res, next) => {
  if (req.method !== "POST" || req.query.lcd !== "1") return next();
  const json = res.json.bind(res);
  // Swap the JSON reply for the LCD text, but keep errors (401/400) as they are
  res.json = (body) => (res.statusCode === 200 ? lcdReply(res) : json(body));
  next();
});

// The ESP32 can POST here directly instead of (or as well as) writing to Firebase
let directSeq = 0;
app.post("/api/pod/reading", route(async (req) => {
  // Optional shared secret so strangers can't post fake readings to a public server
  if (process.env.POD_KEY && req.get("X-Pod-Key") !== process.env.POD_KEY) {
    throw Object.assign(new Error("Wrong or missing pod key"), { status: 401 });
  }
  const val = (v, lo, hi) => (v === null || v === undefined || v === "" || !(Number(v) >= lo && Number(v) <= hi) ? null : Number(v));
  const tempC = val(req.body.tempC, -50, 80);
  const humidity = val(req.body.humidity, 0, 100);
  const gas = val(req.body.gas, 0, 4095);
  if (tempC === null && gas === null) throw Object.assign(new Error("Send at least tempC or gas"), { status: 400 });
  const reading = { tempC, humidity, gas, seq: req.body.seq != null ? `p${req.body.seq}` : `d${++directSeq}`, source: "pod" };
  await store.set("pod/latest", reading);
  await engine.ingest(reading);
  return { ok: true, ...engine.podScreens() };
}));


app.post("/api/settings", route(async (req) => {
  const { location, tempC, demo } = req.body;
  await engine.updateSettings({ location, tempC, demo });
  if (demo) sim.setScenario("fridge");
  return { ok: true };
}));
app.post("/api/sim", route(async (req) => { sim.setScenario(req.body.scenario); return { scenario: sim.getScenario() }; }));
app.post("/api/calibrate", route(async () => ({ gasBaseline: await engine.calibrateGas() })));
app.post("/api/test-alert", route(async () => { await engine.testAlert(); return { ok: true }; }));

app.post("/api/items", route(async (req) => {
  const list = Array.isArray(req.body.items) ? req.body.items : [req.body];
  const added = [];
  for (const i of list) added.push(await engine.addItem(i));
  return { added };
}));
app.post("/api/items/:id/status", route(async (req) => {
  if (!["eaten", "tossed", "removed"].includes(req.body.status)) throw Object.assign(new Error("status must be eaten, tossed or removed"), { status: 400 });
  await engine.setStatus(req.params.id, req.body.status);
  return { ok: true };
}));

app.post("/api/items/:id/restore", route(async (req) => { await engine.restore(req.params.id); return { ok: true }; }));

app.post("/api/items/:id/days", route(async (req) => { await engine.setDaysLeft(req.params.id, req.body.days); return { ok: true }; }));

app.post("/api/shopping", route(async (req) => ({ added: await engine.addToShopping(req.body.names || [], req.body.recipe || null) })));
app.post("/api/shopping/:id/toggle", route(async (req) => { await engine.toggleShopping(req.params.id); return { ok: true }; }));
app.post("/api/shopping/remove", route(async (req) => { await engine.removeShopping(req.body.ids || []); return { ok: true }; }));

app.get("/api/recipes/search", route((req) => searchRecipes(req.query.q, engine.activeItems())));
// "How long does X last?" - shown while typing in Add anything
app.get("/api/estimate", route((req) => estimate(String(req.query.name || "").slice(0, 60))));

app.get("/api/barcode/:code", route((req) => lookupBarcode(req.params.code)));
// Backup path: the phone fetched Open Food Facts itself, the server just applies the shelf-life rules
app.post("/api/barcode/classify", route(async (req) => classify(req.body.code, req.body.data)));

app.post("/api/scan", route(async (req) => ({ items: await scanGroceries(req.body.image) })));
app.post("/api/recipes", route(async () => {
  return suggestRecipes(engine.activeItems());
}));

// ---------- Background loops ----------
engine.setExpiringHook(quickIdea);

async function readingLoop() {
  try {
    // Demo pod only when switched on, and never while a real pod is sending data
    if (engine.demoOn() && !engine.realPodConnected()) await sim.tick();
    const latest = await store.get("pod/latest");
    if (latest) await engine.ingest(latest);
  } catch (e) { console.warn("reading loop:", e.message); }
  setTimeout(readingLoop, 3000);
}

async function agingLoop() {
  try { await engine.ageItems(); } catch (e) { console.warn("aging loop:", e.message); }
  setTimeout(agingLoop, 10_000);
}

await engine.load();
app.listen(PORT, "0.0.0.0", () => {
  const lan = Object.values(os.networkInterfaces()).flat().find((n) => n?.family === "IPv4" && !n.internal)?.address;
  console.log(`Eat Me First running:`);
  console.log(`  this computer: http://localhost:${PORT}`);
  if (lan) console.log(`  your phone (same WiFi): http://${lan}:${PORT}`);
  console.log(`  storage: ${store.usingFirebase ? "Firebase " + process.env.FIREBASE_DB_URL : "local data.json"}`);
  console.log(`  photo scan: ${claudeEnabled() ? "on (Claude Haiku)" : "off - no ANTHROPIC_API_KEY, quick-add still works"}`);
  console.log(`  ntfy: ${process.env.NTFY_TOPIC ? "https://ntfy.sh/" + process.env.NTFY_TOPIC : "no topic - phone alerts disabled"}`);
  readingLoop();
  agingLoop();
});
