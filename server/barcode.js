// Free barcode lookup via Open Food Facts (no API key).
// We get the product name + categories, then guess shelf life from the category.
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

export async function lookupBarcode(code) {
  code = String(code || "").replace(/\D/g, "");
  if (code.length < 6 || code.length > 14) {
    throw Object.assign(new Error("That doesn't look like a product barcode"), { status: 400 });
  }
  if (cache.has(code)) return cache.get(code);

  let data;
  try {
    const res = await fetch(`${API}${code}.json?fields=${FIELDS}`, {
      // Open Food Facts asks apps to identify themselves
      headers: { "User-Agent": "EatMeFirst/0.1 (food-waste hackathon app)" },
      signal: AbortSignal.timeout(8000),
    });
    data = await res.json();
  } catch {
    throw Object.assign(new Error("Couldn't reach the product database. Try again."), { status: 502 });
  }

  const p = data?.product;
  const name = (p?.product_name || p?.generic_name || "").trim();
  if (data?.status !== 1 || !name) {
    const result = { found: false, code };
    cache.set(code, result);
    return result;
  }

  const haystack = [...(p.categories_tags || []), name].join(" ").toLowerCase();
  const rule = RULES.find((r) => r.match.test(haystack)) || DEFAULT;
  const brand = (p.brands || "").split(",")[0].trim();
  const result = {
    found: true,
    code,
    name: name.slice(0, 50),
    brand,
    quantity: p.quantity || "",
    image: p.image_front_small_url || null,
    emoji: rule.emoji,
    life: rule.life,
    guessed: rule === DEFAULT,
  };
  cache.set(code, result);
  return result;
}
