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

/* ---------------- charts ---------------- */
function lineChart(code, opts){
  const data=Object.entries(A.monthly_gap[code]).filter(([m])=>m>="2025-01").map(([m,v])=>({m,v}));
  const W=640,H=200,L=40,R=16,T=18,B=30; const vals=data.map(d=>d.v);
  const lo=Math.floor(Math.min(...vals)/10)*10, hi=Math.ceil(Math.max(...vals)/10)*10+5;
  const x=i=>L+i*(W-L-R)/(data.length-1), y=v=>T+(hi-v)*(H-T-B)/(hi-lo);
  let g=""; for(let v=lo; v<=hi; v+=10) g+=`<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L-8}" y="${y(v)+4}" text-anchor="end">${v}</text>`;
  const pts=data.map((d,i)=>`${x(i)},${y(d.v)}`).join(" ");
  let lab=""; const MN=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  data.forEach((d,i)=>{ const [yy,mm]=d.m.split("-"); if(mm==="01"||mm==="06"||i===data.length-1) lab+=`<text x="${x(i)}" y="${H-10}" text-anchor="middle">${MN[+mm-1]} ${yy.slice(2)}</text>`; });
  let sh=""; (opts.shade||[]).forEach(([a,b,t])=>{ const i1=data.findIndex(d=>d.m===a), i2=data.findIndex(d=>d.m===b); if(i1>-1&&i2>-1) sh+=`<rect x="${x(i1)-6}" y="${T}" width="${x(i2)-x(i1)+12}" height="${H-T-B}" fill="var(--${opts.c}-soft)"/><text x="${(x(i1)+x(i2))/2}" y="${T+12}" text-anchor="middle" style="fill:var(--${opts.c});font-weight:600">${t}</text>`; });
  return `<div class="chartwrap"><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(opts.aria)}">${sh}${g}<polygon points="${L},${y(lo)} ${pts} ${x(data.length-1)},${y(lo)}" fill="var(--accent)" opacity=".08"/><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linejoin="round"/><circle cx="${x(data.length-1)}" cy="${y(vals[vals.length-1])}" r="4" fill="var(--accent)"/>${lab}<text x="${L}" y="${T-6}">days between orders</text></svg></div>`;
}
function stockChart(){
  const s=A.sun_weekly, W=640,H=180,L=44,R=10,T=14,B=28; const top=Math.ceil(Math.max(...s.map(d=>d.orders))/500)*500; const bw=(W-L-R)/s.length; const y=v=>T+(top-v)*(H-T-B)/top;
  const so=["24 Aug","31 Aug","07 Sep"]; let g=""; for(let v=0; v<=top; v+=1000) g+=`<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L-8}" y="${y(v)+4}" text-anchor="end">${fmt(v)}</text>`;
  const bars=s.map((d,i)=>`<rect x="${L+i*bw+3}" y="${y(d.orders)}" width="${bw-6}" height="${Math.max(0,y(0)-y(d.orders))}" rx="3" fill="${so.includes(d.week)?'var(--held)':'var(--ctrl)'}"/>`+(i%3===0?`<text x="${L+i*bw+bw/2}" y="${H-10}" text-anchor="middle">${d.week}</text>`:"")).join("");
  const i0=s.findIndex(d=>d.week===so[0]);
  return `<div class="chartwrap"><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Weekly sunscreen orders drop to near zero during the stockout">${g}${bars}<text x="${L+(i0+1.5)*bw}" y="${y(0)-40}" text-anchor="middle" style="fill:var(--held);font-weight:600">Out of stock</text><text x="${L}" y="${T-3}">orders per week</text></svg></div>`;
}

/* ---------------- views ---------------- */
const STEPS=[{id:"run",t:"Run & alerts"},{id:"evidence",t:"Evidence"},{id:"decide",t:"Decide"},{id:"customer",t:"Customer view"},{id:"results",t:"Results"},{id:"activity",t:"Activity log"}];
function go(id){ S.step=id; render(); window.scrollTo({top:0}); }
function toast(t){ const el=$("toast"); el.textContent=t; el.hidden=false; clearTimeout(toast._t); toast._t=setTimeout(()=>el.hidden=true,2600); }

