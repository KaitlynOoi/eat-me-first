// Phone push notifications via ntfy.sh - no account needed.
// Install the ntfy app, subscribe to your NTFY_TOPIC, done.
export async function notify(title, message, { priority = 3, tags = "" } = {}) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  try {
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: "POST",
      body: message,
      headers: {
        // HTTP headers must be plain ASCII; emoji go in Tags, which ntfy renders as icons
        Title: title.replace(/[^\x20-\x7E]/g, ""),
        Priority: String(priority),
        Tags: tags,
      },
    });
    if (!res.ok) console.warn("ntfy failed:", res.status, await res.text());
  } catch (e) {
    console.warn("ntfy failed:", e.message);
  }
}
