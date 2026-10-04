let A, P, C, NC;
const pname = code => P.find(p => p.code === code).name;
const pidx = code => P.findIndex(p => p.code === code);
const $ = id => document.getElementById(id);
const fmt = n => Math.round(n).toLocaleString("en-IN");
function inr(n){ n=Math.round(n); if(n>=1e7) return "₹"+(n/1e7).toFixed(1)+" Cr"; if(n>=1e5) return "₹"+(n/1e5).toFixed(1)+"L"; if(n>=1e3) return "₹"+(n/1e3).toFixed(1)+"K"; return "₹"+n; }
function esc(s){ return String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
function now(){ const d=new Date(); return d.toTimeString().slice(0,8); }

/* ---------------- state ---------------- */
const BASE_RATE = 0.12;                                             // assumed no-message 14-day reorder rate
const TRUE_LIFT = {reminder:7.4, free_ship:8.3, discount:9.6};      // hidden "real world" used only to simulate outcomes
const ACTIONS = [
  {id:"reminder", label:"Reorder reminder with one-tap UPI link", incentivePct:0, perOrder:()=>0},
  {id:"free_ship", label:"Reminder + free shipping", incentivePct:0, perOrder:()=>A.merchant.shipping_cost},
  {id:"discount", label:"Reminder + 10% off", incentivePct:10, perOrder:aov=>aov*0.10},
];
const S = {
  step:"run", paused:false, running:false, ctl:null, elapsed:0, timer:null,
  scan:null, decisions:null, mode:null, log:[], runCount:0,
  limits:{maxInc:8, freq:30, ctrl:10}, lifts:{reminder:8, free_ship:9, discount:10},
  history:[], feedback:[], choice:null, template:"t1", approved:null, rejected:null,
  result:null, sheet:0, autonomy:2, autoOk:{}, open:null, sampleOk:null,
};
/* ---------------- memory (Supabase, through /api/memory) ---------------- */
let pending=[], flushT=null;
function remember(row){ pending.push(row); clearTimeout(flushT); flushT=setTimeout(flush, 800); }
async function flush(){ if(!pending.length) return; const rows=pending.splice(0); try { await fetch("/api/memory",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:"events",rows})}); } catch(e){} }
async function post(type,row){ try { await fetch("/api/memory",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type,row})}); } catch(e){} }
async function loadMemory(){
  try {
    const r=await fetch("/api/memory"); if(!r.ok) throw 0; const m=await r.json();
    S.lifts=m.lifts; S.history=m.history; S.feedback=m.feedback; S.memoryOk=true;
    if (m.events.length){ S.log.push({t:"", who:"sep", text:"Earlier runs (saved in Supabase)"}); m.events.forEach(e=>S.log.push({t:e.t, who:e.who, text:e.text, res:e.res, state:"done"})); S.log.push({t:"", who:"sep", text:"This visit"}); }
  } catch(e){ S.memoryOk=false; }
}

function addLog(who, text, res, state){ const e={t:now(), who, text, res:res||"", state:state||"done"}; S.log.push(e); renderLog(); if(e.state==="done") remember({who,text,res:e.res}); else e.save=true; return e; }
function finish(e,res){ e.state="done"; e.res=res; renderLog(); if(e.save) remember({who:e.who,text:e.text,res}); }

/* ---------------- 1. DETECT (plain code, no AI) ---------------- */
function detect(){
  const out = P.map(p => ({code:p.code, name:p.name, ratios:[], base:0, rec:0, n:0, flagged:0, atRisk:0, reach:0, friction:0, notOpted:0, aovSum:0}));
  for (let i=0;i<NC;i++){
    const o = out[C.p[i]]; const b=C.b[i], r=C.r[i], a=C.a[i];
    const ratio = r/b; o.ratios.push(ratio); o.base+=b; o.rec+=r; o.n++;
    if (ratio >= 1.25){
      o.flagged++; o.atRisk += a*(60/b - 60/r); o.aovSum += a;
      if (C.c[i]) o.friction++; else if (C.w[i]) o.reach++; else o.notOpted++;
    }
  }
  return out.map(o => {
    const s=[...o.ratios].sort((x,y)=>x-y); const med=s[Math.floor(s.length/2)];
    return {code:o.code, name:o.name, repeat_customers:o.n, usual_days:Math.round(o.base/o.n), now_days:Math.round(o.rec/o.n),
      median_change_pct:Math.round((med-1)*100), customers_slowing:o.flagged, revenue_at_risk_60d:Math.round(o.atRisk/1000)*1000,
      reachable:o.reach, expired_card:o.friction, not_opted_in:o.notOpted, avg_order_value:Math.round(o.aovSum/Math.max(1,o.flagged)),
      signal: med >= 1.12 ? "changed" : "normal"};
  });
}

/* ---------------- tools the agent can call (run here, in the page) ---------------- */
function series(code, from, to){ return Object.entries(A.monthly_gap[code]).filter(([m])=>m>=from && m<=to).map(([,v])=>v); }
const avg = a => a.reduce((x,y)=>x+y,0)/Math.max(1,a.length);
function toolStock(code){
  const hits = A.stock_calendar.filter(s => s.product_code===code && s.to >= "2026-06-01");
  return {product:pname(code), in_stock_whole_period: hits.length===0,
          stockouts: hits.map(h => ({from:h.from, to:h.to, days: Math.round((new Date(h.to)-new Date(h.from))/864e5)+1}))};
}
function toolSeason(code){
  const summer = avg(series(code,"2025-06","2025-08")), rest = avg(series(code,"2024-11","2025-05"));
  const pct = Math.round((summer/rest-1)*100);
  return {product:pname(code), same_months_last_year_slower_by_pct:pct, repeats_every_year: pct >= 15};
}
function toolPayment(code){ const s=S.scan.find(x=>x.code===code); return {product:pname(code), customers_slowing:s.customers_slowing, expired_saved_card_and_recent_failed_payment:s.expired_card}; }
function toolReach(code){ const s=S.scan.find(x=>x.code===code); return {product:pname(code), can_message_on_whatsapp:s.reachable, not_opted_in:s.not_opted_in}; }
function estimate(code){
  const s=S.scan.find(x=>x.code===code); const N=s.reachable, aov=s.avg_order_value;
  return ACTIONS.map(a => {
    const lift=S.lifts[a.id]; const conv=BASE_RATE+lift/100;
    const extraRev=N*lift/100*aov; const cost=N*A.merchant.whatsapp_cost + N*conv*a.perOrder(aov);
    const profit=extraRev*A.merchant.gross_margin - cost;
    return {action:a.id, label:a.label, expected_lift_pts:lift, extra_revenue:Math.round(extraRev/1000)*1000,
            cost:Math.round(cost/100)*100, extra_profit:Math.round(profit/1000)*1000,
            allowed_by_merchant_limits: a.incentivePct <= S.limits.maxInc,
            note: a.incentivePct > S.limits.maxInc ? `incentive ${a.incentivePct}% is above the merchant's ${S.limits.maxInc}% cap` : ""};
  });
}
function toolPast(){ return {past_campaigns:S.history.map(h=>({product:h.product, action:h.action, expected_lift_pts:h.expected, measured_lift_pts:h.lift, extra_revenue:h.extra_revenue})),
                             merchant_feedback:S.feedback}; }

