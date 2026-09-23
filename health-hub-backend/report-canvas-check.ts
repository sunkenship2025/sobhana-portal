/**
 * The Report Builder canvas must offer somewhere to click for every region it
 * lets you edit.
 *
 * An imaging narrative with no template yet renders as a genuinely empty div.
 * It was wired contenteditable, so it WORKED — but it had zero height and no
 * text, so the canvas showed blank paper and the template was unreachable
 * unless you guessed where the void was. This asserts the precondition (the
 * div really is empty) and the fix (an :empty placeholder, plus the hint that
 * fills it), so a change to either selector fails here instead of on screen.
 *
 *   npx tsx report-canvas-check.ts
 */
import 'dotenv/config';
import { buildDraftPanelSnapshot } from './src/services/reportSnapshotService';
import { renderReportHtml } from './src/services/reportRendererService';
import { injectReportEditor } from './src/routes/clinicalPanels';

let failures = 0;
const assert = (label: string, cond: boolean) => {
  if (cond) console.log(`ok   ${label}`);
  else { failures += 1; console.log(`FAIL ${label}`); }
};

async function main() {
  const snapshot = await buildDraftPanelSnapshot({
    branch: { id: 'b', name: 'Sobhana - Chintal', code: 'CNT', address: null, phone: null },
    department: {
      id: 'd', name: 'ULTRASOUND', reportHeaderText: 'DEPARTMENT OF ULTRASOUND',
      displayOrder: 0, showLabIncharge: true,
    },
    panel: {
      code: 'USGCHECK',
      label: 'High-Resolution Ultrasound of soft tissue',
      layoutType: 'IMAGING_NARRATIVE',
      sampleType: null,
      panelMethodText: null,
      panelMethodItalic: false,
      showSubgroups: false,
      showInterpretation: false,
      subgroupMethods: null,
      subgroupTableOverrides: null,
      valueDisplayPrefix: null,
      spacedDefinitionsGap: 0,
      comments: null,
      interpretation: null,
    },
    // One narrative test, no saved template — exactly the state on a new report.
    items: [{ testDefinition: { code: 'USGCHECK', name: 'High-Resolution Ultrasound of soft tissue' } }],
    patient: undefined,
  } as any);

  const plain = renderReportHtml(snapshot, { profile: 'screen', baseUrl: 'http://localhost:3000' });

  // The precondition: with no template, the editable region has no content at all.
  assert(
    'an untemplated narrative renders as an EMPTY div',
    /<div class="imaging-narrative">\s*<\/div>/.test(plain),
  );

  // The real report must never grow a builder affordance.
  assert('the plain report carries no canvas hint', !plain.includes('data-rb-hint'));
  assert('the plain report carries no :empty placeholder', !plain.includes('rb-richedit:empty'));

  // The canvas must. Both halves are needed: the rule that draws it, and the
  // attribute that gives it words.
  const canvas = injectReportEditor(plain);
  assert('canvas defines the :empty placeholder', canvas.includes('.rb-richedit:empty::before'));
  assert('placeholder reads its text from the hint', canvas.includes("content:attr(data-rb-hint)"));
  assert("narrative regions are hinted '+ Add template'", canvas.includes("'+ Add template'"));
  assert('comments regions are hinted', canvas.includes("'+ Add comments'"));
  assert('interpretation regions are hinted', canvas.includes("'+ Add interpretation'"));
  assert(
    'the hint is actually applied to the element',
    /el\.setAttribute\('data-rb-hint',hint\)/.test(canvas),
  );
  // An empty div is zero-height; without this the placeholder has nowhere to sit.
  assert('an empty region is given height to be clickable', canvas.includes('.rb-richedit:empty{cursor:text;min-height'));

  console.log(failures === 0 ? '\nall clean' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
