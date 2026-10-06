/**
 * Owner-only: re-apply a referral doctor's CURRENT rates to bills already made.
 * Bills keep the rate they were billed at; this re-prices one doctor's past
 * tests in a date window. Preview first — every changed test listed with its
 * old and new payout — then apply only what is ticked. Backend re-resolves the
 * rates itself; the client only says which tests to leave out.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { API_BASE } from '@/lib/api';
import { apiRequest } from '@/lib/utils';
import { formatRupeesFromPaise } from '@/lib/referralPayouts';
import { useBranchStore } from '@/store/branchStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface RepriceLine {
  orderId: string;
  name: string;
  category: string;
  priceInPaise: number;
  discountShareInPaise: number;
  oldLabel: string;
  oldPayoutInPaise: number;
  newLabel: string;
  newPayoutInPaise: number;
  handSet: boolean;
  notYetPayable: boolean;
}
interface RepriceBill {
  visitId: string;
  billNumber: string;
  billedAt: string;
  patientName: string;
  branchName: string;
  lines: RepriceLine[];
}
interface RepricePreview {
  bills: RepriceBill[];
  totals: { bills: number; orders: number; oldPayoutInPaise: number; newPayoutInPaise: number; alreadyCurrentOrders: number };
}

const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const istDay = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
const signed = (paise: number) => `${paise >= 0 ? '+' : '−'}${formatRupeesFromPaise(Math.abs(paise))}`;
// Bills shown before "Show all" — 2,000 rows re-render on every tick otherwise.
const BILL_PAGE = 100;

/** A checkbox that can also show "some ticked". */
function TriCheckbox({ checked, partial, onChange, label }: {
  checked: boolean; partial: boolean; onChange: (on: boolean) => void; label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = partial; }, [partial]);
  return <input ref={ref} type="checkbox" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />;
}