function rail(){
  const idx=STEPS.findIndex(s=>s.id===S.step); const names={1:"Recommend only",2:"Prepare for approval",3:"Run pre-approved actions"};
  $("rail").innerHTML = STEPS.map((s,i)=>`<button class="step ${i<idx?'done':''}" aria-current="${s.id===S.step}" data-go="${s.id}" type="button"><span class="n">${i+1}</span>${s.t}</button>`).join("")
   + `<div class="foot"><span class="label">Autonomy level ${S.autonomy} of 3</span><div class="level">${[1,2,3].map(i=>`<i class="${i<=S.autonomy?'on':''}"></i>`).join("")}</div><span>${names[S.autonomy]}</span></div>`;
  $("rail").querySelectorAll("[data-go]").forEach(b=>b.onclick=()=>go(b.dataset.go));
}

function logHtml(entries){
  return entries.map(e => e.who==="sep" ? `<div class="le" style="background:var(--surface)"><span class="who">${e.t}</span><span></span><b>${esc(e.text)}</b></div>` :
    `<div class="le"><span class="who ${e.who==="ai"?"ai":e.who==="guard"?"guard":e.who==="you"?"you":""}">${{ai:"AI agent",code:"Code",guard:"Guardrail",you:"You"}[e.who]}</span>
     ${e.state==="busy"?'<span class="spin"></span>':e.who==="ai"?'<span class="dotai"></span>':e.who==="guard"?'<span class="dotg"></span>':'<span class="dotok">✓</span>'}
     <span><span>${esc(e.text)}</span>${e.state==="busy"&&e.text.startsWith("Gemini is")?` <span class="num muted" id="elapsed">${S.elapsed}s</span>`:""}${e.res?`<br><span class="res">${esc(e.res)}</span>`:""}</span></div>`).join("");
}
function renderLog(){ const el=$("agentlog"); if(el){ el.innerHTML=logHtml(S.log.slice(-40)); el.scrollTop=el.scrollHeight; } const al=$("fulllog"); if(al) al.innerHTML=logHtml(S.log); }

function modeChip(){ if(!S.mode) return ""; return S.mode==="live" ? `<span class="mode">Decided live by Gemini</span>` : `<span class="mode off">${S.mode==="fallback"?"AI unavailable, offline rules used":"Offline rules (no AI)"}</span>`; }

