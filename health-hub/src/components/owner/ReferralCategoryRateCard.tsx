/**
 * ReferralCategoryRateCard
 *
 * Branch-scoped referral rate card. "All branches" edits the GLOBAL default
 * every branch inherits; picking a branch edits that branch's overrides —
 * inherited rows show the global value as a placeholder, and editing one creates
 * an override (Reset clears it back to the global default). A per-doctor rate or
 * a per-product rule still overrides this at billing time.
 *
 * Self-contained: fetches/saves via GET/PUT /referral-doctors/category-rates
 * with a ?branchId / body branchId naming the scope.
 */
import { useEffect, useState } from 'react';
import { API_BASE } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';
import { toast } from 'sonner';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { PAYOUT_CATEGORIES } from '@/lib/payoutCategories';
import type { ReferralCategoryRate, ReferralPayoutType } from '@/types';

type Fields = {
  commissionType: ReferralPayoutType;
  commissionPercent: string;
  commissionAmount: string; // rupees
};
type Row = Fields & {
  category: string;
  isOverride: boolean;      // branch scope: this branch has its own row
  global: Fields | null;    // branch scope: the inherited global value (placeholder / reset target)
};

const GLOBAL = 'global';

function headers(token: string | null) {
  const { activeBranchId } = useBranchStore.getState();
  return {
    Authorization: `Bearer ${token}`,
    'X-Branch-Id': activeBranchId || '',
    'Content-Type': 'application/json',
  };
}

function toFields(rate?: ReferralCategoryRate): Fields {
  return {
    commissionType: rate?.commissionType ?? 'PERCENTAGE',
    commissionPercent:
      rate?.commissionType !== 'FIXED_AMOUNT' && rate?.commissionPercent != null
        ? String(rate.commissionPercent)
        : '',
    commissionAmount:
      rate?.commissionType === 'FIXED_AMOUNT' && rate?.commissionAmountInPaise != null
        ? String(rate.commissionAmountInPaise / 100)
        : '',
  };
}

const blank = (f: Fields) =>
  f.commissionType === 'FIXED_AMOUNT' ? f.commissionAmount === '' : f.commissionPercent === '';

