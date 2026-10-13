# AI Build Log: Revenue Sentinel

**Razorpay x ISB AI PM Build Challenge · Track 2: Recover and Grow with AI · Manya Bhasin**

Live prototype: https://revenue-sentinel-five.vercel.app

Revenue Sentinel is an AI agent that spots a D2C brand's regular customers reordering later than usual. It checks why, recommends the smallest nudge likely to bring them back, and measures the result against a held-back group.

---

## 1. AI tools and models used

| Tool | Role |
|---|---|
| **Claude (Anthropic), in Cowork** | My main build partner. I used it to research Razorpay's AI products and global peers, generate and stress-test ideas, draft the product note, build the synthetic dataset, write all the code, set up deployment and debug, and fact-check the final documents. |
| **A second AI assistant** | An independent critique of my product note, to catch blind spots Claude might share with me. |
| **Google Gemini API (free tier), `gemini-3.5-flash-lite`** | The live agent inside the product. It calls tools, investigates and decides. |
| **Vercel** (hosting + serverless functions), **GitHub** (code), **Supabase** (agent memory) | Infrastructure, all on free tiers. |
| **Mobbin** (Shop app screens) | Visual reference for the redesign. Not an AI tool. |

I went through three Gemini models:

- `gemini-2.5-flash` was not available on my key.
- `gemini-3.8-flash` hit the free tier's 20-requests-per-day limit during testing.
- I settled on `gemini-3.5-flash-lite` for its higher free limits.

---

## 2. Key prompts, workflows and agent setup

### How I worked with Claude

1. **Research:** "Research what Razorpay is already doing with agentic AI, and what payment companies in other geographies are doing, keeping the Track 2 brief in mind."
2. **Ideate and stress-test:** "This needs to be different from what everyone else would choose." Then "Can you stress test this idea?" and "Does this really help increase revenue?" for each candidate.
3. **Build:** "Let's start building this. Remember, every time we stray from the assignment brief, you bring us back." I used this standing rule to keep scope tight.
4. **Redesign:** "We need to make the UI much, much simpler and accessible… it shouldn't feel like a banking app… very much like Shop's. It's not numbers-led at all."
5. **Verify:** "Go through this doc again. Absolutely everything needs to be bang on." Claude checked every number in the one-pager against the live app and the raw data.

### Agent architecture

```
Browser (app.js)                         Vercel /api/agent.js            Gemini
──────────────────                       ────────────────────            ──────
1. DETECT (plain code)
   each customer's recent gap vs own usual gap
   flag at ≥ 1.25×; product "changed" if median ≥ 1.12×
2. INVESTIGATE + DECIDE (agent loop, up to 10 rounds)
   send prompt + 6 tool declarations ───────► adds API key, checks ──────► function calls
   run the requested tool in the page ◄────── forwards reply ◄──────────── 
   return functionResponse … until final JSON
3. GUARDRAILS (plain code): override the AI on stockouts and seasonal
   dips, enforce the incentive cap, allow one "act" at most
4. MERCHANT APPROVES → simulated 14-day result vs 10% held-back group
5. LEARN: lift estimate moves halfway towards the measured result
   (saved to Supabase via /api/memory.js)
```

**The six tools the agent can call:** `check_stock`, `check_seasonality`, `check_payment_friction`, `check_reach`, `estimate_actions`, `get_past_results`.

**System prompt (core of it, verbatim):**

> You are Revenue Sentinel, an agent inside a payments company's merchant tools. You work for a D2C skincare merchant.
> Goal: protect repeat revenue. Recommend the SMALLEST action likely to win back slowing customers, and never spend money when the cause is something else (a stockout, a seasonal dip, weak evidence).
>
> How to work:
> 1. Call get_past_results once.
> 2. For every product with signal "changed", call check_stock and check_seasonality. Do not investigate "normal" products.
> 3. Only for a product that is in stock AND does not repeat every year, call check_payment_friction, check_reach and estimate_actions.
> 4. Decide per product: "act" (one product at most, the clearest case), "hold" (a cause other than customers drifting explains it), or "monitor" (normal or weak evidence).
> 5. For "act", pick the action with the highest extra_profit that is allowed by the merchant's limits. If two are within 10% of each other, pick the cheaper one. Use past results if any.
> Payment data cannot show why customers slowed (price, taste, competitors). Say so honestly.

The agent must reply in a fixed JSON format. For each product, it states:

- the decision
- what it knows
- what the checks found
- what it suspects
- what it doesn't know
- its confidence

**Safety in the setup:**

