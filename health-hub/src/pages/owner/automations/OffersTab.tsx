/**
 * Offers — a resource a journey reaches for, not a peer of it.
 *
 * The money switch is the point of the detail screen: "who pays for the discount on a
 * referred patient" is worked out on a real bill and shown three ways, because nobody
 * should have to read the payout code to find out.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, ArrowLeft, Lock, X, Plus, Search } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LoadingState } from '@/components/ui/loading-state';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  listOffers, getOffer, saveOffer, createOffer, rupees, offerTerms, searchProducts,
  OFFER_HOLDERS, APPLIES_TO, appliesTo,
  type OfferHolder, type OfferTests, type ReferralExample,
} from './api';

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
                  {offerTerms(o)}
                  {' · '}{o.issued} issued, {o.redeemed} used
                  {o.uses > o.redeemed && ` (${o.uses} bills)`}
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

export function OfferDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient();
  const { data: o, isLoading, error } = useQuery({ queryKey: ['offer', id], queryFn: () => getOffer(id) });
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

  // A failed load used to leave the spinner up forever — indistinguishable from a click
  // that did nothing.
  if (error) {
    return (
      <div className="space-y-4">
        <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Offers
        </button>
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
          This offer could not be loaded: {(error as Error).message}
        </p>
      </div>
    );
  }
  if (isLoading || !o) return <LoadingState />;
  // What is on screen: the edit when there is one — a cleared box included — else the saved value.
  const shown = <T,>(k: string, saved: T) => (k in draft ? (draft[k] as T) : saved);
  const share = shown('referrerSharePct', o.referrerSharePct);
  const listedEmpty = shown('forTests', o.forTests) === 'LISTED' && shown('testProducts', o.testProducts).length === 0;
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
            {offerTerms(o)} · expires after {o.validityDays} days
          </p>
          <p className="text-xs text-muted-foreground">
            {o.usedByAutomations.length
              ? `Handed out by ${o.usedByAutomations.map((a) => a.name).join(', ')}`
              : 'No journey hands this out yet'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {o.isActive ? 'Active' : 'Off — no new codes; codes already sent still work'}
          </span>
          <Switch checked={o.isActive} onCheckedChange={(v) => save.mutate({ isActive: v })} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { n: o.issued, label: 'Issued' },
          { n: o.redeemed, label: o.uses > o.redeemed ? `Used, on ${o.uses} bills` : 'Used' },
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
            value={shown('maxDiscountBudgetInPaise', o.budget.maxDiscountBudgetInPaise)}
            onChange={(v) => setDraft({ ...draft, maxDiscountBudgetInPaise: v })} />
          <LimitRow label="Most one bill can be discounted"
            sub="Without this, 15% of a ₹40,000 bill is ₹6,000"
            value={shown('maxDiscountPerBillInPaise', o.budget.maxDiscountPerBillInPaise)}
            onChange={(v) => setDraft({ ...draft, maxDiscountPerBillInPaise: v })} />
          <AppliesToRow
            value={appliesTo({ scope: shown('scope', o.scope), forTests: shown('forTests', o.forTests) })}
            products={shown('testProducts', o.testProducts)}
            onChange={(scope, forTests) => setDraft({ ...draft, scope, forTests })}
            onProducts={(list) => setDraft({ ...draft, testProducts: list, testProductIds: list.map((p) => p.id) })} />
          <HolderRow value={shown('holder', o.holder)}
            onChange={(v) => setDraft({ ...draft, holder: v })} />
          <LimitRow label="Bills one code can be used on"
            sub="1 for most offers. A code for a patient's family might cover 3 visits — each one sets aside the per-bill cap from the budget when it is sent"
            value={shown('maxUsesPerCode', o.maxUsesPerCode)} plain
            onChange={(v) => setDraft({ ...draft, maxUsesPerCode: v })} />
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
          <Button disabled={save.isPending || listedEmpty} onClick={() => {
            const { testProducts: _names, ...body } = draft;
            save.mutate(body);
          }}>
            {save.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Which tests a code discounts — scope and test rule as one choice, the way it is asked. */
