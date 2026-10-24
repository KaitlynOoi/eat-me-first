// Free recipe ideas from TheMealDB (no API key, no cost).
//
// How recommendations work ("cook from your fridge"):
// 1. For each food in the fridge (most urgent first), ask TheMealDB which meals use it.
// 2. Read each candidate meal's full ingredient list and check it against EVERYTHING in the fridge:
//    which fridge foods it uses, and what you'd still need to buy (ignoring basics like salt and oil).
// 3. Score = sum of urgency points of the fridge foods it uses (expires today 10, tomorrow 6,
//    within 4 days 3, otherwise 1) minus a little for every ingredient you'd need to buy.
// 4. Pick a varied top list (food already covered by a picked recipe counts less next time),
//    plus one recipe per food that expires within 2 days.
//
// Search uses the same scoring, so search results that use your fridge food come first.
const BASE = "https://www.themealdb.com/api/json/v1/1";
const filterCache = new Map();
const mealCache = new Map();

// Pantry staples most kitchens already have, so they don't count as "need to buy"
const BASICS = new Set([
  "salt", "pepper", "black pepper", "water", "ice", "olive oil", "vegetable oil", "sunflower oil", "oil", "butter",
  "sugar", "brown sugar", "caster sugar", "plain flour", "flour", "self-raising flour", "cornstarch", "cornflour",
  "baking powder", "bicarbonate of soda", "baking soda", "yeast", "vanilla extract", "honey",
  "garlic", "garlic clove", "onion", "rice", "pasta", "spaghetti",
  "soy sauce", "vinegar", "white vinegar", "ketchup", "mustard", "mayonnaise", "tomato puree", "tomato paste",
  "paprika", "cumin", "ground cumin", "chili powder", "chilli powder", "oregano", "dried oregano", "cinnamon", "ground cinnamon",
  "thyme", "bay leaf", "bay leaves", "basil", "parsley", "nutmeg", "turmeric", "curry powder", "garam masala",
  "cayenne pepper", "red pepper flakes", "chilli flakes", "ginger", "stock", "chicken stock", "beef stock", "vegetable stock",
].map(stem));

// Kinds that aren't cooking ingredients (set in foods.js)
const NOT_INGREDIENTS = new Set(["leftovers", "drink", "condiment"]);

function stem(s) {
  return String(s).toLowerCase().trim().split(/\s+/)
    .map((w) => w.replace(/ies$/, "y").replace(/oes$/, "o").replace(/s$/, ""))
    .join(" ");
}

// The word we match recipes on: the generic kind ("Milk") rather than a brand name
const term = (item) => item.kind || item.name;
const isReadyToEat = (item) => NOT_INGREDIENTS.has(String(item.kind || "").toLowerCase()) || /leftover/i.test(item.name);

// How urgent an item is -> how much using it is worth
function weight(days) {
  if (days < 1) return 10;
  if (days < 2) return 6;
  if (days < 4) return 3;
  return 1;
}

async function getJson(url) {
  try { return await (await fetch(url, { signal: AbortSignal.timeout(8000) })).json(); } catch { return {}; }
}

async function mealsFor(name) {
  const base = name.toLowerCase().trim();
  // TheMealDB names vary ("banana" vs "bananas"), so try a couple of spellings
  const variants = [...new Set([base, base.replace(/(es|s)$/, ""), base.split(" ").at(-1)])];
  for (const v of variants) {
    const key = v.replace(/\s+/g, "_");
    if (!filterCache.has(key)) filterCache.set(key, (await getJson(`${BASE}/filter.php?i=${encodeURIComponent(key)}`)).meals || []);
    if (filterCache.get(key).length) return filterCache.get(key);
  }
  return [];
}

function remember(meal) {
  const ingredients = [];
  for (let n = 1; n <= 20; n++) {
    const ing = meal?.[`strIngredient${n}`]?.trim();
    if (ing) ingredients.push(ing);
  }
  const details = { id: meal.idMeal, title: meal.strMeal, image: meal.strMealThumb, ingredients, category: meal.strCategory || "" };
  mealCache.set(meal.idMeal, details);
  return details;
}

async function mealDetails(id) {
  if (!mealCache.has(id)) {
    const meal = (await getJson(`${BASE}/lookup.php?i=${id}`)).meals?.[0];
    if (!meal) return null;
    remember(meal);
  }
  return mealCache.get(id);
}

// Does this fridge item appear in this ingredient? ("Chicken breast" ~ "Chicken Breasts")
// "Chicken stock" or "garlic powder" doesn't mean the recipe uses your fresh chicken or garlic
const DERIVED = /stock|broth|bouillon|powder|extract|essence|granules|seasoning|flavou?r/i;

function matches(item, ingredient) {
  if (DERIVED.test(ingredient)) return false;
  const a = stem(term(item));
  const b = stem(ingredient);
  return b === a || ` ${b} `.includes(` ${a} `) || ` ${a} `.includes(` ${b} `);
}

// Compare a meal with the fridge: what it uses, what you'd need to buy, and a score
function annotate(meal, food) {
  const usedAll = food.filter((item) => meal.ingredients.some((ing) => matches(item, ing)));
  // Two cartons of milk are one ingredient: keep the most urgent of each kind (food is sorted by urgency)
  const seenKinds = new Set();
  const used = usedAll.filter((i) => { const k = stem(term(i)); return !seenKinds.has(k) && seenKinds.add(k); });
  const missing = meal.ingredients.filter((ing) => !BASICS.has(stem(ing)) && !food.some((item) => matches(item, ing)));
  return {
    id: meal.id,
    title: meal.title,
    image: meal.image,
    category: meal.category,
    url: `https://www.themealdb.com/meal/${meal.id}`,
    uses: used.map((i) => i.name),
    usesFirstIds: used.map((i) => i.id), // parallel to `uses`
    usesIds: usedAll.map((i) => i.id),    // every fridge item this recipe would use up
    missing: missing.slice(0, 5),
    missingAll: missing,
    missingCount: missing.length,
    // Urgency of what it uses + a bonus for how much of the recipe you already have,
    // minus a real penalty for every ingredient you'd have to go and buy
    score: used.reduce((s, i) => s + weight(i.remainingDays), 0)
      + (4 * used.length) / Math.max(1, used.length + missing.length)
      - missing.length * 1.0,
  };
}

