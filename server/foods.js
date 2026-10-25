// Everyday US groceries with typical shelf life in DAYS for each place they can be stored.
// Based on USDA FoodKeeper guidance (opened/fresh, rounded). One list powers:
//   - the quick-add buttons (grouped by section)
//   - estimating shelf life when someone types a food we don't know the days for
//   - the emoji shown next to an item
//   - the ingredient name used to find recipes
//
// `match` = words that mean this food when typed ("chicken thighs" -> Raw chicken).
// `ingredient` = what to search TheMealDB with, when it differs from the name
//   ("leftovers" / "drink" / "condiment" = not a cooking ingredient, skipped for recipes).
// Order matters for matching: more specific foods come before general ones.

export const SECTIONS = ["Meat & Seafood", "Dairy & Eggs", "Produce", "Bakery", "Leftovers & Prepared"];

export const FOODS = [
  // ---- Meat & Seafood (incl. butcher / fish counter, no barcode) ----
  { name: "Rotisserie chicken", emoji: "🍗", section: "Meat & Seafood", life: { fridge: 4, freezer: 120, pantry: 0.1 }, match: /rotisserie|cooked chicken|grilled chicken/, ingredient: "chicken" },
  { name: "Raw chicken", emoji: "🍗", section: "Meat & Seafood", life: { fridge: 2, freezer: 270, pantry: 0.1 }, match: /chicken|poultry|thigh|drumstick|wings?\b|turkey breast|ground turkey/, ingredient: "chicken" },
  { name: "Ground beef", emoji: "🥩", section: "Meat & Seafood", life: { fridge: 2, freezer: 120, pantry: 0.1 }, match: /ground (beef|meat|pork)|mince|hamburger|burger patt/ },
  { name: "Steak", emoji: "🥩", section: "Meat & Seafood", life: { fridge: 4, freezer: 180, pantry: 0.1 }, match: /steak|beef|roast|brisket|ribeye|sirloin/, ingredient: "beef" },
  { name: "Pork chops", emoji: "🥩", section: "Meat & Seafood", life: { fridge: 4, freezer: 180, pantry: 0.1 }, match: /pork|chops?\b|ribs?\b|tenderloin|lamb/, ingredient: "pork" },
  { name: "Bacon", emoji: "🥓", section: "Meat & Seafood", life: { fridge: 7, freezer: 30, pantry: 0.1 }, match: /bacon/ },
  { name: "Hot dogs", emoji: "🌭", section: "Meat & Seafood", life: { fridge: 7, freezer: 60, pantry: 0.1 }, match: /hot ?dogs?|franks?\b|wieners?/, ingredient: "sausages" },
  { name: "Sausages", emoji: "🌭", section: "Meat & Seafood", life: { fridge: 2, freezer: 60, pantry: 0.1 }, match: /sausage|bratwurst|chorizo|kielbasa/ },
  { name: "Deli meat", emoji: "🥪", section: "Meat & Seafood", life: { fridge: 4, freezer: 60, pantry: 0.1 }, match: /deli|lunch ?meat|cold cuts?|sliced (turkey|ham)|\bham\b|salami|pepperoni|prosciutto/, ingredient: "ham" },
  { name: "Fish fillets", emoji: "🐟", section: "Meat & Seafood", life: { fridge: 2, freezer: 180, pantry: 0.1 }, match: /fish|salmon|tilapia|\bcod\b|tuna steak|halibut|trout|mahi/, ingredient: "salmon" },
  { name: "Shrimp", emoji: "🦐", section: "Meat & Seafood", life: { fridge: 2, freezer: 180, pantry: 0.1 }, match: /shrimp|prawns?|scallops?|crab|lobster|seafood|mussels|clams/ },

  // ---- Dairy & Eggs ----
  { name: "Milk", emoji: "🥛", section: "Dairy & Eggs", life: { fridge: 7, freezer: 90, pantry: 0.25 }, match: /milk(?! ?chocolate)/ },
  { name: "Eggs", emoji: "🥚", section: "Dairy & Eggs", life: { fridge: 28, freezer: 365, pantry: 0.25 }, match: /\beggs?\b/ },
  { name: "Butter", emoji: "🧈", section: "Dairy & Eggs", life: { fridge: 60, freezer: 270, pantry: 2 }, match: /butter(?!milk)/ },
  { name: "Shredded cheese", emoji: "🧀", section: "Dairy & Eggs", life: { fridge: 7, freezer: 90, pantry: 0.2 }, match: /shredded|grated cheese|string cheese/, ingredient: "cheddar cheese" },
  { name: "Cream cheese", emoji: "🧀", section: "Dairy & Eggs", life: { fridge: 14, freezer: 60, pantry: 0.1 }, match: /cream cheese/ },
  { name: "Cheese", emoji: "🧀", section: "Dairy & Eggs", life: { fridge: 28, freezer: 180, pantry: 0.5 }, match: /chees|cheddar|mozzarella|parmesan|swiss|brie|feta|gouda/ },
  { name: "Yogurt", emoji: "🥣", section: "Dairy & Eggs", life: { fridge: 14, freezer: 60, pantry: 0.2 }, match: /yog(h)?urt|kefir/ },
  { name: "Sour cream", emoji: "🥣", section: "Dairy & Eggs", life: { fridge: 14, freezer: 60, pantry: 0.1 }, match: /sour cream|cottage cheese/ },
  { name: "Ice cream", emoji: "🍨", section: "Dairy & Eggs", life: { fridge: 0.5, freezer: 60, pantry: 0.05 }, match: /ice cream|gelato|sorbet|frozen yog/, ingredient: "condiment" },
  { name: "Heavy cream", emoji: "🥛", section: "Dairy & Eggs", life: { fridge: 10, freezer: 90, pantry: 0.1 }, match: /cream|half (and|&) half|creamer/, ingredient: "double cream" },

  // ---- Produce (mostly loose, no barcode) ----
  { name: "Bananas", emoji: "🍌", section: "Produce", life: { fridge: 7, freezer: 60, pantry: 5 }, match: /banana/ },
  { name: "Apples", emoji: "🍎", section: "Produce", life: { fridge: 30, freezer: 240, pantry: 7 }, match: /\bapples?\b(?! ?juice)/ },
  { name: "Oranges", emoji: "🍊", section: "Produce", life: { fridge: 21, freezer: 120, pantry: 7 }, match: /orange(?! ?juice)|clementine|mandarin|tangerine|grapefruit/ },
  { name: "Lemons & limes", emoji: "🍋", section: "Produce", life: { fridge: 21, freezer: 120, pantry: 7 }, match: /lemon|lime/, ingredient: "lemon" },
  { name: "Grapes", emoji: "🍇", section: "Produce", life: { fridge: 7, freezer: 300, pantry: 1 }, match: /grape(?!fruit)/ },
  { name: "Strawberries", emoji: "🍓", section: "Produce", life: { fridge: 5, freezer: 240, pantry: 1 }, match: /strawberr/ },
  { name: "Berries", emoji: "🫐", section: "Produce", life: { fridge: 7, freezer: 300, pantry: 1 }, match: /berr/, ingredient: "blueberries" },
  { name: "Cut fruit", emoji: "🍉", section: "Produce", life: { fridge: 4, freezer: 240, pantry: 0.1 }, match: /cut fruit|fruit salad|melon|watermelon|pineapple|cantaloupe|mango|peach|nectarine|plum|pear|cherr|kiwi/, ingredient: "pineapple" },
  { name: "Avocados", emoji: "🥑", section: "Produce", life: { fridge: 4, freezer: 120, pantry: 4 }, match: /avocado|guac/, ingredient: "avocado" },
  { name: "Tomatoes", emoji: "🍅", section: "Produce", life: { fridge: 5, freezer: 60, pantry: 5 }, match: /tomato/ },
  { name: "Salad greens", emoji: "🥬", section: "Produce", life: { fridge: 5, freezer: 30, pantry: 0.5 }, match: /lettuce|salad|greens|kale|arugula|romaine|cabbage|chard|bok choy/, ingredient: "lettuce" },
  { name: "Spinach", emoji: "🥬", section: "Produce", life: { fridge: 5, freezer: 240, pantry: 0.5 }, match: /spinach/ },
  { name: "Broccoli", emoji: "🥦", section: "Produce", life: { fridge: 5, freezer: 300, pantry: 1 }, match: /broccoli|cauliflower|brussels|asparagus|green beans/ },
  { name: "Carrots", emoji: "🥕", section: "Produce", life: { fridge: 21, freezer: 300, pantry: 4 }, match: /carrot|celery|radish|beet/ },
  { name: "Bell peppers", emoji: "🫑", section: "Produce", life: { fridge: 10, freezer: 240, pantry: 2 }, match: /pepper(?!oni)|jalape/, ingredient: "red pepper" },
  { name: "Cucumbers", emoji: "🥒", section: "Produce", life: { fridge: 7, freezer: 30, pantry: 2 }, match: /cucumber|zucchini|squash/, ingredient: "cucumber" },
  { name: "Mushrooms", emoji: "🍄", section: "Produce", life: { fridge: 7, freezer: 240, pantry: 1 }, match: /mushroom/ },
  { name: "Corn", emoji: "🌽", section: "Produce", life: { fridge: 2, freezer: 240, pantry: 1 }, match: /\bcorn\b/ },
  { name: "Fresh herbs", emoji: "🌿", section: "Produce", life: { fridge: 7, freezer: 120, pantry: 1 }, match: /herb|cilantro|parsley|basil|mint|dill|rosemary|thyme|scallion|green onion/, ingredient: "parsley" },
  { name: "Potatoes", emoji: "🥔", section: "Produce", life: { fridge: 14, freezer: 300, pantry: 30 }, match: /potato|yam/ },
  { name: "Onions", emoji: "🧅", section: "Produce", life: { fridge: 30, freezer: 240, pantry: 30 }, match: /onion|garlic|shallot/, ingredient: "onion" },

  // ---- Bakery ----
  { name: "Bread", emoji: "🍞", section: "Bakery", life: { fridge: 7, freezer: 90, pantry: 5 }, match: /bread|loaf|buns?\b|rolls?\b|baguette|sourdough|brioche/ },
  { name: "Tortillas", emoji: "🫓", section: "Bakery", life: { fridge: 21, freezer: 180, pantry: 7 }, match: /tortilla|wraps?\b|pita|naan|flatbread/ },
  { name: "Bagels & muffins", emoji: "🥯", section: "Bakery", life: { fridge: 7, freezer: 90, pantry: 3 }, match: /bagel|muffin|croissant|donut|doughnut|pastr|cake|cookies?/, ingredient: "flour" },

  // ---- Leftovers & Prepared ----
  { name: "Sushi", emoji: "🍣", section: "Leftovers & Prepared", life: { fridge: 1, freezer: 30, pantry: 0.1 }, match: /sushi|poke|sashimi/, ingredient: "leftovers" },
  { name: "Pizza", emoji: "🍕", section: "Leftovers & Prepared", life: { fridge: 4, freezer: 60, pantry: 0.1 }, match: /pizza/, ingredient: "leftovers" },
  { name: "Takeout", emoji: "🥡", section: "Leftovers & Prepared", life: { fridge: 4, freezer: 60, pantry: 0.1 }, match: /takeout|take-out|take out|chinese|thai|indian|burrito|tacos?\b/, ingredient: "leftovers" },
  { name: "Leftovers", emoji: "🍱", section: "Leftovers & Prepared", life: { fridge: 4, freezer: 90, pantry: 0.1 }, match: /leftover|cooked|soup|stew|chili|curry|lasagna|casserole|pasta|noodle|rice|stir.?fry|meatloaf|mac (and|&|n) cheese|meal prep/, ingredient: "leftovers" },
  { name: "Hummus & dips", emoji: "🫙", section: "Leftovers & Prepared", life: { fridge: 7, freezer: 120, pantry: 0.1 }, match: /hummus|dip\b|salsa|pesto|tzatziki/, ingredient: "chickpeas" },
  { name: "Tofu", emoji: "🫘", section: "Leftovers & Prepared", life: { fridge: 5, freezer: 150, pantry: 0.1 }, match: /tofu|tempeh/ },
  { name: "Juice", emoji: "🧃", section: "Leftovers & Prepared", life: { fridge: 10, freezer: 240, pantry: 0.5 }, match: /juice|smoothie|lemonade/, ingredient: "drink" },
  { name: "Opened sauce", emoji: "🫙", section: "Leftovers & Prepared", life: { fridge: 60, freezer: 180, pantry: 30 }, match: /sauce|ketchup|mayo|mustard|dressing|jam|jelly|syrup|condiment|pickles?/, ingredient: "condiment" },
];