function vRun(){
  const head = `<div class="head"><span class="label">Dewleaf Skincare (fictional) · data to 1 Oct 2026</span><h1>${S.decisions ? `${S.decisions.length} products checked. ${S.decisions.filter(d=>d.decision==="act").length} need${S.decisions.filter(d=>d.decision==="act").length===1?"s":""} your decision.` : "Run Sentinel on this week's data"}</h1></div>`;
  const runCard = `<div class="card"><div class="runbar"><div style="display:flex;flex-direction:column;gap:4px"><h2>${S.running?"Sentinel is working…":S.decisions?"Last run finished":"Ready"}</h2>
      <span class="muted" style="font-size:14px">Code finds the changes. The AI agent (Gemini) investigates with tools and decides. Your guardrails check every decision.</span></div>
      <div class="actions">${S.running?`<button class="btn" id="stop" type="button">Stop</button>`:`<button class="btn primary" id="runBtn" type="button" ${S.paused?"disabled":""}>${S.decisions?"Run again":"Run Sentinel"}</button>`}
      ${S.memoryOk===false?`<span class="muted" style="font-size:13px">Memory offline: this visit won't be saved.</span>`:""}</div></div>
      ${S.paused?`<div class="paused-overlay">The agent is paused. Turn it back on to run.</div>`:""}
      ${S.log.length?`<div class="agentlog" id="agentlog" aria-live="polite">${logHtml(S.log.slice(-40))}</div>`:""}</div>`;
  if (!S.decisions) return head + runCard + (S.running?"":`<div class="empty"><b>No run yet</b><span>Press Run Sentinel. It scans ${fmt(NC)} repeat customers, then the AI agent checks stock, last year's pattern, payment problems and who can be messaged before deciding anything.</span></div>`);
  const order={act:0,hold:1,monitor:2};
  const cards = [...S.decisions].sort((a,b)=>order[a.decision]-order[b.decision]).map(d => {
    const s=S.scan.find(x=>x.code===d.product_code); const cls=d.decision==="act"?"act":d.decision==="hold"?"held":"ok";
    const pill=d.decision==="act"?`<span class="pill act">Needs your decision</span>`:d.decision==="hold"?`<span class="pill held">Held: ${esc(d.reason)}</span>`:`<span class="pill ok">Monitoring</span>`;
    let detail="";
    if (S.open===d.product_code){
      detail = `<div class="detail"><p>${esc(d.found)}</p>${d.reason==="stockout"&&d.product_code==="SUN"?stockChart():d.reason==="seasonal"?lineChart(d.product_code,{aria:"Reorder gap rises every June to August",shade:[["2025-06","2025-08","Last year"],["2026-06","2026-07","This year"]],c:"held"}):""}<p class="muted">${esc(d.why)}</p></div>`;
    }
    return `<button class="alert ${cls}" data-alert="${d.product_code}" data-dec="${d.decision}" type="button" aria-expanded="${S.open===d.product_code}"><span class="stripe"></span>
      <span class="body"><span style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${pill}<span class="muted" style="font-size:13px">${esc(s.name)}</span></span>
      <h3>${esc(d.headline)}</h3><span class="muted" style="font-size:14px">${d.decision==="act"?`${fmt(s.customers_slowing)} regulars · usual ${s.usual_days} days → now ${s.now_days} days`:esc(d.why)}</span>
      ${d.guard.map(g=>`<span class="guardnote">⚑ ${esc(g)}</span>`).join("")}${detail}</span>
      <span class="side">${d.decision==="monitor"?"":`<span class="num" style="font-weight:600">${inr(s.revenue_at_risk_60d)}</span><span class="muted" style="font-size:12.5px">${d.decision==="act"?"at risk, 60 days":"no spend"}</span>`}</span></button>`;
  }).join("");
  return head + runCard + `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">${modeChip()}<span class="muted" style="font-size:13px">Tap a held alert to see why Sentinel didn't act.</span></div><div style="display:flex;flex-direction:column;gap:10px">${cards}</div>`;
}

function needRun(){ return `<div class="empty"><b>Nothing here yet</b><span>Run Sentinel first.</span><button class="btn primary" data-go="run" type="button">Go to Run</button></div>`; }

function vEvidence(){
  const p=plan(); if(!p) return S.decisions? `<div class="empty"><b>No change worth acting on in this run</b><span>Every alert was held or is being monitored.</span></div>` : needRun();
  const {act:d, s}=p; const se=toolSeason(d.product_code), st=toolStock(d.product_code);
  return `<div class="head"><span class="pill act" style="align-self:flex-start">Needs your decision</span><h1>${esc(d.headline)}</h1><p class="muted">${fmt(s.customers_slowing)} of ${fmt(s.repeat_customers)} ${esc(s.name)} regulars · ${modeChip()}</p></div>
  <div class="grid4">
    <div class="card stat"><span class="v num">${s.usual_days} → ${s.now_days}</span><span class="k">days between orders</span></div>
    <div class="card stat"><span class="v num">+${s.median_change_pct}%</span><span class="k">slower than their own normal (median)</span></div>
    <div class="card stat"><span class="v num">${inr(s.revenue_at_risk_60d)}</span><span class="k">at risk, next 60 days</span></div>
    <div class="card stat"><span class="v" style="text-transform:capitalize">${esc(d.confidence)}</span><span class="k">confidence (agent's call)</span></div></div>
  <div class="card"><h2>${esc(s.name)} regulars changed rhythm in June</h2>${lineChart(d.product_code,{aria:"Reorder gap flat, then a step up from June 2026",shade:[["2026-06","2026-07","Change"]],c:"act"})}</div>
  <div class="kfsd">
    <div class="card"><span class="label">What I know</span><p>${esc(d.know)}</p></div>
    <div class="card"><span class="label">What I found</span><p>${esc(d.found)}</p></div>
    <div class="card"><span class="label">What I suspect</span><p>${esc(d.suspect)}</p></div>
    <div class="card"><span class="label">What I don't know</span><p>${esc(d.dont_know)}</p></div></div>
  <div class="card"><h2>Checks (run by the agent's tools)</h2><div class="checks">
    <div class="check"><span class="ic ok">✓</span><div><b>Stock</b><p class="muted">${st.in_stock_whole_period?"In stock the whole period (connected store).":"Stockout found."}</p></div><span class="pill ok">Clear</span></div>
    <div class="check"><span class="ic ok">✓</span><div><b>Season</b><p class="muted">Same months last year: ${se.same_months_last_year_slower_by_pct}% change, so not seasonal.</p></div><span class="pill ok">Clear</span></div>
    <div class="check"><span class="ic warn">!</span><div><b>Payment problems</b><p class="muted">${fmt(s.expired_card)} have an expired saved card and a recent failed payment. They get a card update link, not a reminder.</p></div><span class="pill held">Handled separately</span></div>
    <div class="check"><span class="ic warn">!</span><div><b>Who can be messaged</b><p class="muted">${fmt(s.not_opted_in)} haven't opted in and won't be contacted. ${fmt(s.reachable)} can be.</p></div><span class="pill held">Excluded</span></div></div></div>
  <div class="actions"><button class="btn primary" data-go="decide" type="button">See recommendation</button></div>`;
}

