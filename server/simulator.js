// Fake pod so the software can be built and demoed before the hardware exists.
// It writes readings to the same place the real ESP32 will (pod/latest).
import * as store from "./store.js";

export const SCENARIOS = {
  off:        { label: "Off (use real pod)" },
  fridge:     { label: "Fridge (3.5°C)",       temp: 3.5 },
  freezer:    { label: "Freezer (-18°C)",      temp: -18 },
  pantry:     { label: "Pantry (21°C)",        temp: 21 },
  doorOpen:   { label: "Fridge door opened 30s", temp: 3.5, spike: 14, spikeSecs: 30 },
  warmFridge: { label: "Fridge failing (9°C)", temp: 9 },
  ripening:   { label: "Banana ripening (gas rising)", temp: 3.5, ripen: true },
};

let scenario = "fridge";
let temp = 3.5;
let gasExtra = 0;
let seq = 0;
let spikeUntil = 0;

export function getScenario() { return scenario; }

export function setScenario(name) {
  if (!SCENARIOS[name]) throw new Error("Unknown scenario");
  scenario = name;
  const s = SCENARIOS[name];
  if (s.spike) spikeUntil = Date.now() + s.spikeSecs * 1000;
  if (!s.ripen) gasExtra = 0;
  if (name === "freezer" || name === "pantry") temp = s.temp; // "moved" the pod: jump there
}

const jitter = (n) => (Math.random() - 0.5) * n;

export async function tick() {
  if (scenario === "off") return null;
  const s = SCENARIOS[scenario];
  const target = Date.now() < spikeUntil ? s.spike : s.temp;
  temp += (target - temp) * 0.35;            // drift toward target like real air would
  if (s.ripen) gasExtra += 25 + Math.random() * 15;
  const reading = {
    seq: ++seq,
    tempC: +(temp + jitter(0.3)).toFixed(2),
    humidity: +(scenario === "pantry" ? 45 + jitter(4) : 70 + jitter(4)).toFixed(1),
    gas: Math.round(600 + gasExtra + jitter(20)),
    source: "simulator",
  };
  await store.set("pod/latest", reading);
  return reading;
}
