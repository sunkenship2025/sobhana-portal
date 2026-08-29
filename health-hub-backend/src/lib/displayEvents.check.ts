/**
 * Self-check for `emitWorklistOnMutation` — the router hook that decides which
 * requests wake other tabs' worklists. It runs on EVERY visit write, so a wrong
 * branch is either a silent staleness bug (missed emit) or a refetch storm on
 * every open tab (over-emit). No framework: `npx tsx src/lib/displayEvents.check.ts`.
 */
import assert from 'assert';
import { emitCatalogChange, emitWorklistOnMutation, onCatalogChange } from './displayEvents';

/** Drive the middleware through one request and report what it emitted. */
function run(
  method: string,
  path: string,
  statusCode: number,
  branchId?: string,
): string[] {
  const got: string[] = [];
  const off = onCatalogChange('b1', (c) => got.push(c));
  let finish = () => {};
  let nexted = false;
  const res = {
    statusCode,
    on: (_ev: 'finish', fn: () => void) => {
      finish = fn;
    },
  };
  emitWorklistOnMutation({ method, path, branchId }, res, () => {
    nexted = true;
  });
  assert.ok(nexted, `next() must always be called (${method} ${path})`);
  res.statusCode = statusCode; // status is known only once the handler has run
  finish();
  off();
  return got;
}

// A successful write wakes the branch's worklists.
assert.deepStrictEqual(run('POST', '/', 201, 'b1'), ['worklist']);
assert.deepStrictEqual(run('PATCH', '/abc', 200, 'b1'), ['worklist']);
assert.deepStrictEqual(run('POST', '/abc/finalize', 200, 'b1'), ['worklist']);
assert.deepStrictEqual(run('DELETE', '/abc/tests/t1', 200, 'b1'), ['worklist']);

// Reads never emit — otherwise one tab's refetch would wake every other tab,
// which would wake it back: an infinite refetch loop across the branch.
assert.deepStrictEqual(run('GET', '/', 200, 'b1'), []);

// Report autosave fires every few seconds while a tech types, and no worklist
// shows result-entry progress. Emitting here is the refetch-storm case.
assert.deepStrictEqual(run('POST', '/abc/results', 200, 'b1'), []);

// A rejected write changed nothing, so there is nothing to revalidate.
assert.deepStrictEqual(run('POST', '/abc/finalize', 403, 'b1'), []);
assert.deepStrictEqual(run('POST', '/', 500, 'b1'), []);

// No branch context = no channel to emit on (must not throw).
assert.deepStrictEqual(run('POST', '/', 200, undefined), []);

// Only the acting branch is woken — a write on b2 must not touch b1's listeners.
const otherBranch: string[] = [];
const offOther = onCatalogChange('b1', (c) => otherBranch.push(c));
emitWorklistOnMutation(
  { method: 'POST', path: '/', branchId: 'b2' },
  { statusCode: 200, on: (_e: 'finish', fn: () => void) => fn() },
  () => {},
);
offOther();
assert.deepStrictEqual(otherBranch, []);

// …but a reference catalog IS global: a price edited while standing on b2 changes
// what b1 quotes, so b1's tabs must be told. This is the ₹18,000-vs-₹24,000 bug.
const crossBranch: string[] = [];
const offCross = onCatalogChange('b1', (c) => crossBranch.push(c));
emitCatalogChange('b2', 'billable-products');
offCross();
assert.deepStrictEqual(crossBranch, ['billable-products']);

// A subscriber must not hear the same global edit twice (branch + global channel).
const once: string[] = [];
const offOnce = onCatalogChange('b1', (c) => once.push(c));
emitCatalogChange('b1', 'billable-products');
offOnce();
assert.deepStrictEqual(once, ['billable-products']);

console.log('displayEvents: all checks passed');
