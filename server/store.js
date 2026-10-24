// Tiny path-based key/value store.
// Uses Firebase Realtime Database (REST API) when FIREBASE_DB_URL is set,
// otherwise a local data.json file so the app runs with zero setup.
import fs from "node:fs";
import path from "node:path";

const DB_URL = (process.env.FIREBASE_DB_URL || "").replace(/\/$/, "");
const DB_SECRET = process.env.FIREBASE_DB_SECRET || "";
const LOCAL_FILE = path.resolve("data.json");

export const usingFirebase = Boolean(DB_URL);

// ---------- Firebase REST ----------
async function fb(method, p, body) {
  const auth = DB_SECRET ? `?auth=${encodeURIComponent(DB_SECRET)}` : "";
  const res = await fetch(`${DB_URL}/${p}.json${auth}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Firebase ${method} ${p} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ---------- Local JSON ----------
let local = {};
if (!usingFirebase && fs.existsSync(LOCAL_FILE)) {
  try { local = JSON.parse(fs.readFileSync(LOCAL_FILE, "utf8")); } catch { local = {}; }
}
let saveTimer = null;
function saveLocal() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFileSync(LOCAL_FILE, JSON.stringify(local, null, 2)), 200);
}
function walk(p, create) {
  const parts = p.split("/").filter(Boolean);
  const last = parts.pop();
  let node = local;
  for (const part of parts) {
    if (node[part] == null || typeof node[part] !== "object") {
      if (!create) return [null, last];
      node[part] = {};
    }
    node = node[part];
  }
  return [node, last];
}

export async function get(p) {
  if (usingFirebase) return fb("GET", p);
  const [node, key] = walk(p, false);
  return node ? structuredClone(node[key] ?? null) : null;
}

export async function set(p, value) {
  if (usingFirebase) return fb("PUT", p, value);
  const [node, key] = walk(p, true);
  if (value === null) delete node[key]; else node[key] = structuredClone(value);
  saveLocal();
}

export async function update(p, fields) {
  if (usingFirebase) return fb("PATCH", p, fields);
  const [node, key] = walk(p, true);
  node[key] = { ...(node[key] || {}), ...structuredClone(fields) };
  saveLocal();
}

export async function remove(p) {
  if (usingFirebase) return fb("DELETE", p);
  return set(p, null);
}