// items: active fridge items, soonest-expiring first, each with {id, name, kind, remainingDays}
export async function suggestRecipes(items) {
  const food = items.filter((i) => !isReadyToEat(i));

  // Step 1: candidate meals, pre-scored by which fridge items led us to them
  const candidates = new Map();
  const perItem = new Set(); // a few meals for EVERY item, so one popular item can't crowd out the rest
  for (const item of food.slice(0, 10)) {
    const meals = await mealsFor(term(item));
    meals.slice(0, 6).forEach((m) => perItem.add(m.idMeal));
    for (const m of meals) {
      const c = candidates.get(m.idMeal) || { id: m.idMeal, pre: 0 };
      c.pre += weight(item.remainingDays);
      candidates.set(m.idMeal, c);
    }
  }
  const topOverall = [...candidates.values()].sort((a, b) => b.pre - a.pre).slice(0, 20).map((c) => c.id);
  const shortlist = [...new Set([...topOverall, ...perItem])].slice(0, 45);

  // Step 2: full ingredient lists -> what you have vs what you'd need to buy
  const meals = (await Promise.all(shortlist.map(mealDetails))).filter(Boolean);
  const ranked = meals.map((m) => annotate(m, food)).filter((r) => r.uses.length).sort((a, b) => b.score - a.score);
  // Keep it short and close to what you have: 5 picks needing at most 4 things from the store
  // (loosen only if nothing fits)
  const fewExtras = ranked.filter((r) => r.missingCount <= 4);
  const fridge = varied(fewExtras.length >= 3 ? fewExtras : ranked.filter((r) => r.missingCount <= 8), food, 5);

  // Step 3: one suggestion per urgent item (under 2 days left), each a different recipe
  const taken = new Set();
  const urgent = items.filter((i) => i.remainingDays < 2).map((item) => {
    if (isReadyToEat(item)) {
      return { item: item.name, itemId: item.id, days: item.remainingDays, tip: "Ready to eat: have it today, or freeze it now to keep it for later." };
    }
    const recipe = ranked.find((r) => r.usesIds.includes(item.id) && !taken.has(r.id));
    if (recipe) taken.add(recipe.id);
    return {
      item: item.name, itemId: item.id, days: item.remainingDays, recipe: recipe || null,
      tip: recipe ? null : "No recipe match. Eat it as a snack or freeze it today.",
    };
  });

  return { urgent, fridge };
}

// Search any recipe by name or ingredient, ranked by how much of your fridge it uses
export async function searchRecipes(query, items) {
  const q = String(query || "").trim().slice(0, 40);
  if (q.length < 2) return { results: [] };
  const food = items.filter((i) => !isReadyToEat(i));

  // Match by dish name, plus category ("pasta", "dessert"), cuisine ("italian", "mexican") and ingredient
  const title = q.toLowerCase().replace(/(es|s)$/, "").replace(/\b\w/g, (c) => c.toUpperCase());
  const [named, byCategory, byArea, byIngredient] = await Promise.all([
    getJson(`${BASE}/search.php?s=${encodeURIComponent(q)}`).then((d) => (d.meals || []).map(remember)),
    getJson(`${BASE}/filter.php?c=${encodeURIComponent(title)}`).then((d) => d.meals || []),
    getJson(`${BASE}/filter.php?a=${encodeURIComponent(title)}`).then((d) => d.meals || []),
    mealsFor(q),
  ]);
  const otherIds = [...byCategory, ...byArea, ...byIngredient].map((m) => m.idMeal);
  const ids = [...new Set([...named.map((m) => m.id), ...otherIds])].slice(0, 30);
  const meals = (await Promise.all(ids.map(mealDetails))).filter(Boolean);
  const results = meals
    .map((m) => annotate(m, food))
    .sort((a, b) => b.score - a.score || a.missingCount - b.missingCount)
    .slice(0, 12);
  return { results };
}

// Pick recipes one at a time; food that's already covered counts less, so the list isn't 8 chicken dishes
function varied(ranked, food, limit) {
  const covered = new Map(); // item id -> times used so far
  const pool = [...ranked];
  const picked = [];
  while (picked.length < limit && pool.length) {
    let best = 0, bestScore = -Infinity;
    pool.forEach((r, n) => {
      const sc = r.usesIds.reduce((s, id) => {
        const item = food.find((i) => i.id === id);
        return s + weight(item.remainingDays) / (1 + 2 * (covered.get(id) || 0));
      }, 0) - r.missingCount * 1.0;
      if (sc > bestScore) { bestScore = sc; best = n; }
    });
    const [r] = pool.splice(best, 1);
    r.usesIds.forEach((id) => covered.set(id, (covered.get(id) || 0) + 1));
    picked.push(r);
  }
  return picked;
}

// One-line idea for a push notification
export async function quickIdea(items) {
  const { fridge } = await suggestRecipes(items.map((i) => ({ ...i, remainingDays: 1 })));
  return fridge[0] ? `${fridge[0].title} - ${fridge[0].url}` : "";
}
