// Free fresh-food recognition that runs entirely on the phone (no API key, no server).
// TensorFlow.js + MobileNet v2 (an image classifier trained on ImageNet's 1,000 categories),
// self-hosted under /vendor/tf and /models. About 35 of those categories are foods we care about.
// The model only guesses: the user always confirms (or corrects) before anything is added.
//
// Uses helpers from app.js: $, esc, api, toast, addItems, state.

// ImageNet label (first name before the comma) -> what we add to the fridge.
// The name goes through the same shelf-life estimate as typed food (server/foods.js).
const PRODUCE_LABELS = {
  "banana": "Bananas",
  "Granny Smith": "Apples",
  "strawberry": "Strawberries",
  "orange": "Oranges",
  "lemon": "Lemons & limes",
  "pineapple": "Pineapple",
  "fig": "Figs",
  "pomegranate": "Pomegranate",
  "jackfruit": "Jackfruit",
  "custard apple": "Custard apple",
  "broccoli": "Broccoli",
  "cauliflower": "Cauliflower",
  "head cabbage": "Cabbage",
  "zucchini": "Zucchini",
  "cucumber": "Cucumbers",
  "spaghetti squash": "Squash",
  "acorn squash": "Squash",
  "butternut squash": "Squash",
  "bell pepper": "Bell peppers",
  "mushroom": "Mushrooms",
  "artichoke": "Artichokes",
  "cardoon": "Celery",
  "corn": "Corn",
  "ear": "Corn",
  "guacamole": "Guacamole",
  "French loaf": "Bread",
  "bagel": "Bagels & muffins",
  "pretzel": "Pretzels",
  "pizza": "Pizza",
  "burrito": "Burrito",
  "cheeseburger": "Burger (leftover)",
  "hotdog": "Hot dogs",
  "meat loaf": "Meatloaf",
  "potpie": "Pot pie (leftover)",
  "carbonara": "Pasta (leftover)",
  "mashed potato": "Mashed potatoes (leftover)",
  "consomme": "Soup",
  "hot pot": "Leftovers",
  "ice cream": "Ice cream",
  "trifle": "Dessert (leftover)",
  "American lobster": "Lobster",
  "spiny lobster": "Lobster",
  "Dungeness crab": "Crab",
  "rock crab": "Crab",
  "king crab": "Crab",
};

let classifier = null;   // loaded MobileNet
let loading = null;      // in-flight load promise
let pickedName = null;   // what the user confirmed

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some((s) => s.src.endsWith(src))) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Couldn't load ${src}`));
    document.head.append(s);
  });
}

// Load TF.js + the model once, the first time someone uses the feature (it's ~15 MB)
function loadClassifier() {
  loading ??= (async () => {
    await loadScript("vendor/tf/tf.min.js");
    await loadScript("vendor/tf/mobilenet.min.js");
    // inputRange must match the TF Hub model ([0,1]); with a custom modelUrl the wrapper would assume [-1,1]
    classifier = await mobilenet.load({ version: 2, alpha: 1.0, modelUrl: "models/mobilenet_v2/model.json", inputRange: [0, 1] });
    return classifier;
  })().catch((err) => { loading = null; throw err; });
  return loading;
}

const produceStatus = (msg) => { $("produceStatus").textContent = msg; };

// Square crops of the photo (whole + zoomed centre): the model expects a square image,
// and food is usually in the middle of the shot
function crops(img) {
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const side = Math.min(w, h);
  return [1, 0.65].map((zoom) => {
    const s = side * zoom;
    const c = document.createElement("canvas");
    c.width = c.height = 224;
    c.getContext("2d").drawImage(img, (w - s) / 2, (h - s) / 2, s, s, 0, 0, 224, 224);
    return c;
  });
}

// Top food guesses (best probability per food across both crops)
async function recognize(img) {
  const model = await loadClassifier();
  const best = new Map();
  for (const canvas of crops(img)) {
    for (const p of await model.classify(canvas, 15)) {
      const name = PRODUCE_LABELS[p.className.split(",")[0].trim()];
      if (name && p.probability > (best.get(name) || 0)) best.set(name, p.probability);
    }
  }
  return [...best.entries()].map(([name, probability]) => ({ name, probability }))
    .sort((a, b) => b.probability - a.probability).slice(0, 3);
}