export function ReapplyReferralRatesDialog({
  doctor,
  onClose,
}: {
  doctor: { id: string; name: string } | null;
  onClose: () => void;
}) {
  const branches = useBranchStore((s) => s.branches).filter((b) => b.isActive);
  const [from, setFrom] = useState(`${istToday().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(istToday());
  const [branch, setBranch] = useState('all');
  const [preview, setPreview] = useState<RepricePreview | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const headers = { 'X-Branch-Id': useBranchStore.getState().activeBranchId || '' };

  const reset = () => {
    setPreview(null);
    setTicked(new Set());
    setShowAll(false);
  };
  const close = () => {
    reset();
    onClose();
  };

  const load = async () => {
    if (!doctor) return;
    setLoading(true);
    try {
      const p = await apiRequest<RepricePreview>(
        `${API_BASE}/referral-doctors/${doctor.id}/reprice?from=${from}&to=${to}&branch=${branch}`,
        { headers },
      );
      setPreview(p);
      // A rate that didn't come from any rule may have been typed in at the
      // counter on purpose — leave those for the owner to tick.
      setTicked(new Set(p.bills.flatMap((b) => b.lines.filter((l) => !l.handSet).map((l) => l.orderId))));
    } catch (e) {
      toast.error((e as Error).message || 'Failed to load preview');
    } finally {
      setLoading(false);
    }
  };

  const lines = useMemo(() => preview?.bills.flatMap((b) => b.lines) ?? [], [preview]);
  const picked = lines.filter((l) => ticked.has(l.orderId));
  const pickedOld = picked.reduce((s, l) => s + l.oldPayoutInPaise, 0);
  const pickedNew = picked.reduce((s, l) => s + l.newPayoutInPaise, 0);
  const pickedBills = preview?.bills.filter((b) => b.lines.some((l) => ticked.has(l.orderId))).length ?? 0;
  const handSetCount = lines.filter((l) => l.handSet).length;
  const scopeLabel = `bills ${istDay(from)} to ${istDay(to)} · ${
    branch === 'all' ? 'all branches' : branches.find((b) => b.id === branch)?.name ?? 'one branch'
  }`;
  // Ticked tests per category: the quick check that each rate moved as expected.
  const byCategory = useMemo(() => {
    const m = new Map<string, { n: number; oldP: number; newP: number; moves: Set<string> }>();
    for (const l of lines) {
      if (!ticked.has(l.orderId)) continue;
      const c = m.get(l.category) ?? { n: 0, oldP: 0, newP: 0, moves: new Set<string>() };
      c.n++;
      c.oldP += l.oldPayoutInPaise;
      c.newP += l.newPayoutInPaise;
      c.moves.add(`${l.oldLabel} → ${l.newLabel}`);
      m.set(l.category, c);
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [lines, ticked]);
  const shownBills = showAll ? preview?.bills ?? [] : (preview?.bills ?? []).slice(0, BILL_PAGE);

  const toggle = (ids: string[], on: boolean) =>
    setTicked((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
      return next;
    });

  const apply = async () => {
    if (!doctor) return;
    setApplying(true);
    try {
      const r = await apiRequest<{ updated: number; oldPayoutInPaise: number; newPayoutInPaise: number }>(
        `${API_BASE}/referral-doctors/${doctor.id}/reprice`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            from,
            to,
            branch,
            // Unticked ids, not ticked ones: a busy doctor has thousands of tests.
            excludedOrderIds: lines.filter((l) => !ticked.has(l.orderId)).map((l) => l.orderId),
            expectedCount: picked.length,
          }),
        },
      );
      toast.success(
        `${r.updated} test${r.updated === 1 ? '' : 's'} re-priced · payout ${formatRupeesFromPaise(r.oldPayoutInPaise)} → ${formatRupeesFromPaise(r.newPayoutInPaise)}`,
      );
      setConfirming(false);
      close();
    } catch (e) {
      toast.error((e as Error).message || 'Failed to apply');
    } finally {
      setApplying(false);
    }
  };

  return (
    <>
      <Dialog open={!!doctor} onOpenChange={(o) => !o && close()}>
        <DialogContent className="max-w-5xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Apply current rates to past bills · {doctor?.name}</DialogTitle>
            <DialogDescription>
              Bills keep the rate they were billed at. This re-prices this doctor's tests in the dates below at
              the rates set now. Statements and the Pay-Run follow immediately, and it is recorded in the audit log.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label className="text-xs">Bills from</Label>
              <Input type="date" value={from} max={to} onChange={(e) => { setFrom(e.target.value); reset(); }} className="w-40" />
            </div>
            <div>
              <Label className="text-xs">to</Label>
              <Input type="date" value={to} min={from} max={istToday()} onChange={(e) => { setTo(e.target.value); reset(); }} className="w-40" />
            </div>
            <div>
              <Label className="text-xs">Branch</Label>
              <Select value={branch} onValueChange={(v) => { setBranch(v); reset(); }}>
                <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All branches</SelectItem>
                  {branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={load} disabled={loading || !from || !to}>
              {loading ? 'Checking…' : preview ? 'Check again' : 'Preview'}
            </Button>
          </div>

          {preview && (
            <>
              <div className="rounded-md border px-3 py-2 text-sm flex flex-wrap gap-x-6 gap-y-1">
                <span>
                  <span className="text-muted-foreground">Would change </span>
                  {preview.totals.orders} test{preview.totals.orders === 1 ? '' : 's'} on {preview.totals.bills} bill{preview.totals.bills === 1 ? '' : 's'}
                </span>
                <span>
                  <span className="text-muted-foreground">Payout </span>
                  {formatRupeesFromPaise(preview.totals.oldPayoutInPaise)} → {formatRupeesFromPaise(preview.totals.newPayoutInPaise)}
                  <span className="text-muted-foreground"> ({signed(preview.totals.newPayoutInPaise - preview.totals.oldPayoutInPaise)})</span>
                </span>
                <span className="text-muted-foreground">
                  {preview.totals.alreadyCurrentOrders} already at the current rate
                </span>
              </div>

              {byCategory.length > 0 && (
                <div className="rounded-md border px-3 py-2 text-sm">
                  {byCategory.map(([cat, c]) => (
                    <div key={cat} className="flex flex-wrap justify-between gap-x-4">
                      <span>
                        {cat} <span className="text-muted-foreground">· {c.n} test{c.n === 1 ? '' : 's'} · {[...c.moves].slice(0, 3).join(', ')}{c.moves.size > 3 ? ', …' : ''}</span>
                      </span>
                      <span>
                        {formatRupeesFromPaise(c.oldP)} → {formatRupeesFromPaise(c.newP)}
                        <span className="text-muted-foreground"> ({signed(c.newP - c.oldP)})</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {handSetCount > 0 && (
                <Alert>
                  <AlertDescription>
                    {handSetCount} test{handSetCount === 1 ? ' was' : 's were'} billed at a rate that isn't on the rate card,
                    possibly typed in at the counter. {handSetCount === 1 ? "It's" : "They're"} unticked; tick to change too.
                  </AlertDescription>
                </Alert>
              )}

              {preview.bills.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Every test in these dates is already at the current rate.
                </p>
              ) : (
                <div className="flex-1 overflow-auto rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-background text-xs text-muted-foreground">
                      <tr className="border-b">
                        <th className="w-8 p-2">
                          <TriCheckbox
                            label="Tick every test"
                            checked={picked.length === lines.length}
                            partial={picked.length > 0 && picked.length < lines.length}
                            onChange={(on) => toggle(lines.map((l) => l.orderId), on)}
                          />
                        </th>
                        <th className="p-2 text-left">Test</th>
                        <th className="p-2 text-right">Amount</th>
                        <th className="p-2 text-right">Was</th>
                        <th className="p-2 text-right">Now</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shownBills.map((b) => {
                        const ids = b.lines.map((l) => l.orderId);
                        const n = ids.filter((id) => ticked.has(id)).length;
                        return [
                          <tr key={b.visitId} className="border-t bg-muted/40">
                            <td className="p-2">
                              <TriCheckbox
                                label={`Re-price every test on ${b.billNumber}`}
                                checked={n === ids.length}
                                partial={n > 0 && n < ids.length}
                                onChange={(on) => toggle(ids, on)}
                              />
                            </td>
                            <td className="p-2" colSpan={4}>
                              <span className="font-medium">{b.billNumber}</span>
                              <span className="text-xs text-muted-foreground">
                                {' '}· {istDay(b.billedAt)} · {b.patientName}
                                {branches.length > 1 ? ` · ${b.branchName}` : ''}
                              </span>
                            </td>
                          </tr>,
                          ...b.lines.map((l) => (
                            <tr key={l.orderId}>
                              <td className="p-2 align-top">
                                <input
                                  type="checkbox"
                                  aria-label={`Re-price ${l.name} on ${b.billNumber}`}
                                  checked={ticked.has(l.orderId)}
                                  onChange={(e) => toggle([l.orderId], e.target.checked)}
                                />
                              </td>
                              <td className="p-2 align-top">
                                <div>{l.name}</div>
                                <div className="text-xs text-muted-foreground">
                                  {l.category}
                                  {l.handSet ? ' · not from the rate card' : ''}
                                  {l.notYetPayable ? ' · report not finalized yet' : ''}
                                </div>
                              </td>
                              <td className="p-2 text-right align-top">
                                {formatRupeesFromPaise(l.priceInPaise - l.discountShareInPaise)}
                              </td>
                              <td className="p-2 text-right align-top text-muted-foreground">
                                {l.oldLabel} · {formatRupeesFromPaise(l.oldPayoutInPaise)}
                              </td>
                              <td className="p-2 text-right align-top">
                                {l.newLabel} · {formatRupeesFromPaise(l.newPayoutInPaise)}
                              </td>
                            </tr>
                          )),
                        ];
                      })}
                    </tbody>
                  </table>
                  {!showAll && preview.bills.length > BILL_PAGE && (
                    <div className="border-t p-2 text-center text-sm">
                      <span className="text-muted-foreground">
                        Showing {BILL_PAGE} of {preview.bills.length} bills. The rest are ticked and counted in the totals above.{' '}
                      </span>
                      <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setShowAll(true)}>
                        Show all
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          <DialogFooter className="items-center gap-2">
            {preview && picked.length > 0 && (
              <span className="mr-auto text-sm text-muted-foreground">
                Ticked: {picked.length} test{picked.length === 1 ? '' : 's'} · {signed(pickedNew - pickedOld)}
              </span>
            )}
            <Button variant="outline" onClick={close}>Cancel</Button>
            <Button onClick={() => setConfirming(true)} disabled={!preview || picked.length === 0}>
              Apply to {picked.length} test{picked.length === 1 ? '' : 's'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirming} onOpenChange={(o) => !applying && setConfirming(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change what {doctor?.name} is owed?</AlertDialogTitle>
            <AlertDialogDescription>
              For {scopeLabel}: {picked.length} test{picked.length === 1 ? '' : 's'} on {pickedBills} bill{pickedBills === 1 ? '' : 's'} move
              from {formatRupeesFromPaise(pickedOld)} to {formatRupeesFromPaise(pickedNew)} ({signed(pickedNew - pickedOld)}).
              Statements already printed or sent will not match the new figures. The old rates are kept in the audit log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={applying}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); apply(); }} disabled={applying}>
              {applying ? 'Applying…' : 'Apply'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