const TOOLS = [
  {name:"check_stock", description:"Checks the merchant's connected store for stockouts of a product since 1 Jun 2026. Returns in_stock_whole_period and any stockout dates.", inputSchema:{type:"object",properties:{product_code:{type:"string"}},required:["product_code"]},
   execute:i=>run("check_stock", i, ()=>toolStock(String(i.product_code)), r=> r.in_stock_whole_period ? "In stock the whole period" : `Out of stock ${r.stockouts.map(s=>s.from.slice(5)+" to "+s.to.slice(5)+" ("+s.days+" days)").join(", ")}`)},
  {name:"check_seasonality", description:"Compares the same June-August months last year with the rest of last year for a product. Returns how much slower buyers were and whether the dip repeats every year.", inputSchema:{type:"object",properties:{product_code:{type:"string"}},required:["product_code"]},
   execute:i=>run("check_seasonality", i, ()=>toolSeason(String(i.product_code)), r=> r.repeats_every_year ? `Same dip last year (${r.same_months_last_year_slower_by_pct}% slower)` : `No dip last year (${r.same_months_last_year_slower_by_pct}%)`)},
  {name:"check_payment_friction", description:"Counts slowing customers whose saved card expired and whose recent payment failed. These need a card update link, not a reminder.", inputSchema:{type:"object",properties:{product_code:{type:"string"}},required:["product_code"]},
   execute:i=>run("check_payment_friction", i, ()=>toolPayment(String(i.product_code)), r=>`${fmt(r.expired_saved_card_and_recent_failed_payment)} with an expired card`)},
  {name:"check_reach", description:"Counts slowing customers who opted in to WhatsApp messages (the only ones who may be contacted).", inputSchema:{type:"object",properties:{product_code:{type:"string"}},required:["product_code"]},
   execute:i=>run("check_reach", i, ()=>toolReach(String(i.product_code)), r=>`${fmt(r.can_message_on_whatsapp)} can be messaged, ${fmt(r.not_opted_in)} not opted in`)},
  {name:"estimate_actions", description:"Expected extra revenue, cost and extra profit for each possible action on a product's reachable slowing customers, using what past campaigns taught. Also says if an action breaks the merchant's limits.", inputSchema:{type:"object",properties:{product_code:{type:"string"}},required:["product_code"]},
   execute:i=>run("estimate_actions", i, ()=>estimate(String(i.product_code)), r=>r.map(o=>`${o.action}: ${inr(o.extra_profit)} profit${o.allowed_by_merchant_limits?"":" (over limit)"}`).join(" · "))},
  {name:"get_past_results", description:"Returns results of past campaigns run by this agent and any feedback the merchant gave. Use it before recommending an action.",
   execute:i=>run("get_past_results", i, ()=>toolPast(), r=> r.past_campaigns.length||r.merchant_feedback.length ? `${r.past_campaigns.length} past campaign(s), ${r.merchant_feedback.length} feedback note(s)` : "No past campaigns yet")},
];
const TOOL_LABEL = {check_stock:"Checking stock", check_seasonality:"Checking last year", check_payment_friction:"Checking payment problems", check_reach:"Checking who can be messaged", estimate_actions:"Estimating actions", get_past_results:"Reading past results"};
function run(name, input, fn, summary){
  const code = input && input.product_code ? String(input.product_code) : "";
  if (code && pidx(code) < 0) throw new Error("Unknown product_code " + code);
  const e = addLog("ai", `${TOOL_LABEL[name]}${code?" for "+pname(code):""}`, "", "busy");
  const res = fn(); finish(e, summary(res)); return res;
}

/* ---------------- 2. INVESTIGATE + DECIDE (Claude) ---------------- */
function prompt(){
  return `You are Revenue Sentinel, an agent inside a payments company's merchant tools. You work for a D2C skincare merchant.
Goal: protect repeat revenue. Recommend the SMALLEST action likely to win back slowing customers, and never spend money when the cause is something else (a stockout, a seasonal dip, weak evidence).

Plain code has already scanned ${fmt(NC)} repeat customers. Each customer's buying rhythm (usual days between orders) is compared with their recent rhythm since 1 Jun 2026. Today is 1 Oct 2026.
Detection results (JSON):
${JSON.stringify(S.scan.map(({code,name,repeat_customers,usual_days,now_days,median_change_pct,customers_slowing,revenue_at_risk_60d,signal})=>({code,name,repeat_customers,usual_days,now_days,median_change_pct,customers_slowing,revenue_at_risk_60d,signal})))}

Merchant limits: max incentive ${S.limits.maxInc}% of order value; at most one message per customer every ${S.limits.freq} days; ${S.limits.ctrl}% of targeted customers are held back as a comparison group.

How to work:
1. Call get_past_results once.
2. For every product with signal "changed", call check_stock and check_seasonality. Do not investigate "normal" products.
3. Only for a product that is in stock AND does not repeat every year, call check_payment_friction, check_reach and estimate_actions.
4. Decide per product: "act" (one product at most, the clearest case), "hold" (a cause other than customers drifting explains it), or "monitor" (normal or weak evidence).
5. For "act", pick the action with the highest extra_profit that is allowed by the merchant's limits. If two are within 10% of each other, pick the cheaper one. Use past results if any.
Payment data cannot show why customers slowed (price, taste, competitors). Say so honestly.

Reply with only this JSON (no other text). One entry per product, all 4 products:
{"decisions":[{"product_code":"SER","decision":"act|hold|monitor","reason":"slowdown|stockout|seasonal|normal","headline":"one plain sentence a busy founder understands, max 14 words","know":"what the data shows, one sentence with a number","found":"what the checks found, one sentence","suspect":"your best guess, one sentence, hedged","dont_know":"what the data cannot tell, one sentence","confidence":"high|medium|low","action":"reminder|free_ship|discount|none","why":"one or two sentences on why this action, or why no action"}]}`;
}

