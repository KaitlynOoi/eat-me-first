// Optional: identify groceries from a photo with Claude.
// Uses Haiku, the cheapest Claude model (well under a cent per photo).
// Without an API key the app still works - use the quick-add buttons.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-5-5";
let client = null;

export const claudeEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

export async function scanGroceries(dataUrl) {
  if (!claudeEnabled()) {
    throw Object.assign(new Error("Photo scan is off: add ANTHROPIC_API_KEY to .env (or use quick-add)"), { status: 503 });
  }
  const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(dataUrl || "");
  if (!match) throw Object.assign(new Error("Expected a base64 image"), { status: 400 });
  const [, mediaType, data] = match;

  client ??= new Anthropic();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    output_config: { effort: "low" },
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data } },
        {
          type: "text",
          text: `List every food item in this photo for a food-waste app, with how many days it stays good
from today in each storage place. Judge freshness from what you see (spotty bananas = less time).

Reply with ONLY this JSON:
{"items":[{"name":"Bananas","emoji":"🍌","life":{"fridge":5,"freezer":60,"pantry":3}}]}

life values are days (decimals ok, e.g. 0.25 for raw meat left out). Short common names.
Skip non-food. No food -> {"items":[]}.`,
        },
      ],
    }],
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined this photo");
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1) throw new Error("Could not read Claude's answer");
  return (JSON.parse(text.slice(start, end + 1)).items || []).filter((i) => i.name && i.life);
}
