# 🥕 Eat Me First

A sensor pod for your fridge, freezer or pantry, plus a phone web app. It tracks your food, warns you before it goes off, and suggests recipes that use the soonest-expiring items.

**Everything is free by default.** No hardware yet? A built-in fake pod sends readings so the whole app works today.

| Part | How | Cost |
|---|---|---|
| Data storage | `data.json` on your laptop (Firebase free tier optional) | Free |
| Recipes | [TheMealDB](https://www.themealdb.com) public API | Free, no key |
| Phone alerts | [ntfy.sh](https://ntfy.sh) | Free, no account |
| Adding food | Barcode scan ([Open Food Facts](https://world.openfoodfacts.org)), quick-add, type anything | Free |
| Fresh produce photos | TensorFlow.js + MobileNet, on the phone | Free |
| AI photo scan (optional) | Claude Haiku | Under 1 cent per photo |

## Features
- **Fridge tab:**
  - A weekly score: eaten vs tossed, % saved, ≈ $ saved, and which food you waste most.
  - A **Cook these today** card with a recipe for each item expiring within 2 days.
  - Food grouped into Eat today, Eat soon and Fresh.
  - Tap an item to edit its days left: Opened it, +1 day, Use today, or Remove if you added it by mistake.
- **✓ Ate it / Tossed:** each one counts toward your score, every action has **Undo**, and **Recently removed** has a Restore button for anything you got wrong.
- **Add tab:**
  - **Barcode scan** (free): point the phone camera at a pack, and the product name plus estimated shelf life come from Open Food Facts. Decoding runs on the phone with [zxing-cpp](https://github.com/zxing-cpp/zxing-cpp) (or the phone's built-in reader on Android). If the camera doesn't work, use a photo of the barcode or type the number.
  - **Type any food:** we estimate how long it lasts from the name (e.g. "chicken thighs" → 2 days) and you can change it.
  - **Quick add:** about 45 everyday US groceries, grouped by Meat & Seafood, Dairy & Eggs, Produce, Bakery and Leftovers. Use these for butcher, deli and loose produce that have no barcode.
  - **Snap fresh produce** (free, on-phone AI): take a photo of one fruit or vegetable. MobileNet v2 (TensorFlow.js, self-hosted, ~15 MB, downloaded on first use) shows its top guesses with confidence. You confirm or pick the right one before anything is added. It recognizes about 35 foods (banana, apple, orange, lemon, strawberry, pineapple, broccoli, cauliflower, cucumber, zucchini, bell pepper, corn, pizza…). Tomatoes, carrots, onions, potatoes and meat aren't in the model, so pick those from the list.
  - **Store price stickers** (meat/deli/produce scale labels) are recognized when scanned, and you pick what it is.
  - AI photo scan appears only when an Anthropic key is set.
- **Recipes tab:** **search** any dish, ingredient, category or cuisine ("pasta", "mexican", "dessert"). Results and recommendations are ranked by how much of your soon-to-expire fridge food they use. Chips show what you have and what you'd need to buy, and **🛒 Add to list** sends the missing items to your shopping list.
- **List tab:** a shopping list. Tap to tick items off, then clear the checked ones.

## Run it

You need [Node.js 18+](https://nodejs.org).

```bash
npm install
cp .env.example .env
npm start
```

Open http://localhost:3000. To use it on your phone, connect to the same WiFi and open the "your phone" address that the server prints.

## Put it online for anyone (free, Render)
1. **Set up Firebase first** (see below). Free Render servers restart often and wipe local files, so without Firebase your food list resets to the demo items.
2. Go to https://render.com and sign up with **GitHub**. Allow Render to access the `eat-me-first` repo.
3. Click **New + → Blueprint** and choose `eat-me-first`. Render reads `render.yaml`.
4. Fill in `FIREBASE_DB_URL`, plus `NTFY_TOPIC` and `ANTHROPIC_API_KEY` if you use them, then click **Apply**.
5. After about 2 minutes you get a public link like `https://eat-me-first.onrender.com`.

Every `git push` redeploys the app automatically.

Free plan notes:
- The app sleeps after 15 minutes with no visitors, and the first visit after that takes about 30 seconds to load. Open it a minute before you present.
- While it's asleep, the alert checks stop too. A free ping service such as UptimeRobot can load `/api/state` every 10 minutes to keep it awake.
- Anyone with the link can see and change the food list.

## Turn on phone alerts (2 minutes)
1. Install the **ntfy** app (iOS/Android).
2. Choose an unguessable topic name, e.g. `eatmefirst-k7x92q`. Subscribe to it in the app.
3. Put it in `.env` as `NTFY_TOPIC=eatmefirst-k7x92q` and restart.
4. In the app, open **Fridge → Demo controls → Send test phone alert**.

## Turn on photo scan (optional)
Get an API key at https://console.anthropic.com, then put `ANTHROPIC_API_KEY=...` in `.env` and restart. Without a key, the photo button is hidden and quick-add still works.

## Use Firebase instead of data.json (optional)
1. Go to https://console.firebase.google.com, add a project, then go to **Build → Realtime Database → Create database** and choose **test mode**.
2. Copy the database URL (e.g. `https://eat-me-first-default-rtdb.firebaseio.com`) into `.env` as `FIREBASE_DB_URL`.
3. Restart the server.

## Demo tips
The Fridge tab has **Demo controls** that make the fake pod act out each scenario:
- **Fridge failing (9°C)** triggers the food-safety alert after `WARM_ALERT_MIN` minutes.
- **Banana ripening** makes gas rise above the baseline and triggers a "something is ripening" alert.
- **Freezer / Pantry** "moves" the pod, so it detects the new environment and items age at a different rate.

For a live demo, shorten the timers in `.env`:
```
AVG_WINDOW_MIN=0.5
WARM_ALERT_MIN=1
```

## How it works
- **Environment:** the average temperature over the last 15 minutes decides where the pod is. Below -10°C is the freezer, 0–5°C is the fridge, and 15–25°C is the pantry. In-between temperatures (like an open door) keep the last known environment.
- **Shelf life:** each item has a base life in each environment, and the item's age adds up as a fraction of that life. Time in a fridge above 7°C counts at pantry speed.
- **Alerts:**
  - Fridge above 7°C for 1+ hour
  - Gas rising for 3+ readings above baseline +25%
  - Any item with under 2 days left. This alert includes a free recipe idea.

## The pod: automatic, or your own settings
- **Real pod connected:** everything is sensed automatically. Location (fridge/freezer/pantry) comes from the 15-minute temperature average, and spoilage speed comes from temperature and gas.
- **No pod:** the app uses your settings (⚙️ → Where is your pod? / Temperature). Enter your fridge temperature if you know it, or leave it empty for a typical one.
- **Demo mode** (⚙️ → Demo): a simulated pod with demo buttons, for presenting without hardware. It never runs while a real pod is connected.

**Spoilage forecast:** each item ages faster or slower than normal. Temperature follows the Q10 rule (about 3× faster per +10°C vs a typical 4°C fridge or 21°C pantry). Ripening gas above the pod's normal level speeds up fruit and veg only (up to 3×). Items show e.g. "⚡ 1 day sooner · warm".

## Flashing the real pod (step 2)
1. Open `firmware/eat_me_first_pod/eat_me_first_pod.ino` in the Arduino IDE.
2. Fill in `WIFI_SSID`, `WIFI_PASSWORD` (2.4 GHz WiFi), and `SERVER_URL` (your Render link + `/api/pod/reading`).
3. Optional but recommended: pick a secret, set it as `POD_KEY` in the sketch **and** in Render → Environment.
4. Upload. Serial Monitor (115200) shows each reading, and the LED blinks once per successful send. The app header switches to **pod live**.

The pod sends `{"seq", "tempC", "humidity", "gas"}` every 5 s to `POST /api/pod/reading`. Gas is sent as `null` for the first 3 minutes while the MQ-3 heater warms up.

```
firmware/   ESP32 sketch (step 1: read sensors)
server/     Node server: storage, alert logic, simulator, recipes, photo scan
public/     The phone web app (plain HTML/CSS/JS)
```