function AppliesToRow({ value, products, onChange, onProducts }: {
  value: string; products: { id: string; name: string }[];
  onChange: (scope: string, forTests: OfferTests) => void;
  onProducts: (list: { id: string; name: string }[]) => void;
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">Discount applies to</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {APPLIES_TO.find((a) => a.value === value)?.help}
          </span>
        </span>
        <Select value={value} onValueChange={(v) => onChange(
          v === 'WHOLE_BILL' ? 'WHOLE_BILL' : 'TESTS_ONLY', (v === 'WHOLE_BILL' ? 'ALL' : v) as OfferTests)}>
          <SelectTrigger className="h-9 w-60"><SelectValue /></SelectTrigger>
          <SelectContent>
            {APPLIES_TO.map((a) => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {value === 'LISTED' && <ProductList products={products} onChange={onProducts} />}
    </div>
  );
}

/** The particular tests an offer discounts: a list you add to by searching the catalog. */
function ProductList({ products, onChange }: {
  products: { id: string; name: string }[]; onChange: (list: { id: string; name: string }[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const { data } = useQuery({
    queryKey: ['product-search', q], queryFn: () => searchProducts(q), enabled: open, staleTime: 60_000,
  });
  return (
    <div className="mt-2.5 divide-y rounded-md border">
      {products.map((p) => (
        <div key={p.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
          <span className="min-w-0 flex-1 truncate">{p.name}</span>
          <button aria-label={`Remove ${p.name}`} className="text-muted-foreground hover:text-destructive"
            onClick={() => onChange(products.filter((x) => x.id !== p.id))}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs hover:bg-muted/50 ${
            products.length === 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
            <Plus className="h-3 w-3" /> {products.length === 0 ? 'Add the first test — none chosen yet' : 'Add a test'}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-2">
          <div className="relative mb-2">
            <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input autoFocus className="h-8 pl-7" placeholder="Search tests and packages" value={q}
              onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="max-h-60 overflow-y-auto">
            {(data?.results ?? []).filter((r) => !products.some((p) => p.id === r.id)).map((r) => (
              <button key={r.id} className="flex w-full items-baseline justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                onClick={() => { onChange([...products, { id: r.id, name: r.name }]); setOpen(false); setQ(''); }}>
                <span className="truncate">{r.name}</span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{r.code}</span>
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** Who may use a code at the counter. */
function HolderRow({ value, onChange }: { value: OfferHolder; onChange: (v: OfferHolder) => void }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">Who can use a code</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {OFFER_HOLDERS.find((h) => h.value === value)?.help}
        </span>
      </span>
      <Select value={value} onValueChange={(v) => onChange(v as OfferHolder)}>
        <SelectTrigger className="h-9 w-60"><SelectValue /></SelectTrigger>
        <SelectContent>
          {OFFER_HOLDERS.map((h) => <SelectItem key={h.value} value={h.value}>{h.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

/** A number on the right of a row: rupees by default, `plain` for a count. */
function LimitRow({ label, sub, value, onChange, plain }: {
  label: string; sub: string; value: number | null; onChange: (v: number | null) => void; plain?: boolean;
}) {
  const scale = plain ? 1 : 100;
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{sub}</span>
      </span>
      <Input
        className="h-9 w-32 text-right" placeholder="No limit"
        value={value == null ? '' : Math.round(value / scale)}
        onChange={(e) => {
          const n = e.target.value.trim();
          onChange(n === '' ? null : Math.max(0, Math.round(Number(n) * scale)) || 0);
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
  const [applies, setApplies] = useState('ALL');
  const [products, setProducts] = useState<{ id: string; name: string }[]>([]);
  const [holder, setHolder] = useState<OfferHolder>('ANYONE');
  const [uses, setUses] = useState('1');
  const pctValid = Number(pct) > 0 && Number(pct) <= 100;

  const create = useMutation({
    mutationFn: () => createOffer({
      code: code.trim().toUpperCase(),
      name: name.trim() || code.trim().toUpperCase(),
      discountPercentage: Number(pct) || 0,
      discountReason: name.trim() || 'Campaign offer',
      validityDays: Number(days) || 30,
      scope: applies === 'WHOLE_BILL' ? 'WHOLE_BILL' : 'TESTS_ONLY',
      forTests: applies === 'WHOLE_BILL' ? 'ALL' : applies,
      testProductIds: products.map((p) => p.id),
      holder,
      maxUsesPerCode: Math.max(1, Math.round(Number(uses)) || 1),
      maxDiscountBudgetInPaise: budget ? Math.round(Number(budget) * 100) : null,
      maxDiscountPerBillInPaise: perBill ? Math.round(Number(perBill) * 100) : null,
    }),
    onSuccess: (o) => {
      toast.success('Created, inactive. Turn it on when the numbers are agreed.');
      qc.invalidateQueries({ queryKey: ['offers'] });
      setCode(''); setName(''); setBudget(''); setPerBill('');
      setApplies('ALL'); setProducts([]); setHolder('ANYONE'); setUses('1');
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
              <Label className="text-xs">Discount (%)</Label>
              <Input className="mt-1.5" value={pct} onChange={(e) => setPct(e.target.value)}
                aria-invalid={!pctValid} />
              {!pctValid && <p className="mt-1 text-xs text-destructive">1 to 100</p>}
            </div>
          </div>
          <div>
            <Label className="text-xs">What to call it</Label>
            <Input className="mt-1.5" placeholder="Clinic recovery offer"
              value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <Label className="text-xs">Discount applies to</Label>
              <Select value={applies} onValueChange={setApplies}>
                <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {APPLIES_TO.map((a) => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1">
              <Label className="text-xs">Who can use a code</Label>
              <Select value={holder} onValueChange={(v) => setHolder(v as OfferHolder)}>
                <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {OFFER_HOLDERS.map((h) => <SelectItem key={h.value} value={h.value}>{h.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          {applies === 'LISTED' && <ProductList products={products} onChange={setProducts} />}
          {applies !== 'ALL' && applies !== 'LISTED' && applies !== 'WHOLE_BILL' && (
            <p className="text-xs text-muted-foreground">{APPLIES_TO.find((a) => a.value === applies)?.help}</p>
          )}
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
            <div className="w-28">
              <Label className="text-xs">Bills per code</Label>
              <Input className="mt-1.5" value={uses} onChange={(e) => setUses(e.target.value)} />
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
          <Button disabled={!code.trim() || !pctValid || (applies === 'LISTED' && products.length === 0) || create.isPending}
            onClick={() => create.mutate()}>
            {create.isPending ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
