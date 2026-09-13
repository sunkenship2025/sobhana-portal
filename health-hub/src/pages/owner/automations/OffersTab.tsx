/**
 * Offers — a resource a journey reaches for, not a peer of it.
 *
 * The money switch is the point of the detail screen: "who pays for the discount on a
 * referred patient" is worked out on a real bill and shown three ways, because nobody
 * should have to read the payout code to find out.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, ArrowLeft, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { LoadingState } from '@/components/ui/loading-state';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { listOffers, getOffer, saveOffer, createOffer, rupees, type ReferralExample } from './api';

export function OffersTab() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ['offers'], queryFn: listOffers });

  if (openId) return <OfferDetail id={openId} onBack={() => setOpenId(null)} />;
  if (isLoading) return <LoadingState />;

  const offers = data?.offers ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Offers</h2>
          <p className="text-sm text-muted-foreground">
            Discounts a journey can issue, or staff can hand out.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>New offer</Button>
      </div>

      <NewOfferDialog open={creating} onClose={() => setCreating(false)}
        onCreated={(id) => { setCreating(false); setOpenId(id); }} />

      {offers.length === 0 ? (
        <p className="rounded-lg border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          No offers yet.
        </p>
      ) : (
        <div className="divide-y rounded-lg border">
          {offers.map((o) => (
            <button key={o.id} onClick={() => setOpenId(o.id)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50">
              <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${
                o.budget.exhausted ? 'bg-destructive' : o.isActive ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />
              <span className="min-w-0 flex-1">
                <span className="block font-mono text-sm font-medium">{o.code}</span>
                <span className="block text-xs text-muted-foreground">
                  {o.discountPercentage}% off {o.scope === 'TESTS_ONLY' ? 'tests' : 'the whole bill'}
                  {' · '}{o.distribution === 'UNIQUE_PER_PATIENT' ? 'unique per patient' : 'one shared code'}
                  {' · '}{o.issued} issued, {o.redeemed} used
                </span>
              </span>
              {o.budget.maxDiscountBudgetInPaise != null && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {rupees(o.budget.committedInPaise)} of {rupees(o.budget.maxDiscountBudgetInPaise)}
                </span>
              )}
              {o.budget.exhausted && (
                <Badge variant="outline" className="shrink-0 border-destructive/30 text-[11px] font-normal text-destructive">
                  Budget used up
                </Badge>
              )}
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Money({ ex, title, selected, onSelect }: {
  ex: ReferralExample; title: string; selected: boolean; onSelect: () => void;
}) {
  return (
    <button onClick={onSelect}
      className={`rounded-lg border p-3.5 text-left transition ${selected ? 'ring-2 ring-foreground' : 'hover:bg-muted/40'}`}>
      <p className="mb-1.5 flex items-center gap-2 text-sm font-semibold">
        <span aria-hidden className={`h-3 w-3 rounded-full border-[3px] ${
          selected ? 'border-foreground' : 'border-muted-foreground/40'}`} />
        {title}
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Doctor is paid <b className="text-foreground">{rupees(ex.doctorPaidInPaise)}</b>.<br />
        You keep {rupees(ex.centreKeepsInPaise)}.<br />
        Costs you {rupees(ex.costToCentreInPaise)}
        {ex.costToDoctorInPaise > 0 && `, the doctor ${rupees(ex.costToDoctorInPaise)}`}.
      </p>
    </button>
  );
}

function OfferDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient();
  const { data: o, isLoading } = useQuery({ queryKey: ['offer', id], queryFn: () => getOffer(id) });
  const [draft, setDraft] = useState<Record<string, unknown>>({});

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => saveOffer(id, body),
    onSuccess: () => {
      toast.success('Saved');
      setDraft({});
      qc.invalidateQueries({ queryKey: ['offer', id] });
      qc.invalidateQueries({ queryKey: ['offers'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading || !o) return <LoadingState />;
  const share = (draft.referrerSharePct as number) ?? o.referrerSharePct;
  const dirty = Object.keys(draft).length > 0;

  return (
    <div className="space-y-5">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Offers
      </button>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-mono text-lg font-semibold">{o.code}</h2>
          <p className="text-sm text-muted-foreground">
            {o.discountPercentage}% off {o.scope === 'TESTS_ONLY' ? 'tests' : 'the whole bill'} ·
            expires after {o.validityDays} days
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{o.isActive ? 'Active' : 'Inactive'}</span>
          <Switch checked={o.isActive} onCheckedChange={(v) => save.mutate({ isActive: v })} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { n: o.issued, label: 'Issued' },
          { n: o.redeemed, label: 'Used' },
          { n: o.issued ? `${Math.round((o.redeemed / o.issued) * 100)}%` : '—', label: 'Of those issued' },
          { n: rupees(o.discountGivenInPaise), label: o.budget.maxDiscountBudgetInPaise != null
              ? `of ${rupees(o.budget.maxDiscountBudgetInPaise)} budget` : 'given away' },
        ].map((k) => (
          <div key={k.label} className="rounded-lg border p-3.5">
            <p className="text-xl font-semibold tabular-nums">{k.n}</p>
            <p className="text-xs text-muted-foreground">{k.label}</p>
          </div>
        ))}
      </div>

      <section>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          On a referred patient, who pays for the discount
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          <Money title="We absorb it" ex={o.referralExamples.centreAbsorbs}
            selected={share === 0} onSelect={() => setDraft({ ...draft, referrerSharePct: 0 })} />
          <Money title="Split it" ex={o.referralExamples.split}
            selected={share === 50} onSelect={() => setDraft({ ...draft, referrerSharePct: 50 })} />
          <Money title="Doctor shares it" ex={o.referralExamples.doctorShares}
            selected={share === 100} onSelect={() => setDraft({ ...draft, referrerSharePct: 100 })} />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Worked on a {rupees(o.referralExamples.centreAbsorbs.billInPaise)} bill from a doctor at 20%.
          The payout statement uses the same number.
        </p>
      </section>

      <section className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Limits</p>
        <div className="divide-y rounded-lg border">
          <LimitRow label="Total budget"
            sub={`${rupees(o.budget.committedInPaise)} used · ${rupees(o.budget.reservedInPaise)} promised but not yet redeemed`}
            value={o.budget.maxDiscountBudgetInPaise}
            onChange={(v) => setDraft({ ...draft, maxDiscountBudgetInPaise: v })} />
          <LimitRow label="Most one bill can be discounted"
            sub="Without this, 15% of a ₹40,000 bill is ₹6,000"
            value={o.budget.maxDiscountPerBillInPaise}
            onChange={(v) => setDraft({ ...draft, maxDiscountPerBillInPaise: v })} />
          <div className="flex items-center gap-3 px-4 py-3">
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Only the patient it was issued to may use it</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Off by default — families share a phone, and someone collecting for a relative is normal here
              </span>
            </span>
            <Switch checked={(draft.bindToPatient as boolean) ?? o.bindToPatient}
              onCheckedChange={(v) => setDraft({ ...draft, bindToPatient: v })} />
          </div>
          <div className="flex items-center gap-3 bg-muted/30 px-4 py-3">
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">
                If staff also give a concession, the larger one applies
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Compared in rupees. The bill records which one was used, and which was not.
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="h-3 w-3" /> Fixed
            </span>
          </div>
        </div>
      </section>

      {dirty && (
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setDraft({})}>Discard</Button>
          <Button disabled={save.isPending} onClick={() => save.mutate(draft)}>
            {save.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      )}
    </div>
  );
}

function LimitRow({ label, sub, value, onChange }: {
  label: string; sub: string; value: number | null; onChange: (v: number | null) => void;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{sub}</span>
      </span>
      <Input
        className="h-9 w-32 text-right" placeholder="No limit"
        value={value == null ? '' : Math.round(value / 100)}
        onChange={(e) => {
          const n = e.target.value.trim();
          onChange(n === '' ? null : Math.max(0, Math.round(Number(n) * 100)));
        }}
      />
    </div>
  );
}

/**
 * A new offer. Short on purpose: code, discount, what it applies to, how it is given
 * out, and the two caps that bound the liability.
 *
 * Created INACTIVE. An offer that is live the moment it is saved is one slip away from
 * money going out the door before anyone agreed the numbers.
 */
