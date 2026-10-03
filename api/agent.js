// One round of the agent loop. The browser runs the tools; this function only adds the
// Gemini API key (kept secret on the server) and forwards the request.
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ALLOWED_TOOLS = new Set([
  "check_stock", "check_seasonality", "check_payment_friction",
  "check_reach", "estimate_actions", "get_past_results",
]);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "GEMINI_API_KEY is not set" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "bad JSON" }); } }
  const { contents, functionDeclarations } = body || {};

  // Basic abuse limits: only this app's prompt and tools, bounded size and rounds.
  if (!Array.isArray(contents) || contents.length < 1 || contents.length > 24) return res.status(400).json({ error: "bad contents" });
  if (JSON.stringify(body).length > 120000) return res.status(413).json({ error: "too large" });
  if (!Array.isArray(functionDeclarations) || functionDeclarations.some(f => !ALLOWED_TOOLS.has(f?.name))) return res.status(400).json({ error: "bad tools" });
  const first = contents[0]?.parts?.[0]?.text || "";
  if (!first.startsWith("You are Revenue Sentinel")) return res.status(400).json({ error: "bad prompt" });

  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents,
        tools: [{ functionDeclarations }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
      }),
    });
    const j = await r.json();
    if (!r.ok) return res.status(r.status === 429 ? 429 : 502).json({ error: j?.error?.status || "upstream_error", message: j?.error?.message });
    const content = j?.candidates?.[0]?.content;
    if (!content) return res.status(502).json({ error: "empty_reply" });
    return res.status(200).json({ content, model: MODEL });
  } catch (e) {
    return res.status(502).json({ error: "upstream_error" });
  }
}