const TMPL={t1:n=>`Hi {first_name}, it's been a while since your last <b>${n}</b>. Running low?\nReorder in one tap: <b>{reorder_link}</b>`, t2:n=>`Hi {first_name}, your <b>${n}</b> routine is due. We saved your last order.\nPay with UPI in one tap: <b>{reorder_link}</b>`};
function vDecide(){
  const p=plan(); if(!p) return S.decisions? `<div class="empty"><b>Nothing to decide in this run</b></div>` : needRun();
  const {act:d, s, nCtrl, nSend}=p; const opts=estimate(d.product_code);
  const rows = opts.map(o => `<label class="opt ${S.choice===o.action?'sel':''}" for="opt_${o.action}"><input type="radio" name="opt" id="opt_${o.action}" value="${o.action}" ${S.choice===o.action?'checked':''} ${o.allowed_by_merchant_limits?'':'disabled'} ${S.approved?'disabled':''}>
    <div style="display:flex;flex-direction:column;gap:3px;min-width:0"><span style="font-weight:600">${esc(o.label)} ${o.action===d.action?'<span class="pill acc">Agent recommends</span>':''}</span><span class="muted" style="font-size:13px">+${o.expected_lift_pts} pts reorder rate expected${o.allowed_by_merchant_limits?"":" · above your incentive limit"}</span></div>
    <div class="c hide-sm"><span class="num">${inr(o.extra_revenue)}</span><span class="k">extra revenue</span></div><div class="c hide-sm"><span class="num">${inr(o.cost)}</span><span class="k">cost</span></div><div class="c"><span class="num" style="font-weight:600">${inr(o.extra_profit)}</span><span class="k">extra profit</span></div></label>`).join("");
  let status="";
  if (S.approved) status=`<div class="banner ok"><b>${S.approved.auto?"Auto-approved within your limits.":"Approved."}</b>&nbsp;Sent to ${fmt(nSend)} customers. ${fmt(nCtrl)} held back for comparison.</div><div class="actions"><button class="btn primary" data-go="customer" type="button">See what the customer gets</button><button class="btn" data-go="results" type="button">Go to results</button></div>`;
  else if (S.rejected) status=`<div class="banner held"><b>Not sent.</b>&nbsp;Feedback saved: "${esc(S.rejected)}". The agent reads this on the next run.</div>`;
  return `<div class="head"><span class="label">${esc(s.name)} regulars · ${fmt(s.reachable)} reachable</span><h1>${esc(labelOf(d.action))}</h1><p class="muted">${esc(d.why)}</p></div>
  <div class="card"><h2>Options compared</h2><div class="opt-head muted" style="font-size:12px"><span></span><span>Action</span><span class="hide-sm" style="text-align:right">Extra revenue</span><span class="hide-sm" style="text-align:right">Cost</span><span style="text-align:right">Extra profit</span></div>
    <div class="opts">${rows}</div><p class="muted" style="font-size:12.5px">Assumptions: no-message reorder rate ${BASE_RATE*100}% in 14 days · lifts learned from past campaigns (start: reminder +8, free shipping +9, 10% off +10) · WhatsApp ₹${A.merchant.whatsapp_cost}/message · shipping ₹${A.merchant.shipping_cost} · gross margin ${A.merchant.gross_margin*100}%.</p></div>
  <div class="card"><h2>Review and edit</h2><div class="form">
    <div class="field"><label for="tmpl">Message template (pre-approved)</label><select id="tmpl" ${S.approved?'disabled':''}><option value="t1" ${S.template==="t1"?"selected":""}>Running low reminder</option><option value="t2" ${S.template==="t2"?"selected":""}>Routine is due</option></select><div class="msg">${TMPL[S.template](esc(s.name))}</div><span class="muted" style="font-size:12.5px">Only the fields in braces change. No AI-written text reaches customers.</span></div>
    <div style="display:flex;flex-direction:column;gap:14px">
      <div class="field"><label for="maxInc">Max incentive (% of order value)</label><input type="number" id="maxInc" min="0" max="30" value="${S.limits.maxInc}" ${S.approved?'disabled':''}></div>
      <div class="field"><label for="freq">Max one message per customer every (days)</label><input type="number" id="freq" min="7" max="90" value="${S.limits.freq}" ${S.approved?'disabled':''}></div>
      <div class="field"><label>Comparison group</label><span class="muted" style="font-size:14px">${S.limits.ctrl}% get no message (${fmt(nCtrl)}), so results show what the action really added.</span></div></div></div></div>
  ${status || `<div class="actions"><button class="btn primary" id="approve" type="button" ${S.paused?'disabled':''}>Approve and send to ${fmt(nSend)}</button><select id="rejectReason" class="btn" aria-label="Reject with a reason"><option value="">Reject with a reason…</option><option>Not relevant</option><option>Wrong audience</option><option>Already know this</option><option>Don't discount these customers</option></select></div>`}`;
}

