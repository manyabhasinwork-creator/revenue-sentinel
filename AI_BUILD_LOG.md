# AI Build Log: Revenue Sentinel

**Razorpay x ISB AI PM Build Challenge · Track 2: Recover and Grow with AI · Manya Bhasin**

Live prototype: https://revenue-sentinel-five.vercel.app

## 1. AI tools and models used

- **Claude (Anthropic):** research, ideation, drafting, coding and debugging
- **Google Gemini API (free tier):** powers the live agent in the prototype
- **Vercel, GitHub, Supabase:** hosting, code and agent memory (free tiers)

## 2. Key prompts, workflows and agent setup

**Workflow:**

1. **Research:** mapped Razorpay's existing AI products and global peers against the Track 2 brief to find a gap.
2. **Ideate and test:** explored several directions and tested each on whether it grows merchant revenue and is feasible for Razorpay.
3. **Build:** built the prototype step by step, checking scope against the brief.
4. **Redesign:** simplified the interface for a busy, non-technical merchant.
5. **Verify:** checked every number in the submission against the prototype's data.

**Agent setup:**

- Simple code first spots repeat customers buying later than usual.
- An AI agent then investigates using tools: stock, seasonality, payment issues, reach and past results.
- It recommends the smallest suitable action, or no action.
- Code guardrails check every recommendation against the merchant's rules.
- The merchant approves, results are measured against a held-back group, and the agent learns from the outcome.

## 3. AI output I corrected

An AI-drafted version of my one-pager included a summary statistic that did not match the prototype's actual data. I traced every figure back to the data, corrected the statistic and removed claims I could not support. Since then, I treat every AI-generated number as unverified until checked.

I also redirected the first interface, which was too data-heavy, towards a simpler, one-decision-at-a-time design.

## 4. What AI did vs what I decided

- **AI:** research support, idea generation, code, drafting and debugging.
- **Me:** the choice of problem and user, the product principles (restraint, smallest nudge first, merchant approval, measured results), scope and what to leave out, design direction, set-up of all accounts, and final review of every claim.

## 5. Known limitations, risks and verification

- **Limitations:** the prototype uses sample data for a fictional brand, and customer responses are simulated. A real version would need merchant validation and Razorpay data access.
- **Risks:** over-messaging customers and overstating impact. These are mitigated by merchant approval, frequency limits, opted-in customers only, guardrails and a held-back comparison group.
- **Verification:** I tested the full flow on the live prototype, checked figures against the data, and kept no API keys or credentials in the repository.
