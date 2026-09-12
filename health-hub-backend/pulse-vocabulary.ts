/**
 * WHAT THE OWNER SAYS THAT PULSE CANNOT LOOK UP.
 *
 * Before building a learning loop, find out whether there is anything to learn. The question is
 * not "would a learned catalogue be nice" — it is whether the missing vocabulary is twenty
 * phrases or a thousand. Twenty should be typed by hand into SYNONYMS, which is less code and
 * less risk than any promotion pipeline; a thousand and growing is the case for building one.
 *
 * This answers it from traffic that already happened:
 *   which phrases in real questions the concept index cannot resolve
 *   what the queries that WORKED actually filtered on instead
 *   whether the same phrase lands on the same literal every time
 *
 * The co-occurrence is deliberately dumb — a phrase and a literal appearing in the same turn is
 * not proof they mean each other. It is a candidate list for a human to read, not a mapping to
 * install. Reading it that way is the point: an automatic promotion built on this signal would
 * be learning from coincidence.
 *
 *   npx ts-node --transpile-only pulse-vocabulary.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { ensureKnowledge, resolveTerm } from './src/services/pulse/knowledge';

const db = new PrismaClient();
const J = (v: any) => { if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } } return v; };

/* The first version of this guessed: every 1-3 word phrase the index could not resolve, against
   every literal the turn's SQL happened to filter on. It surfaced "improve", "doing", "we have"
   and co-occurrences with code='CNT', which appears in nearly every query. Co-occurrence is not
   evidence of meaning, and an instrument that reports noise gets skimmed and then trusted.

   The precise signal was there all along: the moments Pulse ITSELF reports a lookup failing. The
   resolve tool records exactly which terms it probed and which returned nothing, and an answer
   that tells the owner a concept does not exist is the failure we care about, stated in the
   product's own words. No guessing required. */

/** The analyst telling the owner something is not recorded. This is the failure class that made
 *  Pulse deny three enum values the owner had just named. */
const DENIAL = /not a (known|defined|recorded) concept|does not exist|no concept|not a concept|never resolved|is not defined|no such|not recorded|does not record|no figure to (report|quote)|naming gap|could not establish (how|what|the)/i;

(async () => {
  await ensureKnowledge();
  const rows = await db.auditLog.findMany({
    where: { entityType: { in: ['Pulse', 'PulseTrace'] } }, orderBy: { createdAt: 'asc' }, take: 4000,
    select: { entityType: true, newValues: true } });
  const traces = rows.filter((r) => r.entityType === 'PulseTrace').map((r) => J(r.newValues)).filter((t: any) => t?.v === 1) as any[];
  const chats  = rows.filter((r) => r.entityType === 'Pulse').map((r) => J(r.newValues)).filter((c: any) => c?.q) as any[];

  // ── 1. terms the resolve tool was asked for and could not ground ────────────────────────
  const missed = new Map<string, { n: number; qs: Set<string> }>();
  let probes = 0;
  for (const t of traces) for (const e of t.executed || []) {
    if (e.tool !== 'resolve') continue;
    // detail carries the terms actually probed; label is the analyst's description of the step
    for (const term of String(e.detail || '').split(/,\s*/).map((x) => x.trim()).filter(Boolean)) {
      probes++;
      if (resolveTerm(term).length) continue;         // resolvable TODAY — already fixed
      const m = missed.get(term.toLowerCase()) || { n: 0, qs: new Set<string>() };
      m.n++; m.qs.add(String(t.question).slice(0, 64)); missed.set(term.toLowerCase(), m);
    }
  }

  // ── 2. answers that told the owner something does not exist ─────────────────────────────
  const denials = chats.filter((c) => DENIAL.test(String(c.text || '')));

  console.log(`${traces.length} traces · ${chats.length} answered turns · ${probes} terms probed via resolve()\n`);

  console.log('TERMS PROBED AND STILL UNRESOLVABLE TODAY');
  const un = [...missed.entries()].sort((a, b) => b[1].n - a[1].n);
  if (!un.length) console.log('  (none — every term ever probed now resolves)');
  for (const [term, m] of un.slice(0, 25)) console.log(`  ${String(m.n).padStart(3)}x  "${term}"   e.g. ${[...m.qs][0]}`);

  console.log(`\nANSWERS THAT DENIED SOMETHING EXISTS  —  ${denials.length}/${chats.length} turns`);
  for (const c of denials.slice(-14)) {
    const fixed = String(c.q).toLowerCase().split(/[^a-z0-9]+/).filter((w: string) => w.length > 3)
      .some((w: string) => resolveTerm(w).length);
    console.log(`  ${fixed ? 'RESOLVES NOW' : 'STILL BLIND '}  Q: ${String(c.q).replace(/\s+/g, ' ').slice(0, 66)}`);
    console.log(`                 A: ${String(c.text).replace(/\s+/g, ' ').slice(0, 100)}`);
  }
  await db.$disconnect();
})();
