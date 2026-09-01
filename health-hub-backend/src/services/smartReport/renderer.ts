/**
 * Smart Report HTML. Mirrors smart-report-prototype.html exactly.
 *
 * Page numbers are COMPUTED, never hardcoded: Health Essentials is omitted
 * without height/weight, finding cards paginate, and the advisory disappears on
 * a critical result — so the count varies per patient.
 */
import {
  BODY_PATH, ICON_SYMBOLS, REPORT_CSS, ART_YOGA,
  ART_COVER_MALE, ART_COVER_FEMALE, ART_COVER_CHILD, getBrandLogoDataUri,
} from './assets';
import { iconFor } from './icons';
import { computeEssentials } from './essentials';
import { BAND_LABEL } from './score';
import type { Finding, PanelRollup, QualitativeRow, ReferredOnly, Counts, ScoreBand } from './types';
import type { GeneratedContent } from './validate';

const CARDS_PER_PAGE = 6;

export interface RenderInput {
  patient: { name: string; genderLabel: string; ageDisplay: string; patientNumber: string; heightCm: number | null; weightKg: number | null; ageYears: number | null; sex: string };
  visit: { billNumber: string; branchName: string; branchAddress: string | null; branchPhone: string | null; reportDate: string; collectedAt?: string | null };
  brand: { tagline: string; website: string; accent: string; disclaimer: string | null };
  packageName: string;
  score: number;
  band: ScoreBand;
  counts: Counts;
  hasCritical: boolean;
  findings: Finding[];
  qualitative: QualitativeRow[];
  referred: ReferredOnly[];
  panels: PanelRollup[];
  followUps: { productCode: string; productName: string; weeks: number }[];
  content: GeneratedContent;
  advisorySuppressed: boolean;
  essentialsEnabled: boolean;
  qrDataUrl?: string;
}

const esc = (v: unknown) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const num = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

