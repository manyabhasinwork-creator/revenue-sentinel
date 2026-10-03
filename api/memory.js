// The agent's memory: activity log, past campaigns, merchant feedback and learned estimates.
// Stored in Supabase through its REST API. Insert and read only; "reset" adds a marker row.
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_ANON_KEY;
const START_LIFTS = { reminder: 8, free_ship: 9, discount: 10 };
const ACTIONS = new Set(Object.keys(START_LIFTS));
const WHO = new Set(["ai", "code", "guard", "you", "sep"]);

const h = () => ({ apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" });
const clip = (s, n = 300) => String(s ?? "").slice(0, n);
async function sb(path, opts = {}) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { ...opts, headers: { ...h(), ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.status === 204 || opts.method === "POST" ? null : r.json();
}

export default async function handler(req, res) {
  if (!URL || !KEY) return res.status(500).json({ error: "Supabase is not configured" });
  try {
    if (req.method === "GET") {
      const reset = await sb("resets?select=created_at&order=created_at.desc&limit=1");
      const since = reset[0]?.created_at || "1970-01-01T00:00:00Z";
      const f = `created_at=gt.${encodeURIComponent(since)}`;
      const [campaigns, feedback, events] = await Promise.all([
        sb(`campaigns?select=*&${f}&order=created_at.asc&limit=50`),
        sb(`feedback?select=*&${f}&order=created_at.asc&limit=50`),
        sb(`events?select=*&${f}&order=created_at.desc&limit=60`),
      ]);
      const lifts = { ...START_LIFTS };
      for (const c of campaigns) if (ACTIONS.has(c.action)) lifts[c.action] = Math.round(((lifts[c.action] + Number(c.measured)) / 2) * 10) / 10;
      return res.status(200).json({
        lifts,
        history: campaigns.map(c => ({ product: c.product, action: c.action, expected: Number(c.expected), lift: Number(c.measured), extra_revenue: c.extra_revenue })),
        feedback: feedback.map(x => ({ product: x.product, action: x.action, merchant_said: x.merchant_said })),
        events: events.reverse().map(e => ({ t: new Date(e.created_at).toISOString().slice(11, 19), who: e.who, text: e.text, res: e.res })),
      });
    }
    if (req.method === "POST") {
      let b = req.body; if (typeof b === "string") b = JSON.parse(b);
      const { type, row, rows } = b || {};
      if (type === "events") {
        const clean = (Array.isArray(rows) ? rows : []).slice(0, 40).filter(r => WHO.has(r.who)).map(r => ({ who: r.who, text: clip(r.text), res: clip(r.res) }));
        if (clean.length) await sb("events", { method: "POST", body: JSON.stringify(clean), headers: { Prefer: "return=minimal" } });
      } else if (type === "campaign") {
        if (!ACTIONS.has(row?.action)) return res.status(400).json({ error: "bad action" });
        await sb("campaigns", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({
          product: clip(row.product, 80), action: row.action, expected: Number(row.expected) || 0, measured: Number(row.measured) || 0,
          extra_revenue: Math.round(Number(row.extra_revenue) || 0), messaged: Math.round(Number(row.messaged) || 0), control: Math.round(Number(row.control) || 0) }) });
      } else if (type === "feedback") {
        await sb("feedback", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ product: clip(row?.product, 80), action: clip(row?.action, 20), merchant_said: clip(row?.merchant_said, 120) }) });
      } else if (type === "reset") {
        await sb("resets", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({}) });
      } else return res.status(400).json({ error: "unknown type" });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: "GET or POST" });
  } catch (e) {
    return res.status(502).json({ error: "memory_unavailable" });
  }
}
