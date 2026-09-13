// ── OWNER VOICE ──────────────────────────────────────────────────────────────
// Earlier suites are written in ANALYST voice. The person who will use this owns a
// diagnostic centre in Hyderabad and types topic-first, verb-last, on a phone:
//   "last month collection how much"   not  "What was our revenue in August 2026?"
//   "doctor wise referral amount"      not  "Aggregate commission by referring doctor"
// PAIRS is a CONTROLLED A/B: identical control SQL, identical architecture, only wording differs.
import { CASES } from './cases.mjs';
import { NEW } from './cases2.mjs';
import { HARD } from './cases3.mjs';
const BY={}; for(const c of [...CASES,...NEW,...(HARD||[])]) BY[c.id]=c;
const pair=(id,owner,note)=>({id:'O_'+id, ref:id, analyst:BY[id].q, q:owner, sql:BY[id].sql, note});

// "last month" from 2026-09-10 IST = August 2026. The analyst version names the month
// outright; the owner version never does. Relative-date resolution is part of the test.
export const PAIRS=[
 pair('S01','last month how many cases','"cases" = visits'),
 pair('S02','last month collection how much','collection, topic-first'),
 pair('S03','last month how many tests done',''),
 pair('S05','last month how many bills made',''),
 pair('S06','discount how much given last month',''),
 pair('S07','refund how much last month',''),
 pair('S11','last month bills due how much','"due" = outstanding'),
 pair('S12','last month new patients how many',''),
 pair('G01','branch wise collection last month','no verb at all'),
 pair('G04','cash how much online how much last month','two metrics, no conjunction'),
 pair('C02','last month collection vs previous month','relative vs relative'),
 pair('R01','which test we did most last month',''),
 pair('R02','doctor wise how many cases last month top 5','"doctor wise" = group by referrer'),
 pair('P04','last month billing out of that collection percentage how much',''),
 pair('X03','last month how many bills not fully paid',''),
 pair('N01','chintal last month how many tests','branch by name, lowercase'),
 pair('N12','last month how many cases through doctors',''),
 pair('D01','last month how many different patients',''),
 pair('P03','last month cancel percentage how much',''),
 pair('H15','last month how many bills zero payment',''),
];

// ── BEHAVIOURAL: where "matching SQL" is the WRONG scorer ────────────────────
export const BEHAV=[
 // ROUTING — must reach the diagnostic pipeline, not text-to-SQL
 {id:'B01',cls:'route-status', q:'business kaisa chal raha hai this month', want:{route:'STATUS'}},
 {id:'B02',cls:'route-diagnose', q:'why this month slow', want:{route:'DIAGNOSE'}},
 {id:'B03',cls:'route-diagnose', q:'collection why down this week', want:{route:'DIAGNOSE',metric:'revenue'}},
 // ROUTING TRAPS — a trigger word used innocently must NOT hijack the route
 {id:'B04',cls:'route-trap', q:'which tests are slow moving', want:{route:'SQL'},
   why:'"slow" is a DIAGNOSE trigger but this is a plain ranking question'},
 {id:'B05',cls:'route-trap', q:'how is our report TAT', want:{route:'SQL'},
   why:'"how is" trips the STATUS regex; the owner wants turnaround time'},
 {id:'B06',cls:'route-trap', q:'break down last month collection branch wise', want:{route:'SQL'},
   why:'"down" inside "break down"'},
 // NOT RECORDED — the honest answer is to say so and ask
 {id:'B07',cls:'not-recorded', q:'last month profit how much',
   want:{mustSay:/not record|does ?n[o']?t record|do(es)? ?n[o']?t (have|record|track|capture)|no cost|cost.{0,12}(is|are) ?n[o']?t|isn'?t recorded|nahi (hai|karte|record)/i, mustNotInvent:true},
   why:'no cost data exists anywhere in the schema'},
 {id:'B08',cls:'not-recorded', q:'outside lab tests par profit how much',
   want:{mustSay:/not record|labCost|lab cost|does ?n[o']?t record|do(es)? ?n[o']?t (have|record|track)|empty|zero of|no .*cost|OUT_OF_SCOPE|nahi/i, mustNotInvent:true},
   why:'TestOrder.labCost is populated on 0 of 30,057 rows'},
 {id:'B09',cls:'unknowable', q:'how many patients went to the lab across the road',
   want:{mustSay:/cannot|can'?t|no way to know|not something|only see|do(es)? ?n[o']?t have|OUT_OF_SCOPE|nahi/i, mustNotInvent:true}},
 {id:'B10',cls:'not-a-data-question', q:'kukatpally me new branch kholna chahiye kya',
   want:{mustSay:/cannot|can'?t decide|depends|would need|not a question the data|OUT_OF_SCOPE|nahi/i, mustNotInvent:true}},
 // JUDGEMENT WORDS — need a stated yardstick
 {id:'B11',cls:'judgement', q:'discount zyada de rahe hain kya',
   want:{mustNumber:true, mustSay:/compared?|benchmark|target|what counts as|threshold|typical|no target|gir raha|badh|%|mein/i}},
 // FALSE PREMISE
 {id:'B12',cls:'false-premise', q:'last week loss kyun hua', want:{checkPremise:true}},
 // MESSY INPUT
 {id:'B13',cls:'typos', q:'last mnth colection how mcuh', want:{route:'SQL', mustNumber:true}},
 {id:'B14',cls:'hinglish', q:'repeat patients kitne aate hain', want:{route:'SQL', mustNumber:true}},
 {id:'B15',cls:'fragment', q:'and kompally?', want:{needsContext:true}},
 {id:'B16',cls:'entity-trend', q:'ramaswamy ab bhi cases bhej raha hai kya',
   want:{mustNumber:true, mustCompare:true}, why:'"ab bhi" = still → two-period comparison'},
 {id:'B17',cls:'complaint', q:'patients complaint kar rahe hain report late aa rahi hai kitna bura hai',
   want:{mustNumber:true}},
];

// ── THE HIGHEST-STAKES QUESTION AN OWNER ASKS ────────────────────────────────
// "doctor wise referral amount how much" decides real money leaving the business every
// month. The rule is a HOUSE rule that appears nowhere in the schema:
//   PERCENTAGE commission = (pct of GROSS price) − this order's whole allocated share of
//   the bill discount, floored at 0; FIXED commissions ignore the discount entirely.
//   An order earns only once "delivered" (report finalized OR bill-only OR films-only).
//   Cancelled orders earn nothing. Discount is allocated across EVERY order on the bill
//   by price, largest-remainder rounded.
// No model can infer any of that. The control is computed in JS from the same rows the
// production payout service reads — so it is exact, not an approximation.
export const PAYOUT=[
 {id:'PY1', q:'doctor wise referral amount last month', dim:'doctor'},
 {id:'PY2', q:'last month total referral amount how much', dim:'total'},
 {id:'PY3', q:'ramaswamy ko last month kitna dena hai', dim:'one-doctor'},
];