export function renderSmartReportHtml(d: RenderInput): string {
  const pages: string[] = [];
  pages.push(cover(d));
  pages.push(pageAnalysis(d));

  const ess = d.essentialsEnabled && d.patient.heightCm && d.patient.weightKg && d.patient.ageYears !== null
    ? computeEssentials(d.patient.heightCm, d.patient.weightKg, d.patient.ageYears, d.patient.sex)
    : null;
  if (ess) pages.push(pageEssentials(d, ess));

  // The final findings page also carries the "reported in words" table and the
  // referred-separately note, so it holds fewer cards or the page overflows.
  // Cards are then spread evenly rather than filling early pages and leaving a stub.
  const lastCap = d.qualitative.length || d.referred.length ? CARDS_PER_PAGE - 2 : CARDS_PER_PAGE;
  const chunks: Finding[][] = [];
  if (d.findings.length === 0) {
    chunks.push([]);
  } else if (d.findings.length <= lastCap) {
    chunks.push(d.findings);
  } else {
    const pageCount = 1 + Math.ceil((d.findings.length - lastCap) / CARDS_PER_PAGE);
    const per = Math.ceil(d.findings.length / pageCount);
    for (let i = 0; i < d.findings.length; i += per) chunks.push(d.findings.slice(i, i + per));
  }

  chunks.forEach((chunk, i) => pages.push(pageFindings(d, chunk, i, chunks.length)));

  pages.push(pageSummary(d));
  if (!d.advisorySuppressed) pages.push(pageAdvisory(d));

  const total = pages.length - 1; // cover is unnumbered
  const numbered = pages.map((p, i) =>
    i === 0 ? p : p.replace('__PAGENO__', `${String(i).padStart(2, '0')} / ${String(total).padStart(2, '0')}`),
  );

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Smart Health Report</title><style>${REPORT_CSS}
${logoCss()}
:root{--g1:${esc(d.brand.accent)}}</style></head><body>
<svg width="0" height="0" style="position:absolute"><defs>${ICON_SYMBOLS}</defs></svg>
${numbered.join('\n')}
</body></html>`;
}

/** Below this age the cover shows the child figure rather than an adult one. */
const CHILD_ART_MAX_AGE = 13;

/**
 * Sex comes from the frozen snapshot, so this cannot drift from the rest of the
 * report. Unknown or unrecorded sex falls back to the male figure rather than
 * omitting the art, which would leave a hole in the cover.
 */
export function coverArt(d: { patient: { sex: string | null; ageYears: number | null } }):
  { kind: 'male' | 'female' | 'child'; svg: string } {
  if (d.patient.ageYears !== null && d.patient.ageYears < CHILD_ART_MAX_AGE) {
    return { kind: 'child', svg: ART_COVER_CHILD };
  }
  return d.patient.sex === 'F'
    ? { kind: 'female', svg: ART_COVER_FEMALE }
    : { kind: 'male', svg: ART_COVER_MALE };
}

const logoImg = () =>
  getBrandLogoDataUri()
    ? '<div class="brandlogo" role="img" aria-label="Sobhana Diagnostic Centre"></div>'
    : '';

/** Injected once, after REPORT_CSS, so the base64 appears a single time. */
const logoCss = () => {
  const uri = getBrandLogoDataUri();
  return uri ? `.brandlogo{background:url("${uri}") no-repeat left center;background-size:contain}` : '';
};

// ---------------------------------------------------------------- chrome
function head(d: RenderInput): string {
  return `<div class="topbar"></div>
  <div class="phead">
    <div class="logo">${logoImg()}
      <div><span>${esc(d.brand.tagline)}</span></div></div>
    <div class="web"><span class="globe"><svg class="hi" style="color:#185484" width="14" height="14"><use href="#i-globe"/></svg></span>${esc(d.brand.website)}</div>
  </div>
  <div class="strip">
    <div><span>Name</span><b>${esc(d.patient.name)}</b></div>
    <div><span>Patient ID</span><b>${esc(d.patient.patientNumber)}</b></div>
    <div><span>Basic Info.</span><b>${esc(d.patient.genderLabel)} | ${esc(d.patient.ageDisplay)}</b></div>
    <div><span>Report Date</span><b>${esc(d.visit.reportDate)}</b></div>
  </div>`;
}
const foot = (left: string) =>
  `<div class="pfoot"><span>${esc(left)}</span><b>__PAGENO__</b></div>`;

const addr = (d: RenderInput) =>
  [d.visit.branchAddress, d.visit.branchPhone].filter(Boolean).join(' · ');

// ---------------------------------------------------------------- cover
function cover(d: RenderInput): string {
  return `<section class="page">
  <div class="cover">
    <div class="crosses">
      <div class="cx" style="width:34px;height:34px;top:0;left:96px"></div>
      <div class="cx" style="width:26px;height:26px;top:14px;left:150px"></div>
      <div class="cx" style="width:44px;height:44px;top:46px;left:186px"></div>
      <div class="cx" style="width:30px;height:30px;top:74px;left:118px"></div>
      <div class="cx g" style="width:52px;height:52px;top:132px;left:150px"></div>
    </div>
    <div class="logo">${logoImg()}
      <div><span>${esc(d.brand.tagline)}</span></div></div>
    <div class="script">Smart</div>
    <h1>HEALTH REPORT</h1>
    <div class="aibadge">&#10022; AI-assisted summary</div>
    <div class="who"><div class="lb">Patient:</div><b>${esc(d.patient.name)}</b>
      <div class="mi">${esc(d.patient.genderLabel)} | ${esc(d.patient.ageDisplay)}</div></div>
    <div class="coverart v-${coverArt(d).kind}">${coverArt(d).svg}</div>
  </div>
  <div class="coverfoot">
    <div class="addr"><b>${esc(d.visit.branchName)}</b>${esc(d.visit.branchAddress ?? '')}${d.visit.branchPhone ? `<br>Mob: ${esc(d.visit.branchPhone)}` : ''}</div>
    ${d.qrDataUrl ? `<div class="qrbox"><img class="qr" src="${d.qrDataUrl}" alt=""><span>Scan QR code to<br>download report</span></div>` : ''}
  </div>
</section>`;
}

// ---------------------------------------------------------------- 01
function pageAnalysis(d: RenderInput): string {
  const ess = d.patient.heightCm && d.patient.weightKg && d.patient.ageYears !== null
    ? computeEssentials(d.patient.heightCm, d.patient.weightKg, d.patient.ageYears, d.patient.sex)
    : null;

  const metrics = ess ? `<div class="metrics">
      <div class="metric m-w"><div class="mt">Weight</div>
        <div class="mv">${num(d.patient.weightKg as number)} <small>kg</small></div></div>
      <div class="metric m-h"><div class="mt">Height</div>
        <div class="mv">${num(d.patient.heightCm as number)} <small>cm</small></div></div>
      <div class="metric m-b"><div class="mt">BMI - (18.5 to 24.9)</div>
        <div class="mv">${ess.bmi} ${ess.bmiHigh ? `<em>(${ess.bmiBand} &#8599;)</em>` : `<small>(${ess.bmiBand})</small>`}</div></div>
    </div>` : '';

  const critical = d.hasCritical
    ? `<div style="background:#FCE8E6;border-left:4px solid #C5221F;border-radius:0 10px 10px 0;padding:13px 16px;margin-bottom:14px">
        <b style="color:#8F1A18;font-size:14px">One of your results needs urgent attention</b>
        <p style="margin:4px 0 0;font-size:12.5px;color:#5F2120">Please contact the centre today on ${esc(d.visit.branchPhone ?? 'the number below')}. Do not wait for your next appointment.</p>
      </div>` : '';

  const tiles = d.panels.map((p) => {
    const ic = iconFor(p.name, p.icon);
    const pills = [
      p.withinRange ? `<span class="pill p-ok">${p.withinRange} Normal</span>` : '',
      p.outOfRange ? `<span class="pill p-bad">${p.outOfRange} Abnormal</span>` : '',
      p.borderline ? `<span class="pill p-bor">${p.borderline} Borderline</span>` : '',
      p.notScored && !p.withinRange && !p.outOfRange ? `<span class="pill p-pen">Descriptive</span>` : '',
    ].join('');
    return `<div class="tile"><span class="ico"><svg class="hi" style="color:${ic.tint}" width="26" height="26"><use href="#${ic.id}"/></svg></span>
      <div class="tx"><b>${esc(p.name)}</b><div class="bd">${pills}</div></div></div>`;
  });
  const half = Math.ceil(tiles.length / 2);

  return `<section class="page">${head(d)}
  <div class="content">
    <h1>Personalised Health Analysis</h1>
    <p class="sub">A Comprehensive Overview of your Health Metrics and Goals.</p>
    ${critical}${metrics}
    <div class="tscore">
      <h3>Test Score <span class="aitag">&#10022; AI WRITTEN</span></h3>
      <p>${esc(d.content.testScore.paragraph)}</p>
      <p class="scorenote">This score describes the results measured at this visit, not your overall
        health, and it is not a diagnosis. It cannot know about any medicine or treatment you are
        already taking, so a result kept steady by treatment still counts as outside its range.
        Please read it together with your doctor.</p>
    </div>
    <div class="bodywrap">
      <div class="tcol">${tiles.slice(0, half).join('')}</div>
      <div class="figure"><svg class="bodyfig" viewBox="0 0 970 2200"><g transform="translate(41.5,630.92)"><path d="${BODY_PATH}" fill="#F3C69C"/></g></svg></div>
      <div class="tcol">${tiles.slice(half).join('')}</div>
    </div>
  </div>
  ${foot(addr(d))}
</section>`;
}

// ---------------------------------------------------------------- 02
function pageEssentials(d: RenderInput, e: ReturnType<typeof computeEssentials>): string {
  return `<section class="page">${head(d)}
  <div class="content">
    <h1>Health Essentials Insights</h1>
    <p class="sub">Calorie, Nutrition and Lifestyle Recommendations to Keep you Healthy.</p>
    <h2>Daily Health Essentials</h2>
    <div class="ess">
      <div class="ecard"><b class="tt" style="display:block">Daily Water Intake</b>
        <p>Based on your body weight and activity level.</p><div class="val">${e.waterL}L</div></div>
      <div class="ecard"><b class="tt" style="display:block">Sleep's Intake</b>
        <p>Quality sleep boosts metabolism and aids recovery.</p><div class="val">${e.sleep}</div></div>
      <div class="ecard"><b class="tt">Energy Expenditure</b>
        <p style="margin-top:4px">No. of calories your body needs to maintain your weight.</p>
        <div class="three">
          <div><span>Less Active</span><b>${e.tdee.sedentary.toLocaleString()} Cal</b></div>
          <div><span>Active</span><b>${e.tdee.active.toLocaleString()} Cal</b></div>
          <div><span>Very Active</span><b>${e.tdee.veryActive.toLocaleString()} Cal</b></div>
        </div></div>
    </div>
    <div class="infobox"><b>Did You Know? Your Body Follows a Rhythm.</b>
      <p>Hydration, meals, and even sleep work best when aligned with your body's internal clock.
        Start your day with water, eat within 90 mins of waking, and aim to sleep before 11 PM.</p></div>
    <h2>Macronutrients &amp; More</h2>
    <div class="macros">
      <div class="ecard" style="min-height:110px"><b class="tt" style="display:block">Protein</b>
        <p>Supports muscle repair; eat lean meats, beans, or dairy.</p><div class="val" style="font-size:20px">${e.macros.protein}</div></div>
      <div class="ecard" style="min-height:110px"><b class="tt" style="display:block">Carbohydrates</b>
        <p>Primary energy source; eat whole grains &amp; fibre foods.</p><div class="val" style="font-size:20px">${e.macros.carbs}</div></div>
      <div class="ecard" style="min-height:110px"><b class="tt" style="display:block">Fats</b>
        <p>Essential for hormone health; eat healthy fats like nuts.</p><div class="val" style="font-size:20px">${e.macros.fats}</div></div>
      <div class="ecard" style="min-height:110px"><b class="tt" style="display:block">Fiber</b>
        <p>Aids digestion &amp; overall health; don't skip fruits and veggies.</p><div class="val" style="font-size:20px">${e.macros.fiber}</div></div>
    </div>
    <div class="goalbox"><div class="goalrow"><b>Calorie Intake<br>Based on Goals</b>
      <div><span>Weight Loss</span><b>${e.goals.loss.toLocaleString()} Cal</b></div>
      <div><span>Weight Gain</span><b>${e.goals.gain.toLocaleString()} Cal</b></div>
      <div><span>Weight Maintenance</span><b>${e.goals.maintain.toLocaleString()} Cal</b></div></div>
      <hr><p>These are general targets from your height, weight, age and sex — not from your test results.</p></div>
  </div>
  ${foot(addr(d))}
</section>`;
}

// ---------------------------------------------------------------- 03..N
function pageFindings(d: RenderInput, chunk: Finding[], idx: number, of: number): string {
  const last = idx === of - 1;
  const cards = chunk.map((f) => card(f)).join('');
  const words = last && d.qualitative.length ? qualitativeTable(d) : '';
  const note = last && d.referred.length
    ? `<div style="background:#F4F6F8;border-radius:10px;padding:10px 14px;margin-top:11px;font-size:10.5px;color:#5F6368;line-height:1.6">
        <b style="color:#1A1A1A">Reported separately:</b> ${esc(d.referred.map((r) => r.name).join(', '))} —
        ${d.referred.some((r) => r.reason === 'EXTERNAL_UPLOAD') ? "attached to your full report as-is. We do not re-interpret another centre's report." : 'described in words on your full report for your doctor to read.'}
      </div>` : '';
  return `<section class="page">${head(d)}
  <div class="content">
    <h1>Detailed Test Insights</h1>
    <p class="sub">${idx === 0 ? 'Every result outside your reference range, explained in plain language.' : 'Continued from the previous page.'}</p>
    ${cards}${words}${note}
  </div>
  ${foot('Not a diagnosis. Please discuss these results with your doctor.')}
</section>`;
}

function card(f: Finding): string {
  const ic = iconFor(f.panel, null);
  const cls = f.status === 'LOW' || f.status === 'CRITICAL_LOW'
    ? (f.magnitude === 'SLIGHT' ? 'p-mild' : 'p-pen')
    : (f.magnitude === 'SLIGHT' ? 'p-mild' : 'p-bad');
  const refText = f.refLow !== null && f.refHigh !== null
    ? `Reference ${num(f.refLow)} – ${num(f.refHigh)}${f.unit ? ' ' + esc(f.unit) : ''}`
    : f.refHigh !== null ? `Reference &lt; ${num(f.refHigh)}${f.unit ? ' ' + esc(f.unit) : ''}`
    : f.refLow !== null ? `Reference &gt; ${num(f.refLow)}${f.unit ? ' ' + esc(f.unit) : ''}` : '';
  const marker = markerPct(f);
  const trend = f.priorValue !== null
    ? `<span class="ftrend">${f.value > f.priorValue ? '&#8593;' : '&#8595;'} from ${num(f.priorValue)}${f.unit ? ' ' + esc(f.unit) : ''} on ${esc(f.priorDate ?? '')}</span>` : '';
  return `<div class="fcard"><div class="fhead">
      <span class="ico"><svg class="hi" style="color:${ic.tint}" width="18" height="18"><use href="#${ic.id}"/></svg></span>
      <div class="nm"><b>${esc(f.name)}</b><span>${esc(f.panel)}</span></div>
      <div class="rv"><b>${num(f.value)}</b> <small>${esc(f.unit ?? '')}</small><br><span class="pill ${cls}">${esc(f.label)}</span></div></div>
    <div class="gauge"><div class="gtrack"><i class="lo"></i><i class="no"></i><i class="hi"></i></div>
      <div class="gmark"><i style="left:${marker}%"></i></div>
      <div class="glabels"><span>Low</span><span>${refText}</span><span>High</span></div></div>
    ${f.explanation ? `<p>${esc(f.explanation)}</p>` : ''}${trend}</div>`;
}

/** Track is lo(1fr) | normal(1.6fr) | hi(1fr): normal spans 27.8%–72.2%. */
function markerPct(f: Finding): number {
  const lo = 27.8, hi = 72.2;
  if (f.status === 'HIGH' || f.status === 'CRITICAL_HIGH') {
    return Math.min(96, hi + Math.min(1, f.deviation / 0.6) * (96 - hi));
  }
  if (f.status === 'LOW' || f.status === 'CRITICAL_LOW') {
    return Math.max(4, lo - Math.min(1, f.deviation / 0.6) * (lo - 4));
  }
  return (lo + hi) / 2;
}

function qualitativeTable(d: RenderInput): string {
  const rows = d.qualitative.slice(0, 8).map((q, i, a) => {
    const b = i === a.length - 1 ? '' : 'border-bottom:1px solid #F3F5F7;';
    return `<tr><td style="padding:5px 8px;${b}">${esc(q.name)}</td>
      <td style="padding:5px 8px;${b}font-weight:600">${esc(q.value)}</td>
      <td style="padding:5px 8px;${b}color:#7A8189">${esc(q.expected ?? '—')}</td></tr>`;
  }).join('');
  const th = 'text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.6px;color:#9AA0A6;font-weight:700;padding:6px 8px;border-bottom:1px solid #E8EAED';
  return `<h2 style="font-size:13.5px;font-weight:700;margin:12px 0 3px">Results reported in words</h2>
    <p style="font-size:10.5px;color:#7A8189;margin:0 0 7px">Described in words rather than numbers, so they carry no range to score against and are not part of your health score.</p>
    <table style="width:100%;border-collapse:collapse;font-size:11.5px">
      <thead><tr><th style="${th}">Parameter</th><th style="${th}">Your result</th><th style="${th}">Usually expected</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
}