function NewOfferDialog({ open, onClose, onCreated }: {
  open: boolean; onClose: () => void; onCreated: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [pct, setPct] = useState('15');
  const [days, setDays] = useState('30');
  const [budget, setBudget] = useState('');
  const [perBill, setPerBill] = useState('');

  const create = useMutation({
    mutationFn: () => createOffer({
      code: code.trim().toUpperCase(),
      name: name.trim() || code.trim().toUpperCase(),
      discountPercentage: Number(pct) || 0,
      discountReason: name.trim() || 'Campaign offer',
      validityDays: Number(days) || 30,
      scope: 'TESTS_ONLY',
      maxDiscountBudgetInPaise: budget ? Math.round(Number(budget) * 100) : null,
      maxDiscountPerBillInPaise: perBill ? Math.round(Number(perBill) * 100) : null,
    }),
    onSuccess: (o) => {
      toast.success('Created, inactive. Turn it on when the numbers are agreed.');
      qc.invalidateQueries({ queryKey: ['offers'] });
      setCode(''); setName(''); setBudget(''); setPerBill('');
      onCreated(o.id);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New offer</DialogTitle>
          <DialogDescription>
            It is created switched off. Nothing can issue it until you turn it on.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex gap-3">
            <div className="flex-1">
              <Label className="text-xs">Code</Label>
              <Input className="mt-1.5 font-mono" placeholder="RECOVERY15"
                value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
            </div>
            <div className="w-28">
              <Label className="text-xs">Discount</Label>
              <Input className="mt-1.5" value={pct} onChange={(e) => setPct(e.target.value)} />
            </div>
          </div>
          <div>
            <Label className="text-xs">What to call it</Label>
            <Input className="mt-1.5" placeholder="Clinic recovery offer"
              value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <Label className="text-xs">Expires after (days)</Label>
              <Input className="mt-1.5" value={days} onChange={(e) => setDays(e.target.value)} />
            </div>
            <div className="flex-1">
              <Label className="text-xs">Most one bill (₹)</Label>
              <Input className="mt-1.5" placeholder="No cap"
                value={perBill} onChange={(e) => setPerBill(e.target.value)} />
            </div>
          </div>
          <div>
            <Label className="text-xs">Total budget (₹)</Label>
            <Input className="mt-1.5" placeholder="No limit"
              value={budget} onChange={(e) => setBudget(e.target.value)} />
            <p className="mt-1.5 text-xs text-muted-foreground">
              Counted when a coupon is <b>used</b>, plus everything issued and still live —
              counting only redemptions lets an offer issue far past its budget and find out later.
              A per-bill cap is what stops 15% of a ₹40,000 bill being a surprise.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!code.trim() || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