function offlineDecide(){
  return {decisions: S.scan.map(s => {
    if (s.signal==="normal") return {product_code:s.code, decision:"monitor", reason:"normal", headline:`${s.name}: normal ups and downs`, know:`Median change is ${s.median_change_pct}%.`, found:"Within normal range.", suspect:"Nothing unusual.", dont_know:"-", confidence:"high", action:"none", why:"No action needed."};
    const st=toolStock(s.code), se=toolSeason(s.code);
    if (!st.in_stock_whole_period) return {product_code:s.code, decision:"hold", reason:"stockout", headline:`${s.name} slowed because it was out of stock`, know:`Buyers are ${s.median_change_pct}% slower.`, found:`Out of stock ${st.stockouts[0].from} to ${st.stockouts[0].to}.`, suspect:"Customers couldn't buy, rather than left.", dont_know:"Whether all will return after restock.", confidence:"high", action:"none", why:"Restock first. Messages would waste money."};
    if (se.repeats_every_year) return {product_code:s.code, decision:"hold", reason:"seasonal", headline:`${s.name} buyers slow down every June to August`, know:`Buyers are ${s.median_change_pct}% slower.`, found:`Last year the same months were ${se.same_months_last_year_slower_by_pct}% slower.`, suspect:"A seasonal dip that recovers.", dont_know:"Whether this year's dip is larger.", confidence:"medium", action:"none", why:"Seasonal dip, no spend."};
    const best = estimate(s.code).filter(o=>o.allowed_by_merchant_limits).sort((a,b)=>b.extra_profit-a.extra_profit)[0];
    return {product_code:s.code, decision:"act", reason:"slowdown", headline:`${s.name} regulars are taking ${s.median_change_pct}% longer to reorder`, know:`${fmt(s.customers_slowing)} regulars slowed from ${s.usual_days} to ${s.now_days} days.`, found:"In stock, and no dip last year.", suspect:"Customers are drifting, not leaving.", dont_know:"Why. Payment data can't show price or competitors.", confidence:"high", action:best.action, why:"Highest extra profit within your limits."};
  })};
}

/* guardrails: code checks every AI decision before the merchant sees it */
function guard(raw){
  const notes=[]; const valid = new Set(P.map(p=>p.code));
  let ds = Array.isArray(raw?.decisions) ? raw.decisions.filter(d => valid.has(String(d.product_code))) : [];
  for (const s of S.scan) if (!ds.find(d=>d.product_code===s.code)) ds.push({product_code:s.code, decision:"monitor", reason:"normal", headline:`${s.name}: not reviewed`, know:"", found:"", suspect:"", dont_know:"", confidence:"low", action:"none", why:"The agent did not return a decision, so nothing happens."});
  let acts=0;
  ds = ds.map(d => {
    d = {...d, guard:[]};
    if (d.decision==="act"){
      const st=toolStock(d.product_code), se=toolSeason(d.product_code), sc=S.scan.find(x=>x.code===d.product_code);
      if (!st.in_stock_whole_period){ d.decision="hold"; d.reason="stockout"; d.action="none"; d.guard.push("Blocked: product had a stockout, so no customer spend."); }
      else if (se.repeats_every_year){ d.decision="hold"; d.reason="seasonal"; d.action="none"; d.guard.push("Blocked: the same dip happened last year."); }
      else if (sc.signal==="normal"){ d.decision="monitor"; d.action="none"; d.guard.push("Blocked: change is within normal range."); }
      else if (++acts>1){ d.decision="monitor"; d.action="none"; d.guard.push("Held: one action at a time."); }
    }
    if (d.decision==="act"){
      const opts=estimate(d.product_code); const pick=opts.find(o=>o.action===d.action);
      if (!pick || !pick.allowed_by_merchant_limits){
        const best=opts.filter(o=>o.allowed_by_merchant_limits).sort((a,b)=>b.extra_profit-a.extra_profit)[0];
        d.guard.push(`Changed: "${d.action}" ${pick?"breaks your incentive limit":"isn't an allowed action"}, so it was swapped for "${best.action}".`);
        d.action=best.action;
      }
    } else d.action="none";
    d.guard.forEach(g => addLog("guard", g, pname(d.product_code)));
    notes.push(...d.guard);
    return d;
  });
  return ds;
}

/* Gemini function-calling loop: the server only adds the API key; tools run here in the page */
function parseJSON(t){ try { return JSON.parse(t); } catch(e){} const f=t.match(/```(?:json)?\s*([\s\S]*?)```/); if(f){ try { return JSON.parse(f[1]); } catch(e){} } const a=t.indexOf("{"), b=t.lastIndexOf("}"); if(a>-1&&b>a) return JSON.parse(t.slice(a,b+1)); throw new Error("no JSON in reply"); }
async function callAgent(text, signal){
  const decls=TOOLS.map(t=>t.inputSchema?{name:t.name,description:t.description,parameters:t.inputSchema}:{name:t.name,description:t.description});
  const contents=[{role:"user",parts:[{text}]}];
  for (let round=0; round<10; round++){
    const r=await fetch("/api/agent",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({contents,functionDeclarations:decls}),signal});
    const j=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(j.error||("HTTP "+r.status));
    const content=j.content; if(!content||!content.parts) throw new Error("empty reply");
    contents.push(content);
    const calls=content.parts.filter(p=>p.functionCall);
    if(!calls.length){ return parseJSON(content.parts.map(p=>p.text||"").join("")); }
    const responses=[];
    for (const c of calls){
      const tool=TOOLS.find(t=>t.name===c.functionCall.name); let out;
      try { out = tool ? tool.execute(c.functionCall.args||{}) : {error:"unknown tool"}; } catch(err){ out={error:String(err.message||err)}; }
      responses.push({functionResponse:{name:c.functionCall.name,response:{result:out}}});
    }
    contents.push({role:"user",parts:responses});
  }
  throw new Error("too many rounds");
}