// ---------------------------------------------------------------- summary
function pageSummary(d: RenderInput): string {
  const trended = d.findings.filter((f) => f.priorValue !== null).slice(0, 6);
  const table = trended.length ? `<h2>Key numbers compared with your last visit</h2>
    <table class="trendtab"><thead><tr><th>Parameter</th><th style="text-align:right">Previous</th>
      <th style="text-align:right">Now</th><th>Unit</th><th style="text-align:right">Change</th></tr></thead><tbody>
      ${trended.map((f) => {
        const up = f.value > (f.priorValue as number);
        const delta = Math.round(Math.abs(f.value - (f.priorValue as number)) * 100) / 100;
        return `<tr><td>${esc(f.name)}</td><td class="v">${num(f.priorValue as number)}</td>
          <td class="v">${num(f.value)}</td><td class="u">${esc(f.unit ?? '')}</td>
          <td class="s ${up ? 'up' : 'down'}">${up ? '&#8593;' : '&#8595;'} ${delta}</td></tr>`;
      }).join('')}</tbody></table>
    <p style="font-size:10.2px;color:#9AA0A6;margin:6px 0 0">Only parameters measured in the same unit at both visits are compared. An arrow shows the direction of change, not whether it is good or bad.</p>` : '';

  const attention = d.findings.slice(0, 5)
    .map((f) => `<li>${esc(f.name)} is ${esc(f.label.toLowerCase())} at ${num(f.value)}${f.unit ? ' ' + esc(f.unit) : ''}</li>`).join('');

  return `<section class="page">${head(d)}
  <div class="content">
    <h1>Report Summary</h1>
    <p class="sub">Where you stand today${trended.length ? ', and how it compares with your last visit' : ''}.</p>
    <div class="goalbox" style="margin-top:0">
      <div class="goalrow" style="grid-template-columns:1.15fr repeat(4,1fr)">
        <b>Test Score<br>${d.hasCritical ? 'Not scored' : `${d.score} / 100`}</b>
        <div><span>Outside range</span><b style="color:#C5221F">${d.counts.outOfRange}</b></div>
        <div><span>Borderline</span><b style="color:#96601A">${d.counts.borderline}</b></div>
        <div><span>Within range</span><b style="color:#1E8E3E">${d.counts.withinRange}</b></div>
        <div><span>Not scored</span><b style="color:#9AA0A6">${d.counts.shownNotScored + d.counts.referredOnly}</b></div>
      </div><hr>
      <p>${d.hasCritical
        ? 'One of your results needs urgent attention, so we have not reduced this report to a single number. Please contact the centre today.'
        : `The score starts at 100 and falls with how many of the results measured today sit outside
        their range and how far outside they are. Your most abnormal single result also sets a limit
        on the score, so one serious finding is never cancelled out by many normal ones. It is not a
        grade, a diagnosis, or a prediction. ${esc(BAND_LABEL[d.band])}.`}</p>
    </div>
    ${table}
    ${attention ? `<h2>Worth discussing with your doctor</h2>
      <div class="sumgrid"><div class="sumcard s-watch"><h3>Results outside range</h3><ul>${attention}</ul></div>
      <div class="sumcard s-good"><h3>What this report is</h3><ul>
        <li>An explanation of your lab results in plain language</li>
        <li>Not a diagnosis, and not a substitute for your doctor</li>
        <li>Your signed laboratory report remains the official document</li>
      </ul></div></div>` : ''}
  </div>
  ${foot(addr(d))}
</section>`;
}