- The Gemini key stays on the server.
- The proxy only accepts this app's prompt and these six tool names.
- Requests are size-limited.
- If Gemini is busy or takes over 35 seconds, the app switches to rule-based backup decisions, so the demo never freezes.

---

## 3. AI output I rejected, corrected or significantly improved

### Main example: a wrong headline number in my one-pager

Claude drafted my one-pager with a headline stat: **"2 of 3 slowdowns were false alarms (stockout, season), so the agent held back."** It read well and matched the story I had been telling.

Before submitting, I asked for every number to be checked against the live app rather than earlier drafts. The check showed the claim was **wrong**:

- Only **two** products cross the alert line, serum and body lotion, both 29% slower.
- Sunscreen slowed only 9% during its stockout. That is below the threshold, so the agent never flags it.

**What I changed:** the stat now says two products slowed and only serum gets a nudge, because lotion's dip repeats every June to August. In the same pass I also:

- corrected "12 months of data" to the true range, Oct 2024 to Sep 2026
- replaced a rounded figure with the exact count, 6,656 customers
- removed three claims I could not prove

I also changed my demo script, which had been built around the same wrong sunscreen story.

**Why it matters:** the AI wrote a confident, plausible summary of the product rather than of the data. A judge clicking through the prototype would have seen the mismatch. My rule is that every number in a submission is traced back to the data or the code.

### Other things I overruled

- **Idea choice.** An early strong candidate was "discount leakage". I dropped it because it is a cost story, and the brief asks for revenue growth.
- **The first UI.** The AI's first version was a number-heavy dashboard with many tabs. When I tested it myself, it felt like a banking app. I directed a full redesign: picture-led, one decision at a time, plain language, rupees and weeks instead of ratios.

---

## 4. What AI did vs what I decided

| AI did | I decided or did |
|---|---|
| Researched Razorpay's products (Agent Studio, Engage, Magic Checkout and others) and global peers | Chose Track 2 and the problem: repeat revenue quietly slipping away |
| Generated about 8 ideas and stress-tested them | Rejected ideas that were cost stories or that classmates would pick |
| Wrote the data generator, agent loop, tools, guardrails, UI code and API functions | Set the product principles: restraint as a feature, smallest nudge first, always hold back a control group, the merchant approves |
| Suggested thresholds and the learning rule | Chose free tools only, and accepted rate limits in exchange for backup rules |
| Drafted the product note and one-pager | Set up GitHub, Vercel, Supabase and the Gemini key myself (the key was never shared in chat) |
| Debugged deployment problems (wrong folder paths, unavailable model, quota limits, slow responses) | Tested the UI and directed the redesign, using Shop as the reference |
| Fact-checked the documents against the data | Chose what to leave out: chatbot, dashboard, campaign builder, AI-written customer messages, autopilot |

---

## 5. Known limitations, risks and verification steps

### Limitations

- **Synthetic data.** The data is for a fictional brand (Dewleaf Skincare): 36,000 customers and 335,000+ orders, with planted patterns. The planted patterns are a serum slowdown from June 2026, a sunscreen stockout from 20 Aug to 6 Sep, a lotion dip every June to August, and expired cards for 7% of saved-card customers.
- **Simulated results.** Customer responses and the 14-day result are simulated. No real WhatsApp messages or payments are sent.
- **Repeat tracking.** Recognising the same customer across orders would rely on Razorpay Magic Checkout identity.
- **Gemini free tier.** It can be slow or rate-limited. When it is, the app says so and uses backup rules.
- **Payment data can't show why customers slowed** (price, taste, competitors). The agent is told to say so.

### Risks

- **Over-messaging customers.** Mitigated by a cap of one message per customer every 30 days, opted-in customers only, pre-approved templates and opt-out tracking.
- **The AI recommending spend when the cause is elsewhere.** Mitigated by guardrails in code that override the AI on stockouts and seasonal dips.
- **Overstated impact.** Mitigated by measuring every action against a held-back 10% of customers.
- **Prototype security.** The demo has no login, so anyone with the link can run it or reset its memory. The database only allows reading and adding rows.

### Verification steps

- Checked that the agent holds back on lotion (seasonal) and acts on serum, in both live-AI and backup-rule modes.
- Traced every number in the one-pager to the live app's detection output or the raw data. That check caught the error in section 3.
- Confirmed the live site loads without login, the agent completes a run within 35 seconds or falls back cleanly, and memory saves to Supabase.
- Kept API keys only in Vercel environment variables. None are in this repository.