function vCustomer(){
  const p=plan(); const name = p ? p.s.name : "Vitamin C Serum 30ml"; const price = p ? P[pidx(p.act.product_code)].price : 599;
  const sheet = S.sheet===1 ? `<div class="sheet"><b>Reorder ${esc(name)}</b><div style="display:flex;justify-content:space-between"><span class="muted">1 × ₹${price} · same address</span><span class="num">₹${price}</span></div><div class="upi"><span class="label">Pay with UPI</span><button type="button" data-pay="1"><span>Your usual UPI app</span><span>→</span></button><button type="button" data-pay="1"><span>Saved card ending 4821</span><span>→</span></button></div></div>`
    : S.sheet===2 ? `<div class="sheet" style="align-items:center;text-align:center"><span class="ic ok" style="width:44px;height:44px;font-size:22px">✓</span><b>Order placed</b><span class="muted" style="font-size:13px">₹${price} paid. Arriving Friday.</span></div>` : "";
  return `<div class="head"><span class="label">Customer view</span><h1>The reminder closes the sale in one tap.</h1></div>
  <div class="phonewrap"><div class="card"><h2>What happens</h2><ol style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:8px"><li>A pre-approved WhatsApp message goes out through Razorpay Engage.</li><li>One tap opens checkout with the last order filled in.</li><li>They pay with UPI or a saved card, so the result is measured exactly.</li></ol>
    <p class="muted" style="font-size:14px">Only opted-in customers, never more than once every ${S.limits.freq} days.</p><div class="actions"><button class="btn primary" data-go="results" type="button">Go to results</button></div></div>
  <div class="phone" aria-label="Phone preview of the customer message"><div class="ph-top"><span class="ph-av">D</span><div><b style="font-size:14px">Dewleaf Skincare</b><div style="font-size:11px;opacity:.85">Business account</div></div></div>
    <div class="ph-body"><div class="bubble"><span>${TMPL[S.template](esc(name)).replace("{first_name}","Priya").replace("<b>{reorder_link}</b>","").replace("\n","<br>")}</span><span>Your usual: ${esc(name)}, ₹${price}</span><span class="t">10:02</span><button class="cta" type="button" id="reorderBtn">Reorder in one tap</button></div></div>${sheet}</div></div>`;
}