// ---------------------------------------------------------------- advisory
function pageAdvisory(d: RenderInput): string {
  const blocks = (list: GeneratedContent['advisory']['dietBlocks']) => list.map((b) => `
    <div class="blk"><b>${esc(b.heading)}</b>
      ${(b.dos ?? []).map((x) => `<div class="do">${esc(x)}</div>`).join('')}
      ${(b.donts ?? []).map((x) => `<div class="no">${esc(x)}</div>`).join('')}</div>`).join('');

  const reasons = new Map(d.content.advisory.followUpReasons.map((r) => [r.productCode, r.reason]));
  const future = d.followUps.length ? `<div class="future">
      <div class="futureart">${ART_YOGA}</div><div><h3>Suggested Future Tests</h3>
      ${d.followUps.map((f) => `<div class="ln"><b>${esc(f.productName)} ${f.weeks === 0 ? '(now)' : `(after ${f.weeks} weeks)`}</b>${reasons.get(f.productCode) ? ` - ${esc(reasons.get(f.productCode) as string)}` : ''}</div>`).join('')}
      </div></div>` : '';

  const disclaimer = d.brand.disclaimer ?? `This summary was prepared automatically from your laboratory results. The values, reference ranges and status labels come from your signed report; the health summary and this advisory page are written by an AI assistant and checked against those values. It does not diagnose any condition, does not recommend any medicine, and does not replace a consultation. <b>If you are already being treated for a condition, your doctor's targets for you may differ from the general ranges used here.</b>${d.visit.branchPhone ? ` If any result worries you, call us on ${esc(d.visit.branchPhone)}.` : ''}`;

  return `<section class="page">${head(d)}
  <div class="content">
    <h1>Health Advisory <span class="aitag">&#10022; AI WRITTEN</span></h1>
    <p class="sub">Diet and Lifestyle Recommendations Based Upon Your Results</p>
    <div class="advgrid">
      <div class="adv a-diet"><h3>Suggested Diet</h3>${blocks(d.content.advisory.dietBlocks)}</div>
      <div class="adv a-life"><h3>Suggested Lifestyle</h3>${blocks(d.content.advisory.lifestyleBlocks)}</div>
    </div>
    ${future}
    <div class="disclaim"><b>Please read.</b> ${disclaimer}</div>
  </div>
  ${foot(addr(d))}
</section>`;
}
