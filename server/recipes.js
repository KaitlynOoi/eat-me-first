// Free recipe ideas from TheMealDB (no API key, no cost).
// 1. Find meals that use each item in the fridge.
// 2. Read each meal's full ingredient list and count how much of it is already in the fridge.
// 3. Rank meals that use the most urgent food first.
const BASE = "https://www.themealdb.com/api/json/v1/1";
const filterCache = new Map();
const mealCache = new Map();

// Things almost everyone has, so they don't count as "missing"
const BASICS = new Set(["salt", "pepper", "black pepper", "water", "olive oil", "vegetable oil", "oil", "butter",
  "sugar", "plain flour", "flour", "garlic", "onion", "rice", "pasta"].map(stem));

function stem(s) {
  return String(s).toLowerCase().trim().split(/\s+/)
    .map((w) => w.replace(/ies$/, "y").replace(/oes$/, "o").replace(/s$/, ""))
    .join(" ");
}

const isLeftovers = (name) => /leftover/i.test(name);

// How urgent an item is -> how much using it is worth
function weight(days) {
  if (days < 1) return 10;
  if (days < 2) return 6;
  if (days < 4) return 3;
  return 1;
}

async function getJson(url) {
  try { return await (await fetch(url)).json(); } catch { return {}; }
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

async function mealDetails(id) {
  if (!mealCache.has(id)) {
    const meal = (await getJson(`${BASE}/lookup.php?i=${id}`)).meals?.[0];
    const ingredients = [];
    for (let n = 1; n <= 20; n++) {
      const ing = meal?.[`strIngredient${n}`]?.trim();
      if (ing) ingredients.push(ing);
    }
    mealCache.set(id, { ingredients, category: meal?.strCategory || "" });
  }
  return mealCache.get(id);
}

// Does this fridge item appear in this ingredient? ("Chicken breast" ~ "Chicken Breasts")
function matches(itemName, ingredient) {
  const a = stem(itemName);
  const b = stem(ingredient);
  return b === a || ` ${b} `.includes(` ${a} `) || ` ${a} `.includes(` ${b} `);
}

// items: active fridge items, soonest-expiring first, each with {id, name, remainingDays}
export async function suggestRecipes(items) {
  const food = items.filter((i) => !isLeftovers(i.name));

  // Step 1: candidate meals, pre-scored by which fridge items led us to them
  const candidates = new Map();
  const perItem = new Set(); // a few meals for EVERY item, so one popular item can't crowd out the rest
  for (const item of food.slice(0, 10)) {
    const meals = await mealsFor(item.name);
    meals.slice(0, 4).forEach((m) => perItem.add(m.idMeal));
    for (const m of meals) {
      const c = candidates.get(m.idMeal) || { id: m.idMeal, title: m.strMeal, image: m.strMealThumb, pre: 0 };
      c.pre += weight(item.remainingDays);
      candidates.set(m.idMeal, c);
    }
  }
  const topOverall = [...candidates.values()].sort((a, b) => b.pre - a.pre).slice(0, 12);
  const shortlist = [...new Map([...topOverall, ...[...perItem].map((id) => candidates.get(id))].map((c) => [c.id, c])).values()];

  // Step 2: full ingredient lists -> what you have vs what you'd need to buy
  const recipes = await Promise.all(shortlist.map(async (c) => {
    const { ingredients, category } = await mealDetails(c.id);
    const used = food.filter((item) => ingredients.some((ing) => matches(item.name, ing)));
    const missing = ingredients.filter((ing) =>
      !BASICS.has(stem(ing)) && !food.some((item) => matches(item.name, ing)));
    return {
      id: c.id,
      title: c.title,
      image: c.image,
      category,
      url: `https://www.themealdb.com/meal/${c.id}`,
      uses: used.map((i) => i.name),
      usesIds: used.map((i) => i.id),
      missing: missing.slice(0, 5),
      missingCount: missing.length,
      score: used.reduce((s, i) => s + weight(i.remainingDays), 0) - missing.length * 0.3,
    };
  }));
  const ranked = recipes.filter((r) => r.uses.length).sort((a, b) => b.score - a.score);
  const fridge = varied(ranked, food, 8);

  // Step 3: one suggestion per urgent item (under 2 days left), each a different recipe
  const taken = new Set();
  const urgent = items.filter((i) => i.remainingDays < 2).map((item) => {
    if (isLeftovers(item.name)) {
      return { item: item.name, itemId: item.id, days: item.remainingDays, tip: "Reheat and eat it today, or freeze it now to keep it for later." };
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
      }, 0) - r.missingCount * 0.3;
      if (sc > bestScore) { bestScore = sc; best = n; }
    });
    const [r] = pool.splice(best, 1);
    r.usesIds.forEach((id) => covered.set(id, (covered.get(id) || 0) + 1));
    picked.push(r);
  }
  return picked;
}

// One-line idea for a push notification
export async function quickIdea(names) {
  const { fridge } = await suggestRecipes(names.map((name, n) => ({ id: `n${n}`, name, remainingDays: 1 })));
  return fridge[0] ? `${fridge[0].title} - ${fridge[0].url}` : "";
}