// When nothing matches, assume a typical perishable: about 5 days in the fridge (better safe than sorry)
const UNKNOWN = { emoji: "🍽️", life: { fridge: 5, freezer: 60, pantry: 2 } };

// Ready-made dishes win over their ingredients: "pepperoni pizza" is pizza, "chicken curry" is leftovers
const DISHES = FOODS.filter((f) => f.ingredient === "leftovers");

export function findFood(text) {
  const t = ` ${String(text || "").toLowerCase()} `;
  return FOODS.find((f) => f.name.toLowerCase() === t.trim())
    || DISHES.find((f) => f.match.test(t))
    || FOODS.find((f) => f.match.test(t))
    || null;
}

// Best guess for anything typed or scanned
export function estimate(name) {
  const food = findFood(name);
  return food
    ? { matched: food.name, emoji: food.emoji, life: { ...food.life }, kind: food.ingredient || food.name, section: food.section, guessed: false }
    : { matched: null, emoji: UNKNOWN.emoji, life: { ...UNKNOWN.life }, kind: null, section: null, guessed: true };
}

// What the app shows as quick-add buttons
export const QUICK_ADD = SECTIONS.map((section) => ({
  section,
  foods: FOODS.filter((f) => f.section === section && !/^(Opened sauce|Hot dogs|Sausages|Cream cheese|Sour cream|Heavy cream|Ice cream)$/.test(f.name))
    .map(({ name, emoji, life }) => ({ name, emoji, days: life.fridge })),
}));

// Fake items for an empty database. `used` = fraction of life already consumed.
export const SEED = [
  { name: "Strawberries", used: 0.72 },
  { name: "Raw chicken", used: 0.55 },
  { name: "Milk", used: 0.4 },
  { name: "Spinach", used: 0.3 },
  { name: "Eggs", used: 0.2 },
  { name: "Cheese", used: 0.1 },
];
