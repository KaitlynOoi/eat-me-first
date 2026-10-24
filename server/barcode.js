// Free barcode lookup via Open Food Facts (no API key).
// We get the product name + categories, then guess shelf life from the category.
import { estimate } from "./foods.js";

const API = "https://world.openfoodfacts.org/api/v2/product/";
const FIELDS = "product_name,generic_name,brands,categories_tags,image_front_small_url,quantity";
const cache = new Map();

// First matching rule wins. `match` is checked against the product's category tags and name.
// life = days in {fridge, freezer, pantry}. Unopened shelf-stable goods last long everywhere.
const RULES = [
  { match: /ice-cream|frozen/,                          emoji: "🍦", life: { fridge: 2,   freezer: 180, pantry: 0.1 } },
  // Canned goods before meat/fish, so canned tuna isn't treated as fresh fish
  { match: /canned|tinned|conserve/,                    emoji: "🥫", life: { fridge: 365, freezer: 365, pantry: 365 } },
  { match: /milk(?!-chocolate)|lait/,                   emoji: "🥛", life: { fridge: 7,   freezer: 90,  pantry: 0.25 } },
  { match: /yogh?urt/,                                  emoji: "🥣", life: { fridge: 14,  freezer: 60,  pantry: 0.2 } },
  { match: /butter/,                                    emoji: "🧈", life: { fridge: 30,  freezer: 180, pantry: 2 } },
  { match: /cream(?!-cheese)|creme/,                    emoji: "🥛", life: { fridge: 7,   freezer: 60,  pantry: 0.2 } },
  { match: /chees|fromage/,                             emoji: "🧀", life: { fridge: 21,  freezer: 180, pantry: 1 } },
  { match: /\beggs?\b|oeufs/,                           emoji: "🥚", life: { fridge: 28,  freezer: 365, pantry: 7 } },
  { match: /chicken|poultr|turkey|poulet/,              emoji: "🍗", life: { fridge: 2,   freezer: 270, pantry: 0.1 } },
  { match: /ham|sausage|bacon|cold-cuts|salami/,        emoji: "🥓", life: { fridge: 5,   freezer: 60,  pantry: 0.2 } },
  { match: /beef|pork|lamb|meats?\b|minced/,            emoji: "🥩", life: { fridge: 2,   freezer: 120, pantry: 0.1 } },
  { match: /fish|seafood|salmon|tuna(?!-in)|shrimp/,    emoji: "🐟", life: { fridge: 2,   freezer: 180, pantry: 0.1 } },
  { match: /tofu|hummus/,                               emoji: "🫘", life: { fridge: 5,   freezer: 90,  pantry: 0.2 } },
  { match: /bread|bagel|tortilla|pain/,                 emoji: "🍞", life: { fridge: 7,   freezer: 90,  pantry: 5 } },
  { match: /salad|lettuce|spinach|fresh-vegetables/,    emoji: "🥬", life: { fridge: 5,   freezer: 240, pantry: 1 } },
  { match: /fresh-fruits|berr/,                         emoji: "🍓", life: { fridge: 5,   freezer: 240, pantry: 2 } },
  { match: /juice|smoothie/,                            emoji: "🧃", life: { fridge: 7,   freezer: 180, pantry: 1 } },
  { match: /ready-meals|prepared|sandwich|pizza/,       emoji: "🍱", life: { fridge: 3,   freezer: 90,  pantry: 0.2 } },
  // Shelf-stable: lasts long unopened wherever it is
  { match: /sauce|condiment|ketchup|mayonnaise|mustard|spread|jam/, emoji: "🫙", life: { fridge: 90, freezer: 180, pantry: 180 } },
  { match: /cereal|pasta|rice|biscuit|cookie|cracker|snack|chip|crisp|chocolate|candy|confection/,
                                                        emoji: "🍪", life: { fridge: 180, freezer: 365, pantry: 180 } },
  { match: /\b(beverages?|sodas?|waters?|drinks?|coffees?|teas?)\b/,      emoji: "🥤", life: { fridge: 180, freezer: 180, pantry: 180 } },
];
const DEFAULT = { emoji: "🛒", life: { fridge: 7, freezer: 90, pantry: 7 } };

function cleanCode(code) {
  code = String(code || "").replace(/\D/g, "");
  if (code.length < 6 || code.length > 14) {
    throw Object.assign(new Error("That doesn't look like a product barcode"), { status: 400 });
  }
  return code;
}

// Open Food Facts sometimes drops or stalls requests, so give it a couple of tries
async function fetchProduct(code) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${API}${code}.json?fields=${FIELDS}`, {
        // Open Food Facts asks apps to identify themselves
        headers: { "User-Agent": "EatMeFirst/0.1 (food-waste hackathon app)" },
        signal: AbortSignal.timeout(6000),
      });
      if (res.status === 404) return { status: 0 };          // not in the database
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 400 * attempt));
  }
  throw Object.assign(new Error("Couldn't reach the product database. Try again."), { status: 502 });
}

// Price/weight stickers printed by the store's own scale (meat counter, deli, loose produce).
// UPC-A starting with 2, or EAN-13 prefixes 20-29: only meaningful inside that one store.
export function isStoreLabel(code) {
  return (code.length === 12 && code[0] === "2") || (code.length === 13 && (code[0] === "2" || code.startsWith("02")));
}

// Turn an Open Food Facts response into our item shape (name, emoji, shelf life)
export function classify(code, data) {
  code = cleanCode(code);
  if (isStoreLabel(code)) return { found: false, storeLabel: true, code };
  const p = data?.product;
  const name = String(p?.product_name || p?.generic_name || "").trim();
  if (data?.status !== 1 || !name) return { found: false, code };

  const tags = Array.isArray(p.categories_tags) ? p.categories_tags : [];
  const haystack = [...tags, name].join(" ").toLowerCase();
  const rule = RULES.find((r) => r.match.test(haystack)) || DEFAULT;
  // Same emoji + generic name as the rest of the app (e.g. "Kirkland 2% Milk" -> 🥛 Milk)
  const est = estimate(`${name} ${tags.map((t) => t.replace(/^\w\w:/, "").replace(/-/g, " ")).join(" ")}`);
  const image = typeof p.image_front_small_url === "string" && p.image_front_small_url.startsWith("https://images.openfoodfacts.org/")
    ? p.image_front_small_url : null;
  return {
    found: true,
    code,
    name: name.slice(0, 50),
    brand: String(p.brands || "").split(",")[0].trim().slice(0, 40),
    quantity: String(p.quantity || "").slice(0, 20),
    image,
    emoji: est.matched ? est.emoji : rule.emoji,
    kind: est.kind,
    life: rule === DEFAULT && est.matched ? est.life : rule.life,
    guessed: rule === DEFAULT && !est.matched,
  };
}

export async function lookupBarcode(code) {
  code = cleanCode(code);
  if (isStoreLabel(code)) return { found: false, storeLabel: true, code };
  if (cache.has(code)) return cache.get(code);
  const result = classify(code, await fetchProduct(code));
  cache.set(code, result);
  return result;
}