function renderGuesses(guesses) {
  const sure = guesses[0]?.probability >= 0.3;
  produceStatus(guesses.length
    ? (sure ? "Is this right? Tap to choose." : "Not sure about this one. Is it any of these?")
    : "Couldn't recognize this. Pick what it is below, or type it.");
  // Fallback choices: everyday produce, incl. things the model can't recognize (tomatoes, carrots…)
  const produce = state.quickAdd.find((s) => s.section === "Produce")?.foods || [];
  $("produceResult").innerHTML = `
    ${guesses.length ? `<div class="guesses">${guesses.map((g) =>
      `<button data-pick="${esc(g.name)}">${esc(g.name)} <span class="muted small">${Math.round(g.probability * 100)}%</span></button>`).join("")}</div>` : ""}
    <div id="produceConfirm" class="estimate confirm-box hidden"></div>
    <p class="muted small">Not right? Pick it:</p>
    <div class="picks">${produce.map((f) => `<button data-pick="${esc(f.name)}">${f.emoji} ${esc(f.name)}</button>`).join("")}</div>
    <input id="produceName" type="text" placeholder="…or type it, e.g. kiwi" maxlength="60">`;
}

// Confirm step: show the choice + estimated days; nothing is added until "Add to fridge"
async function choose(name) {
  pickedName = name;
  document.querySelectorAll("#produceResult [data-pick]").forEach((b) => b.classList.toggle("on", b.dataset.pick === name));
  const est = await api(`/api/estimate?name=${encodeURIComponent(name)}`).catch(() => null);
  if (pickedName !== name) return;
  $("produceConfirm").innerHTML = `
    <div class="days-row"><span class="est-emoji">${est?.emoji || "🍽️"}</span><b>${esc(name)}</b> · lasts about
      <input id="produceDays" type="number" min="0.5" step="0.5" value="${est ? Math.round(est.life.fridge * 2) / 2 : 5}"> days</div>
    <div class="row"><button data-produce="add">Add to fridge</button><button class="secondary" data-produce="again">Snap another</button></div>`;
  $("produceConfirm").classList.remove("hidden");
  $("produceConfirm").scrollIntoView({ behavior: "smooth", block: "center" });
}

async function handlePhoto(file) {
  $("produceSheet").showModal();
  $("produceResult").innerHTML = "";
  pickedName = null;
  const url = URL.createObjectURL(file);
  $("producePreview").src = url;
  $("producePreview").classList.remove("hidden");
  produceStatus(classifier ? "Looking…" : "Loading the food recognizer (first time only, ~15 MB)…");
  try {
    // Plain onload (img.decode() can stall while the page is in the background)
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Couldn't read that photo"));
      i.src = url;
    });
    renderGuesses(await recognize(img));
  } catch (err) {
    console.warn(err);
    produceStatus("The recognizer didn't load. Pick what it is below instead.");
    renderGuesses([]);
  }
}

$("produceBtn").addEventListener("click", () => {
  loadClassifier().catch(() => {}); // start downloading while the camera is open
  $("produceInput").click();
});
$("produceInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (file) handlePhoto(file);
});
$("produceResult").addEventListener("click", async (e) => {
  const pick = e.target.closest("[data-pick]");
  if (pick) return choose(pick.dataset.pick);
  const action = e.target.closest("[data-produce]")?.dataset.produce;
  if (action === "again") { $("produceSheet").close(); $("produceInput").click(); }
  if (action === "add") {
    const days = Number($("produceDays").value);
    try {
      await addItems([days > 0 ? { name: pickedName, days } : { name: pickedName }]);
      $("produceSheet").close();
    } catch (err) { toast(err.message); }
  }
});
$("produceResult").addEventListener("change", (e) => {
  if (e.target.id === "produceName" && e.target.value.trim()) choose(e.target.value.trim());
});
$("produceClose").addEventListener("click", () => $("produceSheet").close());
$("produceSheet").addEventListener("close", () => {
  const src = $("producePreview").src;
  if (src.startsWith("blob:")) URL.revokeObjectURL(src);
});
