/**
 * RUN THE BENCHMARK THE MOMENT THERE IS CREDIT TO RUN IT.
 *
 * The build is verified on every side of the model and unverified on the model itself, and that
 * gap closes with one paid command. Leaving it to be remembered is how a build stays unverified
 * for forty-one commits — which is exactly what happened.
 *
 * This waits for the account to come back, runs the suites in cost order, and writes the result
 * where it can be read later. It spends nothing while waiting: the probe is a four-token call
 * that fails with 402 until it doesn't.
 *
 *   npm run pulse:when-funded              wait up to 24h, then adversarial + regression + calc
 *   npm run pulse:when-funded -- --hours 2 give up sooner
 *   npm run pulse:when-funded -- --now     skip the wait, fail loudly if still broke
 */
import 'dotenv/config';
import { spawn } from 'child_process';
import { appendFileSync, writeFileSync } from 'fs';

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? (process.argv[i + 1] ?? 'true') : d;
};
const HOURS = Number(arg('hours', '24'));
const NOW = process.argv.includes('--now');
const LOG = 'pulse-bench-result.txt';

async function funded(): Promise<true | string> {
  const key = (process.env.SMART_REPORT_LLM_API_KEY || '').trim().replace(/^["']|["']$/g, '');
  const base = (process.env.SMART_REPORT_LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
  if (!key) return 'no API key set';
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: process.env.PULSE_LLM_MODEL || 'deepseek-chat',
        messages: [{ role: 'user', content: 'hi' }], max_tokens: 4 }),
    });
    return r.ok ? true : `${r.status} ${(await r.text()).slice(0, 80)}`;
  } catch (e: any) { return String(e?.message || e).slice(0, 80); }
}

const run = (file: string) => new Promise<string>((resolve) => {
  let out = '';
  const p = spawn('npx', ['ts-node', '--transpile-only', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  const take = (b: Buffer) => { const s = b.toString(); out += s; process.stdout.write(s); };
  p.stdout.on('data', take); p.stderr.on('data', take);
  p.on('close', () => resolve(out));
});

(async () => {
  const deadline = Date.now() + HOURS * 3600_000;
  let why = await funded();
  if (why !== true && !NOW) {
    console.log(`waiting for credit — checking every 5 minutes for up to ${HOURS}h. Currently: ${why}`);
    while (why !== true && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5 * 60_000));
      why = await funded();
    }
  }
  if (why !== true) {
    console.error(`\n  still no credit after ${NOW ? 'one check' : `${HOURS}h`}: ${why}\n  nothing was run, and no score is reported.\n`);
    process.exit(2);
  }

  console.log('\n  credit available — running the suites in cost order\n');
  writeFileSync(LOG, `pulse benchmark · ${new Date().toISOString()}\n\n`);
  for (const f of ['pulse-calc.ts', 'pulse-regression.ts', 'pulse-adversarial.ts']) {
    console.log(`\n──── ${f} ────\n`);
    const out = await run(f);
    const tail = out.split('\n').filter((l) => /clean|pass|answered|×/.test(l)).slice(-8).join('\n');
    appendFileSync(LOG, `──── ${f} ────\n${tail}\n\n`);
  }
  console.log(`\n  written to ${LOG}\n`);
})();