async function runSentinel(useOffline){
  if (S.paused || S.running) return;
  S.running=true; S.mode=null; S.decisions=null; S.approved=null; S.rejected=null; S.result=null; S.sheet=0; S.runCount++;
  S.log.push({t:now(), who:"sep", text:`Run ${S.runCount}`});
  render();
  const t0=performance.now(); S.scan=detect();
  const changed=S.scan.filter(s=>s.signal==="changed").length;
  addLog("code", `Scanned ${fmt(NC)} repeat customers across ${P.length} products`, `${changed} products changed rhythm · ${Math.round(performance.now()-t0)} ms`);
  render();
  let raw=null;
  if (!useOffline){
    S.mode="live"; const busy=addLog("ai","Gemini is investigating and deciding","", "busy");
    S.ctl=new AbortController(); S.elapsed=0; clearInterval(S.timer); S.timer=setInterval(()=>{S.elapsed++; const el=$("elapsed"); if(el) el.textContent=S.elapsed+"s";},1000);
    try { raw = await callAgent(prompt(), S.ctl.signal); finish(busy,"Decided"); }
    catch(e){
      if (e.name==="AbortError"){ finish(busy,"Stopped"); clearInterval(S.timer); S.running=false; render(); return; }
      finish(busy, `Couldn't reach the AI (${e.message}). Using offline rules instead.`); raw=null;
    }
    clearInterval(S.timer);
  }
  if (!raw){ S.mode = S.mode==="live" ? "fallback" : "offline"; raw=offlineDecide(); addLog("code","Offline rules decided (no AI)", ""); }
  S.decisions = guard(raw);
  const act=S.decisions.find(d=>d.decision==="act");
  S.choice = act ? act.action : null;
  addLog("code", `Guardrail check done`, `${S.decisions.filter(d=>d.guard.length).length ? S.decisions.reduce((n,d)=>n+d.guard.length,0)+" change(s) made" : "all decisions within your rules"}`);
  if (act && S.autonomy===3 && S.autoOk[act.product_code+":"+act.action]){
    approve(true);
  }
  S.running=false; render();
}

/* ---------------- 4. ACT ---------------- */
function plan(){ const act=S.decisions?.find(d=>d.decision==="act"); if(!act) return null; const s=S.scan.find(x=>x.code===act.product_code); const nCtrl=Math.round(s.reachable*S.limits.ctrl/100); return {act, s, nCtrl, nSend:s.reachable-nCtrl}; }
function approve(auto){
  const p=plan(); if(!p) return;
  S.approved={at:now(), action:S.choice, auto:!!auto}; S.rejected=null;
  addLog(auto?"code":"you", auto?`Auto-approved (pre-approved by you): ${labelOf(S.choice)}`:`Approved: ${labelOf(S.choice)}`, `${fmt(p.nSend)} messaged · ${fmt(p.nCtrl)} held back`);
  addLog("code", `Sent ${fmt(p.nSend)} WhatsApp messages via Engage with one-tap UPI reorder links`, "template "+(S.template==="t1"?"Running low":"Routine is due"));
  if (p.s.expired_card) addLog("code", `Sent ${fmt(p.s.expired_card)} card update links instead of reminders`, "expired saved cards");
}
function labelOf(id){ return ACTIONS.find(a=>a.id===id)?.label || id; }

