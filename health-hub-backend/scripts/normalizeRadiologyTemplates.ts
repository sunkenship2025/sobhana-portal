/**
 * One-time normalizer: bring radiology ClinicalPanel.narrativeTemplateHtml
 * in line with the LIS-standard radiology format.
 *
 * Two transformations, both idempotent:
 *
 *   1. Strip inline color styles (`color: #b22222`, `color="red"`, etc.) from
 *      every tag. Body text on radiology reports must be black; any prior
 *      maroon styling left over from the rich-text editor is removed.
 *
 *   2. Prepend `<p><strong>FINDINGS:</strong></p>` if the template body has
 *      no FINDINGS marker yet. Templates that already include FINDINGS are
 *      left alone.
 *
 * The script does NOT touch:
 *   - typos in the template body (those are clinical content; radiologists
 *     should fix them in the WYSIWYG editor),
 *   - finalized TestResult.textValue / TestResult.notes (historical reports
 *     stay as authored — only future reports use the new template).
 *   - non-radiology departments.
 *
 * Run:
 *   npx tsx scripts/normalizeRadiologyTemplates.ts                # dry run (default)
 *   npx tsx scripts/normalizeRadiologyTemplates.ts --apply        # write changes
 */

import prisma from '../src/lib/prisma';

const APPLY = process.argv.includes('--apply');

function stripInlineColor(html: string): string {
  // 1. Drop `color: ...` declarations inside any inline `style="..."` attr.
  let out = html.replace(/style="([^"]*)"/gi, (_match, body: string) => {
    const cleaned = body
      .split(';')
      .map(d => d.trim())
      .filter(d => d.length > 0 && !/^color\s*:/i.test(d))
      .join('; ');
    return cleaned.length > 0 ? `style="${cleaned}"` : '';
  });

  // 2. Drop legacy `color="..."` attributes on any tag (e.g. <font color="red">).
  out = out.replace(/\s+color="[^"]*"/gi, '');

  // 3. Collapse the now-empty `<font>` wrappers some editors leave behind.
  out = out.replace(/<font(\s+[^>]*)?>([\s\S]*?)<\/font>/gi, '$2');

  return out;
}

function hasFindingsHeader(html: string): boolean {
  // Match FINDINGS as a word (case-insensitive). Anchoring on `>` or whitespace
  // avoids matching inside other words.
  return /(>|\s|^)FINDINGS\s*:/i.test(html);
}

function prependFindingsHeader(html: string): string {
  return `<p><strong>FINDINGS:</strong></p>\n\n${html}`;
}

interface Change {
  panelId: string;
  panelName: string;
  displayName: string;
  strippedColor: boolean;
  addedFindingsHeader: boolean;
  before: string;
  after: string;
}

async function main() {
  const panels = await prisma.clinicalPanel.findMany({
    where: {
      department: { name: 'RADIOLOGY' },
      narrativeTemplateHtml: { not: null },
    },
    select: { id: true, name: true, displayName: true, narrativeTemplateHtml: true },
  });

  console.log(`Mode: ${APPLY ? 'APPLY (writing changes)' : 'DRY RUN (no DB writes)'}`);
  console.log(`Inspecting ${panels.length} radiology panels with templates.\n`);

  const changes: Change[] = [];

  for (const p of panels) {
    const before = p.narrativeTemplateHtml ?? '';
    const stripped = stripInlineColor(before);
    const colorRemoved = stripped !== before;

    let after = stripped;
    let headerAdded = false;
    if (!hasFindingsHeader(after)) {
      after = prependFindingsHeader(after);
      headerAdded = true;
    }

    if (after !== before) {
      changes.push({
        panelId: p.id,
        panelName: p.name,
        displayName: p.displayName,
        strippedColor: colorRemoved,
        addedFindingsHeader: headerAdded,
        before,
        after,
      });
    }
  }

  if (changes.length === 0) {
    console.log('All radiology templates are already normalized — nothing to do.');
    await prisma.$disconnect();
    return;
  }

  console.log(`Would update ${changes.length} template(s):\n`);
  for (const c of changes) {
    const flags = [
      c.strippedColor ? 'stripped color' : null,
      c.addedFindingsHeader ? 'added FINDINGS header' : null,
    ].filter(Boolean).join(', ');
    console.log(`  • ${c.panelName} (${c.displayName}) — ${flags}`);
  }

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to commit changes.');
    await prisma.$disconnect();
    return;
  }

  console.log('\nApplying changes...');
  let written = 0;
  for (const c of changes) {
    await prisma.clinicalPanel.update({
      where: { id: c.panelId },
      data: { narrativeTemplateHtml: c.after },
    });
    written++;
  }
  console.log(`Done. Updated ${written} template(s).`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
