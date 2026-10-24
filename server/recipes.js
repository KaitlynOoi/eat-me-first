// Free recipe ideas from TheMealDB (no API key, no cost).
// We look up meals for each soon-expiring item and rank meals that use several of them first.
const API = "https://www.themealdb.com/api/json/v1/1/filter.php?i=";
const cache = new Map();

async function mealsFor(name) {
  const base = name.toLowerCase().trim();
  // TheMealDB names vary ("banana" vs "bananas"), so try a couple of spellings
  const variants = [...new Set([base, base.replace(/(es|s)$/, ""), base.split(" ").at(-1)])];
  for (const v of variants) {
    const key = v.replace(/\s+/g, "_");
    if (!cache.has(key)) {
      try {
        const res = await fetch(API + encodeURIComponent(key));
        cache.set(key, (await res.json()).meals || []);
      } catch { cache.set(key, []); }
    }
    if (cache.get(key).length) return cache.get(key);
  }
  return [];
}

// items: soonest-expiring first, e.g. [{name: "Spinach"}, ...]
export async function suggestRecipes(items, limit = 5) {
  const byMeal = new Map();
  for (const [rank, item] of items.slice(0, 5).entries()) {
    for (const m of await mealsFor(item.name)) {
      const entry = byMeal.get(m.idMeal) || {
        title: m.strMeal,
        image: m.strMealThumb,
        url: `https://www.themealdb.com/meal/${m.idMeal}`,
        uses: [],
        score: 0,
      };
      entry.uses.push(item.name);
      entry.score += 10 - rank; // using the most urgent item counts most
      byMeal.set(m.idMeal, entry);
    }
  }
  return [...byMeal.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

// One-line idea for a push notification
export async function quickIdea(names) {
  const [top] = await suggestRecipes(names.map((name) => ({ name })), 1);
  return top ? `${top.title} - ${top.url}` : "";
}