function vResults(){
  if (!S.approved) return S.decisions ? `<div class="empty"><b>Approve an action first</b><span>Results come from comparing messaged customers with the held-back group.</span><button class="btn primary" data-go="decide" type="button">Go to Decide</button></div>` : needRun();
  if (!S.result) return `<div class="head"><span class="label">Waiting for results</span><h1>Measure what the action really added</h1></div><div class="card"><p>The test runs for 14 days. In this prototype you can jump ahead: customer responses are simulated from the sample data, so numbers differ each run.</p><div class="actions"><button class="btn primary" id="ff" type="button">Fast-forward 14 days</button></div></div>`;
  const r=S.result; const mx=Math.max(r.rt,r.rc);
  return `<div class="head"><span class="label">14 days later · 15 Oct 2026</span><h1>${r.extra_orders>0?`The ${r.action==="reminder"?"reminder":"action"} brought back ${fmt(r.extra_orders)} extra orders.`:"No clear effect this time."}</h1><p class="muted">Compared with ${fmt(r.nCtrl)} similar customers who got no message.</p></div>
  <div class="card"><h2>Reordered within 14 days</h2><div class="bars">
    <div class="bar-row"><span>Messaged <span class="muted num">(${fmt(r.nSend)})</span></span><div class="track"><div class="fill" style="width:${r.rt/mx*100}%;background:var(--accent)"></div></div><span class="num" style="font-weight:600">${r.rt.toFixed(1)}%</span></div>
    <div class="bar-row"><span>No message <span class="muted num">(${fmt(r.nCtrl)})</span></span><div class="track"><div class="fill" style="width:${r.rc/mx*100}%;background:var(--ctrl)"></div></div><span class="num" style="font-weight:600">${r.rc.toFixed(1)}%</span></div></div>
    <p class="muted" style="font-size:14px">Some would have come back anyway (grey). Sentinel only counts the difference.</p></div>
  <div class="grid4"><div class="card stat"><span class="v num">${r.lift>=0?"+":""}${r.lift.toFixed(1)} pts</span><span class="k">reorder rate vs no message</span></div><div class="card stat"><span class="v num">${fmt(r.extra_orders)}</span><span class="k">extra orders</span></div><div class="card stat"><span class="v num">${inr(r.extra_revenue)}</span><span class="k">extra revenue recovered</span></div><div class="card stat"><span class="v num">${inr(r.cost)}</span><span class="k">cost</span></div></div>
  <div class="card"><span class="label" style="color:var(--accent)">What Sentinel learned</span><p>Expected +${r.expected} pts, measured ${r.lift>=0?"+":""}${r.lift.toFixed(1)}. The estimate for this action is now +${r.updated} pts, saved to memory, and the agent sees this result on the next run.</p>
    <div class="actions"><button class="btn primary" id="rerun" type="button">Run Sentinel again with what it learned</button></div></div>
  <div class="card"><h2>Let Sentinel run this on its own next time?</h2><p class="muted">${esc(labelOf(r.action))} for ${esc(pname(r.product))} regulars, within your limits. Pause anytime. Anything else still needs your approval.</p>
    ${S.autoOk[r.product+":"+r.action]?`<div class="banner ok">Done. Autonomy level 3 for this one action.</div>`:`<div class="actions"><button class="btn primary" id="autoYes" type="button">Yes, within my limits</button><button class="btn" id="autoNo" type="button">Not yet</button></div>`}</div>`;
}

function vActivity(){
  return `<div class="head"><span class="label">Audit trail</span><h1>Everything Sentinel did, and why</h1><p class="muted">Every check, decision, guardrail change and action, in order, saved to Supabase. Nothing happens off the record.</p></div>
  <div class="actions"><button class="btn" id="resetMem" type="button">Reset demo memory</button><span class="muted" style="font-size:13px">Starts the agent fresh: past campaigns, feedback and learning are set aside.</span></div>
  ${S.log.length?`<div class="agentlog" id="fulllog" style="max-height:none">${logHtml(S.log)}</div>`:needRun()}`;
}

