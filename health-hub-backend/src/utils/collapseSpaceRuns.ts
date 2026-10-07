/**
 * Word pads a line with non-breaking spaces to push the next sentence down.
 * That only works at Word's page width: at the report's width the run is a gap
 * that shoves the sentence right (Nova, USG abdomen, 6 Oct). Such a run, AFTER
 * text on the same line, becomes one space. A run at the START of a line is
 * deliberate indenting ("     F/S/O ACUTE APPENDICITIS") and is kept.
 * Same rule as the editor's paste (health-hub/src/lib/richText.ts).
 */
const RUN = /(?:&nbsp;| )(?:[ \t\r\n]*(?:&nbsp;| )){2,}[ \t\r\n]*/g;
const NEW_LINE = /^<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|blockquote)\b/i;

export function collapseSpaceRuns(html: string): string {
  let lineStart = true;
  return html.replace(/<[^>]*>|[^<]+/g, (tok) => {
    if (tok[0] === '<') {
      if (NEW_LINE.test(tok)) lineStart = true;
      return tok;
    }
    if (!lineStart) return tok.replace(RUN, ' ');
    const lead = tok.match(/^(?:&nbsp;| |[ \t\r\n])*/)![0];
    const rest = tok.slice(lead.length);
    if (rest.replace(/&nbsp;| /g, '').trim()) lineStart = false;
    return lead + rest.replace(RUN, ' ');
  });
}
