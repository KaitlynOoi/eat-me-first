// Base shelf life in DAYS for each environment. Used by quick-add and the seed data.
// Rough consumer guidance (USDA FoodKeeper-ish), good enough for a demo.
export const CATALOG = [
  { name: "Milk",           emoji: "🥛", life: { fridge: 7,  freezer: 90,  pantry: 0.25 } },
  { name: "Eggs",           emoji: "🥚", life: { fridge: 28, freezer: 365, pantry: 7 } },
  { name: "Bread",          emoji: "🍞", life: { fridge: 7,  freezer: 90,  pantry: 5 } },
  { name: "Bananas",        emoji: "🍌", life: { fridge: 7,  freezer: 60,  pantry: 5 } },
  { name: "Apples",         emoji: "🍎", life: { fridge: 30, freezer: 240, pantry: 7 } },
  { name: "Strawberries",   emoji: "🍓", life: { fridge: 5,  freezer: 240, pantry: 1 } },
  { name: "Avocado",        emoji: "🥑", life: { fridge: 5,  freezer: 120, pantry: 4 } },
  { name: "Tomatoes",       emoji: "🍅", life: { fridge: 7,  freezer: 60,  pantry: 5 } },
  { name: "Spinach",        emoji: "🥬", life: { fridge: 5,  freezer: 240, pantry: 0.5 } },
  { name: "Broccoli",       emoji: "🥦", life: { fridge: 5,  freezer: 300, pantry: 1 } },
  { name: "Chicken breast", emoji: "🍗", life: { fridge: 2,  freezer: 270, pantry: 0.1 } },
  { name: "Ground beef",    emoji: "🥩", life: { fridge: 2,  freezer: 120, pantry: 0.1 } },
  { name: "Yogurt",         emoji: "🥣", life: { fridge: 14, freezer: 60,  pantry: 0.2 } },
  { name: "Cheese",         emoji: "🧀", life: { fridge: 21, freezer: 180, pantry: 1 } },
  { name: "Leftovers",      emoji: "🍱", life: { fridge: 4,  freezer: 90,  pantry: 0.1 } },
];

// Fake items for an empty database. `used` = fraction of life already consumed.
export const SEED = [
  { name: "Strawberries",   used: 0.72 },
  { name: "Chicken breast", used: 0.55 },
  { name: "Milk",           used: 0.4 },
  { name: "Spinach",        used: 0.3 },
  { name: "Eggs",           used: 0.2 },
  { name: "Cheese",         used: 0.1 },
];
