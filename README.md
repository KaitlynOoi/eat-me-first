# 🥕 Eat Me First

A sensor pod for your fridge, freezer or pantry, plus a phone web app. It tracks your food, warns you before it goes off, and suggests recipes that use the soonest-expiring items.

**Everything is free by default.** No hardware yet? A built-in fake pod sends readings so the whole app works today.

| Part | How | Cost |
|---|---|---|
| Data storage | `data.json` on your laptop (Firebase free tier optional) | Free |
| Recipes | [TheMealDB](https://www.themealdb.com) public API | Free, no key |
| Phone alerts | [ntfy.sh](https://ntfy.sh) | Free, no account |
| Adding food | Barcode scan ([Open Food Facts](https://world.openfoodfacts.org)), quick-add, type anything | Free |
| Photo scan (optional) | Claude Haiku | Under 1 cent per photo |

## Features
- **Fridge tab:**
  - A weekly score: eaten vs tossed, % saved, ≈ $ saved, and which food you waste most.
  - A **Cook these today** card with a recipe for each item expiring within 2 days.
  - Food grouped into Eat today, Eat soon and Fresh.
  - Tap an item to edit its days left: Opened it, +1 day, Use today, or Remove if you added it by mistake.
- **✓ Ate it / Tossed:** each one counts toward your score, every action has **Undo**, and **Recently removed** has a Restore button for anything you got wrong.
- **Add tab:**
  - **Barcode scan** (free): point the phone camera at a pack, and the product name plus estimated shelf life come from Open Food Facts. If the camera doesn't work, use a photo of the barcode or type the number.
  - Add anything (name + days) and quick-add buttons.
  - AI photo scan appears only when an Anthropic key is set.
- **Recipes tab:** recipes ranked by how much soon-to-expire food they use. Chips show what you have and what you'd need to buy, and **🛒 Add to list** sends the missing items to your shopping list.
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

## Connecting the real pod later
The ESP32 can either:
- `POST http://<laptop-ip>:3000/api/pod/reading` with JSON `{"tempC": 3.4, "humidity": 70, "gas": 612}`, or
- write the same JSON to Firebase at `pod/latest` (include an increasing `seq` number).

Then pick **Off (use real pod)** in Demo controls.

```
firmware/   ESP32 sketch (step 1: read sensors)
server/     Node server: storage, alert logic, simulator, recipes, photo scan
public/     The phone web app (plain HTML/CSS/JS)
```