export function ReferralCategoryRateCard() {
  const { token } = useAuthStore();
  const branches = useBranchStore((s) => s.branches);
  const [scope, setScope] = useState<string>(GLOBAL); // GLOBAL | branchId
  const [rows, setRows] = useState<Row[]>([]);
  const [newCategory, setNewCategory] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const isBranch = scope !== GLOBAL;

  const load = async (forScope: string) => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch(
        `${API_BASE}/referral-doctors/category-rates?branchId=${encodeURIComponent(forScope)}`,
        { headers: headers(token) },
      );
      const rates: ReferralCategoryRate[] = res.ok ? await res.json() : [];
      const globalByCat = new Map(rates.filter((r) => !r.branchId).map((r) => [r.category, r]));
      const branchByCat = new Map(rates.filter((r) => r.branchId === forScope).map((r) => [r.category, r]));
      const cats = [
        ...PAYOUT_CATEGORIES,
        ...rates.map((r) => r.category).filter((c) => !PAYOUT_CATEGORIES.includes(c)),
      ].filter((c, i, a) => a.indexOf(c) === i);
      setRows(
        cats.map((category) => {
          const g = globalByCat.get(category);
          if (forScope === GLOBAL) {
            return { category, ...toFields(g), isOverride: false, global: null };
          }
          const b = branchByCat.get(category);
          return {
            category,
            ...toFields(b ?? g),
            isOverride: !!b,
            global: toFields(g),
          };
        }),
      );
    } catch {
      /* keep whatever is there */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(scope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, scope]);

  // Any edit in a branch scope makes the row an override; global scope edits stay global.
  const patch = (category: string, next: Partial<Fields>) =>
    setRows((prev) =>
      prev.map((r) => (r.category === category ? { ...r, ...next, isOverride: isBranch ? true : r.isOverride } : r)),
    );

  const resetToGlobal = (category: string) =>
    setRows((prev) =>
      prev.map((r) =>
        r.category === category && r.global ? { ...r, ...r.global, isOverride: false } : r,
      ),
    );

  const addCategory = () => {
    const c = newCategory.trim();
    if (!c) return;
    if (rows.some((r) => r.category === c)) {
      toast.error(`"${c}" is already in the list`);
      return;
    }
    setRows((prev) => [
      ...prev,
      { category: c, commissionType: 'PERCENTAGE', commissionPercent: '', commissionAmount: '', isOverride: isBranch, global: isBranch ? toFields(undefined) : null },
    ]);
    setNewCategory('');
  };

  const save = async () => {
    if (saving) return;
    // Rows to persist for THIS scope: global = every non-blank row; branch = only
    // the overridden non-blank rows (inherited rows are left to fall back).
    const toSend = rows.filter((r) => (isBranch ? r.isOverride : true) && !blank(r));
    for (const r of toSend) {
      if (r.commissionType === 'PERCENTAGE') {
        const v = parseFloat(r.commissionPercent);
        if (isNaN(v) || v < 0 || v > 100) {
          toast.error(`${r.category}: percentage must be between 0 and 100`);
          return;
        }
      } else {
        const v = parseFloat(r.commissionAmount);
        if (isNaN(v) || v < 0) {
          toast.error(`${r.category}: amount must be a non-negative number`);
          return;
        }
      }
    }
    const rates = toSend.map((r) =>
      r.commissionType === 'FIXED_AMOUNT'
        ? { category: r.category, commissionType: r.commissionType, commissionAmount: parseFloat(r.commissionAmount) }
        : { category: r.category, commissionType: r.commissionType, commissionPercent: parseFloat(r.commissionPercent) },
    );

    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/referral-doctors/category-rates`, {
        method: 'PUT',
        headers: headers(token),
        body: JSON.stringify({ rates, branchId: scope }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        toast.error(e.message || 'Failed to save rate card');
        return;
      }
      toast.success(isBranch ? 'Branch rates saved' : 'Global rate card saved');
      await load(scope);
    } catch {
      toast.error('Failed to save rate card');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <CardTitle>Category Rate Card</CardTitle>
            <p className="text-sm text-muted-foreground">
              {isBranch
                ? 'Overrides for this branch. Blank rows inherit the global rate; edit one to override it.'
                : 'Global default referral commission per category. Every branch inherits it unless it sets its own.'}
            </p>
          </div>
          <div className="flex gap-1 flex-wrap">
            <Button
              type="button"
              size="sm"
              variant={scope === GLOBAL ? 'default' : 'outline'}
              onClick={() => setScope(GLOBAL)}
            >
              All branches
            </Button>
            {branches.map((b) => (
              <Button
                key={b.id}
                type="button"
                size="sm"
                variant={scope === b.id ? 'default' : 'outline'}
                onClick={() => setScope(b.id)}
              >
                {b.name}
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.map((row) => {
          const inherited = isBranch && !row.isOverride;
          return (
            <div key={row.category} className="flex items-center gap-3">
              <div className="w-44 shrink-0">
                <Label className="text-sm">{row.category}</Label>
                {inherited && <span className="ml-2 text-xs text-muted-foreground">inherited</span>}
              </div>
              <Select
                value={row.commissionType}
                onValueChange={(v) => patch(row.category, { commissionType: v as ReferralPayoutType })}
              >
                <SelectTrigger className="w-28 h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="PERCENTAGE">Percent</SelectItem>
                  <SelectItem value="FIXED_AMOUNT">Flat ₹</SelectItem>
                </SelectContent>
              </Select>
              {row.commissionType === 'PERCENTAGE' ? (
                <div className="relative w-32">
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={row.commissionPercent}
                    onChange={(e) => patch(row.category, { commissionPercent: e.target.value })}
                    placeholder={inherited && row.global ? (row.global.commissionPercent || '—') : '—'}
                    className="h-9 pr-7"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
                </div>
              ) : (
                <div className="relative w-32">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">₹</span>
                  <Input
                    type="number"
                    min={0}
                    value={row.commissionAmount}
                    onChange={(e) => patch(row.category, { commissionAmount: e.target.value })}
                    placeholder={inherited && row.global ? (row.global.commissionAmount || '0') : '0'}
                    className="h-9 pl-7"
                  />
                </div>
              )}
              {isBranch && row.isOverride && (
                <Button type="button" variant="ghost" size="sm" className="h-9" onClick={() => resetToGlobal(row.category)}>
                  Reset
                </Button>
              )}
            </div>
          );
        })}

        <div className="flex items-center gap-2 pt-1">
          <Input
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addCategory())}
            placeholder="Add investigation…"
            className="h-9 w-56"
          />
          <Button type="button" variant="outline" size="sm" className="h-9" onClick={addCategory}>Add</Button>
          <div className="flex-1" />
          <Button onClick={save} disabled={saving || loading}>
            {saving ? 'Saving…' : isBranch ? 'Save Branch Rates' : 'Save Rate Card'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