/* ---------------- 5. MEASURE + LEARN ---------------- */
function rng(seed){ return () => { seed|=0; seed=seed+0x6D2B79F5|0; let t=Math.imul(seed^seed>>>15,1|seed); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
function fastForward(){
  const p=plan(); if(!p||!S.approved) return;
  const r=rng(1234+S.runCount*97); const tl=TRUE_LIFT[S.approved.action]/100;
  let bt=0, bc=0; for(let i=0;i<p.nSend;i++) if(r()<BASE_RATE+tl) bt++; for(let i=0;i<p.nCtrl;i++) if(r()<BASE_RATE) bc++;
  const rt=bt/p.nSend, rc=bc/p.nCtrl, lift=(rt-rc)*100; const extra=Math.max(0,(rt-rc)*p.nSend);
  const a=ACTIONS.find(x=>x.id===S.approved.action);
  const cost=p.nSend*A.merchant.whatsapp_cost + bt*a.perOrder(p.s.avg_order_value);
  const expected=S.lifts[a.id]; const updated=Math.round(((expected+lift)/2)*10)/10;
  S.result={rt:rt*100, rc:rc*100, lift, extra_orders:Math.round(extra), extra_revenue:Math.round(extra*p.s.avg_order_value), cost:Math.round(cost), expected, updated, nSend:p.nSend, nCtrl:p.nCtrl, action:a.id, product:p.act.product_code};
  S.history.push({product:pname(p.act.product_code), action:a.id, expected, lift:Math.round(lift*10)/10, extra_revenue:S.result.extra_revenue});
  S.lifts[a.id]=updated;
  post("campaign",{product:pname(p.act.product_code), action:a.id, expected, measured:Math.round(lift*10)/10, extra_revenue:S.result.extra_revenue, messaged:p.nSend, control:p.nCtrl});
  addLog("code", `14 days later: messaged ${S.result.rt.toFixed(1)}% vs no message ${S.result.rc.toFixed(1)}% reordered`, `+${lift.toFixed(1)} pts · ${inr(S.result.extra_revenue)} extra revenue`);
  addLog("code", `Learned: ${a.id} estimate updated from +${expected} to +${updated} pts`, "used in the next run");
}


/* =====================================================================
   SIMPLE UI  (merchant-first, picture-led, one thing at a time)
   ===================================================================== */
const TMPL={t1:n=>`Hi {first_name}, it's been a while since your last <b>${n}</b>. Running low?\nReorder in one tap: <b>{reorder_link}</b>`, t2:n=>`Hi {first_name}, your <b>${n}</b> routine is due. We saved your last order.\nPay with UPI in one tap: <b>{reorder_link}</b>`};
S.view = "home"; S.sheetOpen = null; S.runStart = 0;

const SHORT = {SER:"Vitamin C Serum", SUN:"Sunscreen", LOT:"Body Lotion", CLN:"Cleanser"};
const TINT  = {SER:"#FCE7D6", SUN:"#FFF1C2", LOT:"#E6E3FA", CLN:"#DDF2E6"};
const NAMES = ["Priya","Ananya","Riya","Sneha","Kavya","Aditi","Meera","Isha","Neha","Tanvi","Rohan","Arjun","Zoya","Nikhil"];
const AV    = ["#F6C9A8","#C9E4D3","#D6D0F7","#FBE3A1","#F7C6D0","#BFDDF3"];

/* plain-language helpers */
function money(n){ n=Math.round(n); if(n>=1e7) return "₹"+trim(n/1e7)+" crore"; if(n>=1e5) return "₹"+trim(n/1e5)+" lakh"; return "₹"+n.toLocaleString("en-IN"); }
function trim(x){ return (Math.round(x*10)/10).toString().replace(/\.0$/,""); }
function weeks(d){ const w=Math.max(1,Math.round(d/7)); return w===1?"a week":w+" weeks"; }
function oneIn(pct){ return pct>0 ? "about 1 in "+Math.max(2,Math.round(100/pct)) : "almost nobody"; }
function people(n){ return Math.round(n).toLocaleString("en-IN"); }

/* product pictures, drawn in code so there are no image files */
function art(code, size){
  const s=size||120;
  const shapes = {
    SER:`<rect x="44" y="40" width="32" height="56" rx="7" fill="#E39A5B"/><rect x="48" y="44" width="24" height="20" rx="3" fill="#F6D4B4"/><rect x="52" y="24" width="16" height="18" rx="3" fill="#2B2B2B"/><rect x="55" y="12" width="10" height="14" rx="5" fill="#2B2B2B"/><text x="60" y="58" font-size="8" text-anchor="middle" fill="#8A4A1C" font-weight="700">C</text>`,
    SUN:`<path d="M40 30h40l-4 70H44z" fill="#F4C24A"/><rect x="50" y="18" width="20" height="14" rx="3" fill="#2B2B2B"/><rect x="46" y="50" width="28" height="22" rx="4" fill="#FFF6D6"/><circle cx="60" cy="61" r="6" fill="#F4A21E"/>`,
    LOT:`<rect x="40" y="44" width="40" height="58" rx="10" fill="#8C84E0"/><rect x="47" y="58" width="26" height="24" rx="4" fill="#ECEAFD"/><rect x="55" y="30" width="10" height="16" fill="#2B2B2B"/><rect x="55" y="24" width="24" height="7" rx="3" fill="#2B2B2B"/>`,
    CLN:`<rect x="42" y="36" width="36" height="66" rx="12" fill="#5FB98A"/><rect x="48" y="54" width="24" height="26" rx="4" fill="#E6F6EC"/><rect x="52" y="22" width="16" height="16" rx="4" fill="#2B2B2B"/>`,
  };
  return `<svg viewBox="0 0 120 120" width="${s}" height="${s}" aria-hidden="true"><ellipse cx="60" cy="106" rx="26" ry="5" fill="rgba(0,0,0,.08)"/>${shapes[code]}</svg>`;
}
function tile(code, size, extra){ return `<div class="ptile ${extra||""}" style="--tint:${TINT[code]}">${art(code,size)}</div>`; }

/* who is slipping away: a few real flagged customers from the sample data */
function slipping(code, n){
  const k=pidx(code), out=[];
  for (let i=0;i<NC && out.length<n;i++){
    if (C.p[i]!==k || C.r[i]/C.b[i]<1.3 || !C.w[i] || C.c[i]) continue;
    out.push({name:NAMES[out.length%NAMES.length], usual:C.b[i], now:C.r[i], color:AV[out.length%AV.length]});
  }
  return out;
}
function avatar(p, sz){ return `<span class="av" style="background:${p.color};width:${sz}px;height:${sz}px">${p.name[0]}</span>`; }

/* friendly checklist of what the agent is doing */
function friendly(e){
  const prod = Object.keys(SHORT).find(c=>e.text.includes(pname(c)));
  const p = prod ? SHORT[prod] : "";
  if (e.text.startsWith("Scanned")) return `Looked at ${people(NC)} regular customers`;
  if (e.text.startsWith("Reading past")) return "Remembered what worked before";
  if (e.text.startsWith("Checking stock")) return `Checked ${p} was in stock`;
  if (e.text.startsWith("Checking last year")) return `Compared ${p} with last year`;
  if (e.text.startsWith("Checking payment")) return `Looked for card problems`;
  if (e.text.startsWith("Checking who")) return `Checked who's okay to message`;
  if (e.text.startsWith("Estimating")) return `Worked out the best nudge`;
  if (e.text.startsWith("Gemini is")) return e.state==="busy" ? "Thinking it through…" : (e.res.startsWith("Couldn't") ? "AI was busy, used backup rules" : "Decided what to do");
  if (e.text.startsWith("Guardrail")) return "Made sure it follows your rules";
  if (e.who==="guard") return "Your rules changed one decision";
  return null;
}
function checklist(){
  const items = S.log.slice(S.runStart).filter(e=>e.who!=="sep").map(e=>({t:friendly(e), busy:e.state==="busy"})).filter(x=>x.t);
  items.sort((a,b)=>(a.busy?1:0)-(b.busy?1:0));
  const seen=new Set(); const uniq=items.filter(x=>{ if(seen.has(x.t)) return false; seen.add(x.t); return true; });
  return `<ul class="checks" aria-live="polite">${uniq.map(x=>`<li class="${x.busy?"busy":""}"><span class="tick">${x.busy?'<span class="spin"></span>':"✓"}</span>${esc(x.t)}</li>`).join("")}</ul>`;
}
function renderLog(){ const el=$("checklist"); if(el) el.innerHTML=checklist(); const al=$("activity"); if(al) al.innerHTML=activityList(); }

/* ---------------- views ---------------- */
function greeting(){ const h=new Date().getHours(); return h<12?"Good morning":h<17?"Good afternoon":"Good evening"; }
const ACT_COPY = {
  reminder:{title:"Send a friendly reminder", sub:"A WhatsApp nudge with a one-tap reorder link. No discount needed."},
  free_ship:{title:"Remind them, with free delivery", sub:"A WhatsApp nudge plus free delivery on the reorder."},
  discount:{title:"Remind them, with 10% off", sub:"A WhatsApp nudge plus a 10% discount on the reorder."},
};

function vHome(){
  const p = plan();
  let hero;
  if (S.running){
    hero = `<section class="hero"><div class="hero-text"><span class="eyebrow">Sentinel is checking</span><h2>Looking at how your regulars are doing</h2><div id="checklist">${checklist()}</div>
      <button class="btn ghost-light" id="stop" type="button">Stop</button></div>
      <div class="hero-art">${["SER","SUN","LOT","CLN"].map(c=>tile(c,74,"small")).join("")}</div></section>`;
  } else if (!S.decisions){
    hero = `<section class="hero"><div class="hero-text"><span class="eyebrow">Your weekly check</span><h2>Let's see if any regulars are drifting away</h2>
      <p>I'll look at every repeat customer, check what's going on, and only bother you if something's worth doing.</p>
      <button class="btn light" id="runBtn" type="button" ${S.paused?"disabled":""}>${S.paused?"Sentinel is paused":"Check my store"}</button></div>
      <div class="hero-art">${["SER","SUN","LOT","CLN"].map(c=>tile(c,74,"small")).join("")}</div></section>`;
  } else if (p){
    const d=p.act, s=p.s;
    hero = `<section class="hero"><div class="hero-text"><span class="eyebrow">1 thing needs you</span><h2>${esc(SHORT[d.product_code])} regulars are coming back later</h2>
      <p>They usually reorder every ${weeks(s.usual_days)}. Lately it's closer to ${weeks(s.now_days)}. If nothing changes, about <b>${money(s.revenue_at_risk_60d)}</b> could slip away over the next two months.</p>
      ${S.approved?`<button class="btn light" data-go="${S.result?"results":"sent"}" type="button">${S.result?"See how it went":"See what I sent"}</button>`:`<button class="btn light" data-go="suggest" type="button">See what I'd do</button>`}</div>
      <div class="hero-art one">${tile(d.product_code,170,"big")}</div></section>`;
  } else {
    hero = `<section class="hero calm"><div class="hero-text"><span class="eyebrow">All good</span><h2>Nothing needs you today</h2><p>I checked everything. I'll keep watching.</p><button class="btn light" id="runBtn" type="button">Check again</button></div></section>`;
  }

  let people_ = "";
  if (p && !S.running){
    const ppl = slipping(p.act.product_code, 8);
    people_ = `<section><div class="sec-head"><h3>Regulars drifting away</h3><span class="muted">${people(p.s.customers_slowing)} in total</span></div>
      <div class="hscroll">${ppl.map(x=>`<div class="person">${avatar(x,52)}<b>${x.name}</b><span>Usually every ${weeks(x.usual)}</span><span class="late">Now ${weeks(x.now)}</span></div>`).join("")}</div></section>`;
  }

  const status = d => !d ? {cls:"", t:"Not checked yet"} :
    d.decision==="act" ? {cls:"act", t:"Needs you"} :
    d.reason==="stockout" ? {cls:"held", t:"Was out of stock"} :
    d.reason==="seasonal" ? {cls:"held", t:"Seasonal dip"} : {cls:"ok", t:"All good"};
  const prods = `<section><div class="sec-head"><h3>Your products</h3>${S.decisions&&!S.running?`<span class="muted">Tap one to see what I found</span>`:""}</div>
    <div class="pgrid">${P.map(pr=>{ const d=S.decisions?.find(x=>x.product_code===pr.code); const st=status(S.running?null:d);
      return `<button class="pcard" data-prod="${pr.code}" type="button" ${!d||S.running?"disabled":""}>${tile(pr.code,110)}<span class="pname">${SHORT[pr.code]}</span><span class="pill ${st.cls}">${st.t}</span></button>`; }).join("")}</div></section>`;

  const foot = S.decisions && !S.running ? `<p class="foot">${S.mode==="live"?"Decided live by an AI agent (Gemini)":"Decided by backup rules (AI was busy)"}, then checked against your rules. <a href="#" data-go="activity">See everything it did</a></p>` : "";
  return hero + people_ + prods + foot;
}

function vSuggest(){
  const p=plan(); if(!p) return vHome();
  const d=p.act, s=p.s, opts=estimate(d.product_code), o=opts.find(x=>x.action===S.choice)||opts[0];
  const copy=ACT_COPY[o.action];
  const msg=TMPL[S.template](esc(SHORT[d.product_code])).replace("{first_name}","Priya").replace("<b>{reorder_link}</b>","").replace("\n","<br>");
  return `<button class="back" data-go="home" type="button">← Back</button>
  <div class="split">
    <div class="col">
      ${tile(d.product_code,200,"hero-tile")}
      <div class="phone-msg"><span class="from">Dewleaf on WhatsApp</span><div class="bubble"><span>${msg}</span><span class="cta">Reorder in one tap</span></div></div>
    </div>
    <div class="col">
      <span class="eyebrow dark">My suggestion</span>
      <h1>${copy.title}</h1>
      <p class="lead">${copy.sub}</p>
      <div class="expect"><span class="big-emoji" aria-hidden="true">🎯</span><p>I expect ${oneIn(o.expected_lift_pts)} to come back because of it. That's roughly <b>${money(o.extra_revenue)}</b>, for about ${money(o.cost)} in messages.</p></div>
      <h3>Why I think this</h3>
      <ul class="why">
        <li><span class="ic ok">✓</span>Still in stock, so they can buy</li>
        <li><span class="ic ok">✓</span>Not a seasonal dip. Last year was steady</li>
        <li><span class="ic warn">!</span>${people(s.expired_card)} have an expired card. I'll send them a card update link instead</li>
        <li><span class="ic info">i</span>${people(s.not_opted_in)} haven't said yes to WhatsApp, so I'll leave them alone</li>
      </ul>
      <details class="unsure"><summary>What I'm not sure about</summary><p>${esc(d.dont_know||"Payment data can't tell me why they slowed down, like price or a competitor.")}</p></details>
      <p class="fair">I'll keep 1 in 10 of them aside without a message, so we can see what the reminder really did.</p>
      ${S.paused?`<p class="paused">Sentinel is paused. Turn it back on in Settings to send.</p>`:""}
      <div class="cta-row">
        <button class="btn primary big" id="send" type="button" ${S.paused?"disabled":""}>Send to ${people(p.nSend)} regulars</button>
        <div class="cta-sub"><button class="btn soft" data-sheet="options" type="button">Other ways</button><button class="btn soft" data-sheet="notnow" type="button">Not now</button></div>
      </div>
    </div>
  </div>`;
}

function vSent(){
  const p=plan(); if(!p||!S.approved) return vHome();
  return `<div class="center">
    <div class="done-badge">✓</div>
    <h1>${S.approved.auto?"Sent on its own, within your rules":"Sent!"}</h1>
    <p class="lead">${people(p.nSend)} regulars just got a friendly reminder on WhatsApp.</p>
    <div class="mini-list">
      <div><span class="em" aria-hidden="true">💳</span><span>${people(p.s.expired_card)} with an expired card got a card update link instead</span></div>
      <div><span class="em" aria-hidden="true">⚖️</span><span>${people(p.nCtrl)} got nothing for now, so we can compare fairly</span></div>
    </div>
    <p class="muted">I'll tell you how it went in two weeks.</p>
    <button class="btn primary big" id="ff" type="button">Skip ahead two weeks (demo)</button>
    <button class="btn soft" data-go="home" type="button">Back to home</button>
  </div>`;
}

function vResults(){
  const r=S.result; if(!r) return vHome();
  const good=r.extra_orders>0;
  const ppl=slipping(r.product,6);
  const max=Math.max(r.rt,r.rc);
  return `<button class="back" data-go="home" type="button">← Home</button>
  <div class="center wide">
    <span class="eyebrow dark">Two weeks later</span>
    <h1>${good?"It worked":"Not much difference this time"}</h1>
    <div class="stack">${ppl.map(x=>avatar(x,44)).join("")}<span class="plus">+${people(Math.max(0,r.extra_orders-ppl.length))}</span></div>
    <p class="lead">${good?`<b>${people(r.extra_orders)} more regulars</b> came back than would have on their own. That's about <b>${money(r.extra_revenue)}</b>, for ${money(r.cost)}.`:"The reminder didn't move people this time. I'll try something different next time."}</p>
    <div class="compare">
      <div class="row"><span>Got the reminder</span><div class="bar"><i style="width:${r.rt/max*100}%"></i></div><b>${oneIn(r.rt).replace("about ","")} reordered</b></div>
      <div class="row"><span>Didn't get it</span><div class="bar grey"><i style="width:${r.rc/max*100}%"></i></div><b>${oneIn(r.rc).replace("about ","")} reordered</b></div>
    </div>
    <div class="note"><span class="big-emoji" aria-hidden="true">💡</span><p><b>What I learned:</b> ${r.action==="reminder"?"a plain reminder is enough for these regulars. I'll start with this next time and keep discounts for when it's really needed.":"I'll compare this with a plain reminder next time."}</p></div>
    ${S.autoOk[r.product+":"+r.action]?`<div class="note ok"><p>Done. Next time I'll send this kind of reminder on my own, within your rules. Anything else still comes to you first.</p></div>`:
      `<div class="ask"><h3>Want me to do this on my own next time?</h3><p class="muted">Only this kind of reminder, only within your rules. You can pause me anytime.</p><div class="cta-sub"><button class="btn primary" id="autoYes" type="button">Yes, go ahead</button><button class="btn soft" id="autoNo" type="button">Keep asking me</button></div></div>`}
    <button class="btn soft" id="rerun" type="button">Check my store again</button>
  </div>`;
}

function activityList(){
  const rows=S.log.filter(e=>e.who!=="sep").slice(-80).reverse();
  if(!rows.length) return `<p class="muted">Nothing yet. Run a check from Home.</p>`;
  const who={ai:"AI agent",code:"Sentinel",guard:"Your rules",you:"You"};
  return rows.map(e=>`<div class="act-row"><span class="who ${e.who}">${who[e.who]||""}</span><div><b>${esc(e.text)}</b>${e.res?`<span>${esc(e.res)}</span>`:""}</div><span class="t">${e.t}</span></div>`).join("");
}
function vActivity(){
  return `<h1>Everything Sentinel did</h1><p class="lead">Every check, decision and message, in order. Saved, so nothing happens off the record.</p>
  <div class="activity" id="activity">${activityList()}</div>
  <button class="btn soft" id="resetMem" type="button">Start the demo fresh</button>`;
}

function vSettings(){
  return `<h1>Your rules</h1><p class="lead">Sentinel never goes past these.</p>
  <div class="rules">
    <div class="rule"><div><b>Biggest discount I can offer</b><span>${S.limits.maxInc}% of the order</span></div><div class="stepper"><button type="button" data-step="maxInc:-1" aria-label="Lower">−</button><b>${S.limits.maxInc}%</b><button type="button" data-step="maxInc:1" aria-label="Raise">+</button></div></div>
    <div class="rule"><div><b>Message each customer at most</b><span>once every ${S.limits.freq} days</span></div><div class="stepper"><button type="button" data-step="freq:-5" aria-label="Fewer days">−</button><b>${S.limits.freq}d</b><button type="button" data-step="freq:5" aria-label="More days">+</button></div></div>
    <div class="rule"><div><b>Keep some aside to measure fairly</b><span>1 in 10 customers get no message</span></div><span class="pill ok">Always on</span></div>
    <div class="rule"><div><b>Let Sentinel act on its own</b><span>${S.autonomy===3?"Only for actions you've approved before":"Off. It always asks you first"}</span></div><button class="switch ${S.autonomy===3?"on":""}" id="autoToggle" type="button" aria-pressed="${S.autonomy===3}"><i></i></button></div>
    <div class="rule"><div><b>Pause Sentinel</b><span>${S.paused?"Paused. It won't check or send anything":"On. Watching your store"}</span></div><button class="switch ${S.paused?"":"on"}" id="pauseToggle" type="button" aria-pressed="${!S.paused}"><i></i></button></div>
  </div>`;
}

/* bottom sheets */
function sheet(){
  if(!S.sheetOpen) return "";
  let body="";
  if (S.sheetOpen==="options"){
    const p=plan(); const opts=estimate(p.act.product_code);
    const words={reminder:"Cheapest. Usually all it takes.", free_ship:"A bit more pull, but costs more.", discount:"Most pull, but gives money away to people who'd buy anyway."};
    body=`<h2>Other ways to bring them back</h2>${opts.map(o=>`<button class="opt ${S.choice===o.action?"sel":""}" data-opt="${o.action}" type="button" ${o.allowed_by_merchant_limits?"":"disabled"}>
      <div><b>${ACT_COPY[o.action].title}</b><span>${o.allowed_by_merchant_limits?words[o.action]:`🔒 Locked. It's more than your ${S.limits.maxInc}% discount limit.`}</span></div>
      <span class="val">${o.allowed_by_merchant_limits?`about ${money(o.extra_profit)} extra profit`:`<a href="#" data-go="settings">Change limit</a>`}</span></button>`).join("")}
      <p class="muted">I recommend the one with the most profit after costs.</p>`;
  } else if (S.sheetOpen==="notnow"){
    body=`<h2>No problem. Tell me why?</h2><p class="muted">It helps me suggest better next time.</p><div class="chips">${["Not the right time","Wrong customers","I already knew this","Don't discount these customers"].map(t=>`<button class="chip" data-reason="${esc(t)}" type="button">${t}</button>`).join("")}</div>`;
  } else {
    const code=S.sheetOpen, d=S.decisions?.find(x=>x.product_code===code), s=S.scan?.find(x=>x.code===code);
    const what = d.decision==="act"?"":
      d.reason==="stockout"?"No messages sent. I sent you a restock reminder instead.":
      d.reason==="seasonal"?"No messages sent. This dip fixes itself every year.":"Nothing to do.";
    body=`<div class="sheet-prod">${tile(code,120)}<div><h2>${SHORT[code]}</h2><p>${esc(d.headline)}</p></div></div>
      <p>${esc(d.found||"")}</p>${d.reason==="seasonal"?`<p class="muted">Usually every ${weeks(s.usual_days)}, now ${weeks(s.now_days)}. Same thing happened last monsoon.</p>`:""}
      ${what?`<div class="note"><p>${what}</p></div>`:`<button class="btn primary" data-go="suggest" type="button">See what I'd do</button>`}`;
  }
  return `<div class="scrim" id="scrim"></div><div class="sheet" role="dialog" aria-modal="true"><span class="grab"></span>${body}<button class="btn soft close" id="closeSheet" type="button">Close</button></div>`;
}

function nav(){
  const items=[["home","Home",'<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/>'],["activity","Activity",'<path d="M4 6h16M4 12h16M4 18h10"/>'],["settings","Rules",'<path d="M12 8a4 4 0 100 8 4 4 0 000-8zm8 4l-2-1 1-2-2-2-2 1-1-2h-4l-1 2-2-1-2 2 1 2-2 1v4l2 1-1 2 2 2 2-1 1 2h4l1-2 2 1 2-2-1-2 2-1z"/>']];
  return items.map(([id,t,d])=>`<button class="navbtn ${S.view===id||(id==="home"&&["suggest","sent","results"].includes(S.view))?"on":""}" data-go="${id}" type="button" aria-label="${t}"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">${d}</svg><span>${t}</span></button>`).join("");
}

function go(v){ S.view=v; S.sheetOpen=null; render(); window.scrollTo({top:0}); }
function toast(t){ const el=$("toast"); el.textContent=t; el.hidden=false; clearTimeout(toast._t); toast._t=setTimeout(()=>el.hidden=true,2600); }

function render(){
  if(!A) return;
  $("status").innerHTML = `<span class="live ${S.paused?"off":""}"></span>${S.paused?"Paused":"Watching"}`;
  $("main").innerHTML = ({home:vHome, suggest:vSuggest, sent:vSent, results:vResults, activity:vActivity, settings:vSettings})[S.view]();
  $("sheetHost").innerHTML = sheet();
  $("nav").innerHTML = nav();
  bind();
}

function bind(){
  document.querySelectorAll("[data-go]").forEach(b=>b.onclick=e=>{ e.preventDefault(); go(b.dataset.go); });
  document.querySelectorAll("[data-prod]").forEach(b=>b.onclick=()=>{ const d=S.decisions?.find(x=>x.product_code===b.dataset.prod); if(d?.decision==="act"){ go("suggest"); } else { S.sheetOpen=b.dataset.prod; render(); } });
  document.querySelectorAll("[data-sheet]").forEach(b=>b.onclick=()=>{ S.sheetOpen=b.dataset.sheet; render(); });
  const close=()=>{ S.sheetOpen=null; render(); };
  $("scrim")&&($("scrim").onclick=close); $("closeSheet")&&($("closeSheet").onclick=close);
  document.querySelectorAll("[data-opt]").forEach(b=>b.onclick=()=>{ S.choice=b.dataset.opt; addLog("you",`Chose: ${labelOf(S.choice)}`,""); close(); });
  document.querySelectorAll("[data-reason]").forEach(b=>b.onclick=()=>{ const fb={product:pname(plan().act.product_code), action:S.choice, merchant_said:b.dataset.reason}; S.feedback.push(fb); post("feedback",fb); S.rejected=fb.merchant_said; addLog("you",`Said not now: ${fb.merchant_said}`,"saved for next time"); S.sheetOpen=null; go("home"); toast("Got it. I'll remember that."); });
  const rb=$("runBtn"); if(rb) rb.onclick=()=>{ S.runStart=S.log.length; runSentinel(false); };
  const st=$("stop"); if(st) st.onclick=()=>S.ctl?.abort();
  const sd=$("send"); if(sd) sd.onclick=()=>{ approve(false); go("sent"); };
  const ff=$("ff"); if(ff) ff.onclick=()=>{ fastForward(); go("results"); };
  const re=$("rerun"); if(re) re.onclick=()=>{ go("home"); S.runStart=S.log.length; runSentinel(false); };
  const ay=$("autoYes"); if(ay) ay.onclick=()=>{ S.autoOk[S.result.product+":"+S.result.action]=true; S.autonomy=3; addLog("you",`Let Sentinel send ${labelOf(S.result.action)} on its own`,"only within your rules"); render(); };
  const an=$("autoNo"); if(an) an.onclick=()=>toast("Okay. I'll always ask first.");
  const rm=$("resetMem"); if(rm) rm.onclick=async()=>{ await flush(); await post("reset",{}); Object.assign(S,{lifts:{reminder:8,free_ship:9,discount:10},history:[],feedback:[],log:[],decisions:null,approved:null,result:null,autoOk:{},autonomy:2,choice:null}); go("home"); toast("Fresh start. Past results set aside."); };
  document.querySelectorAll("[data-step]").forEach(b=>b.onclick=()=>{ const [k,v]=b.dataset.step.split(":"); const lim={maxInc:[0,30],freq:[7,90]}[k]; S.limits[k]=Math.min(lim[1],Math.max(lim[0],S.limits[k]+Number(v))); addLog("you",k==="maxInc"?`Set biggest discount to ${S.limits.maxInc}%`:`Set messages to once every ${S.limits.freq} days`,""); if(S.choice==="discount"&&S.limits.maxInc<10) S.choice="reminder"; render(); });
  const at=$("autoToggle"); if(at) at.onclick=()=>{ S.autonomy=S.autonomy===3?2:3; if(S.autonomy===2) S.autoOk={}; addLog("you",S.autonomy===3?"Allowed Sentinel to act on its own for approved actions":"Turned off acting on its own",""); render(); };
  const pt=$("pauseToggle"); if(pt) pt.onclick=()=>{ S.paused=!S.paused; if(S.paused&&S.running) S.ctl?.abort(); addLog("you",S.paused?"Paused Sentinel":"Turned Sentinel back on",""); render(); };
}

async function boot(){
  $("main").innerHTML=`<p class="muted" style="padding:40px 0">Loading…</p>`;
  A = await (await fetch("/app_data.json")).json(); P=A.products; C=A.customers; NC=C.p.length;
  await loadMemory();
  S.log = S.log.filter(e=>e.who!=="sep");
  render();
}
boot();