function render(){
  rail();
  $("main").innerHTML = ({run:vRun, evidence:vEvidence, decide:vDecide, customer:vCustomer, results:vResults, activity:vActivity})[S.step]();
  const m=$("main");
  m.querySelectorAll("[data-go]").forEach(b=>b.onclick=()=>go(b.dataset.go));
  m.querySelectorAll("[data-alert]").forEach(b=>b.onclick=()=>{ if(b.dataset.dec==="act"){ go("evidence"); return; } S.open=S.open===b.dataset.alert?null:b.dataset.alert; render(); });
  const rb=$("runBtn"); if(rb) rb.onclick=()=>runSentinel(false);
  const sb=$("stop"); if(sb) sb.onclick=()=>S.ctl?.abort();
  m.querySelectorAll('input[name="opt"]').forEach(r=>r.onchange=()=>{ S.choice=r.value; render(); });
  const t=$("tmpl"); if(t) t.onchange=()=>{ S.template=t.value; render(); };
  const mi=$("maxInc"); if(mi) mi.onchange=()=>{ S.limits.maxInc=Math.max(0,+mi.value||0); const o=estimate(plan().act.product_code).find(x=>x.action===S.choice); if(o&&!o.allowed_by_merchant_limits){ S.choice="reminder"; } addLog("you",`Changed incentive limit to ${S.limits.maxInc}%`,""); render(); toast("Limit saved"); };
  const fq=$("freq"); if(fq) fq.onchange=()=>{ S.limits.freq=Math.max(7,+fq.value||30); addLog("you",`Changed message limit to one per ${S.limits.freq} days`,""); render(); toast("Limit saved"); };
  const ap=$("approve"); if(ap) ap.onclick=()=>{ approve(false); render(); toast("Approved and sent"); };
  const rj=$("rejectReason"); if(rj) rj.onchange=()=>{ if(!rj.value) return; S.rejected=rj.value; const fb={product:pname(plan().act.product_code), action:S.choice, merchant_said:rj.value}; S.feedback.push(fb); post("feedback",fb); addLog("you",`Rejected: ${rj.value}`,"saved as feedback for the next run"); render(); toast("Feedback saved"); };
  const ro=$("reorderBtn"); if(ro) ro.onclick=()=>{ S.sheet=1; render(); };
  m.querySelectorAll("[data-pay]").forEach(b=>b.onclick=()=>{ S.sheet=2; render(); });
  const ff=$("ff"); if(ff) ff.onclick=()=>{ fastForward(); render(); };
  const re=$("rerun"); if(re) re.onclick=()=>{ go("run"); runSentinel(false); };
  const ay=$("autoYes"); if(ay) ay.onclick=()=>{ S.autoOk[S.result.product+":"+S.result.action]=true; S.autonomy=3; addLog("you",`Pre-approved: ${labelOf(S.result.action)} for ${pname(S.result.product)}`,"autonomy level 3 for this action only"); render(); };
  const rm=$("resetMem"); if(rm) rm.onclick=async()=>{ await flush(); await post("reset",{}); S.lifts={reminder:8,free_ship:9,discount:10}; S.history=[]; S.feedback=[]; S.log=[]; S.decisions=null; S.approved=null; S.result=null; S.autoOk={}; S.autonomy=2; render(); toast("Memory reset. The agent starts fresh."); };
  const an=$("autoNo"); if(an) an.onclick=()=>toast("Okay. Sentinel will keep asking first.");
  const al=$("agentlog"); if(al) al.scrollTop=al.scrollHeight;
}

async function boot(){
  $("main").innerHTML=`<div class="empty"><b>Loading sample data…</b></div>`;
  A = await (await fetch("/data/app_data.json")).json(); P=A.products; C=A.customers; NC=C.p.length;
  $("merchantChip").textContent = A.merchant.name + " · ₹" + A.merchant.annual_revenue_cr + " Cr/yr";
  await loadMemory();
  render();
}
$("pauseBtn").onclick = () => { S.paused=!S.paused; $("pauseBtn").setAttribute("aria-pressed", S.paused); $("pauseLbl").textContent=S.paused?"Agent paused":"Agent on"; if(S.paused&&S.running) S.ctl?.abort(); addLog("you", S.paused?"Paused the agent":"Turned the agent back on", ""); render(); };
boot();
