/**
 * ReferralCategoryRateCard
 *
 * The centre-wide DEFAULT referral rate per payout category (Laboratory, X-Ray,
 * Ultrasound, ECG / Cardiology, CT / MRI). This rate card is the base commission
 * for every referred test — resolved from the test's panel category at billing
 * time. It replaces the old per-doctor flat default. A per-doctor category rate
 * or a per-product rule overrides it.
 *
 * Self-contained: fetches, edits, and saves its own state via
 * GET/PUT /referral-doctors/category-rates.
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

type Row = {
  category: string;
  commissionType: ReferralPayoutType;
  commissionPercent: string;
  commissionAmount: string; // rupees
};

function headers(token: string | null) {
  const { activeBranchId } = useBranchStore.getState();
  return {
    Authorization: `Bearer ${token}`,
    'X-Branch-Id': activeBranchId || '',
    'Content-Type': 'application/json',
  };
}

function toRow(category: string, rate?: ReferralCategoryRate): Row {
  return {
    category,
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

export function ReferralCategoryRateCard() {
  const { token } = useAuthStore();
  const [rows, setRows] = useState<Row[]>(PAYOUT_CATEGORIES.map((c) => toRow(c)));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/referral-doctors/category-rates`, {
        headers: headers(token),
      });
      if (!res.ok) return;
      const rates: ReferralCategoryRate[] = await res.json();
      const byCategory = new Map(rates.map((r) => [r.category, r]));
      // Canonical categories first, then any custom ones already saved.
      const extra = rates.map((r) => r.category).filter((c) => !PAYOUT_CATEGORIES.includes(c));
      const all = [...PAYOUT_CATEGORIES, ...extra];
      setRows(all.map((c) => toRow(c, byCategory.get(c))));
    } catch {
      /* keep defaults on failure */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const patch = (category: string, next: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.category === category ? { ...r, ...next } : r)));

  const save = async () => {
    if (saving) return;
    for (const r of rows) {
      if (r.commissionType === 'PERCENTAGE') {
        const v = parseFloat(r.commissionPercent);
        if (r.commissionPercent !== '' && (isNaN(v) || v < 0 || v > 100)) {
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

    // Only send rows the owner actually set (a blank % row means "not configured").
    const rates = rows
      .filter((r) =>
        r.commissionType === 'FIXED_AMOUNT'
          ? r.commissionAmount !== ''
          : r.commissionPercent !== '',
      )
      .map((r) =>
        r.commissionType === 'FIXED_AMOUNT'
          ? { category: r.category, commissionType: r.commissionType, commissionAmount: parseFloat(r.commissionAmount) }
          : { category: r.category, commissionType: r.commissionType, commissionPercent: parseFloat(r.commissionPercent) },
      );

    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/referral-doctors/category-rates`, {
        method: 'PUT',
        headers: headers(token),
        body: JSON.stringify({ rates }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        toast.error(e.message || 'Failed to save rate card');
        return;
      }
      toast.success('Category rate card saved');
      await load();
    } catch {
      toast.error('Failed to save rate card');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Category Rate Card</CardTitle>
        <p className="text-sm text-muted-foreground">
          Default referral commission per category. Applies to every referred test unless a
          doctor or product has its own rate.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.map((row) => (
          <div key={row.category} className="flex items-center gap-3">
            <div className="w-40 shrink-0">
              <Label className="text-sm">{row.category}</Label>
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
                  placeholder="—"
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
                  placeholder="0"
                  className="h-9 pl-7"
                />
              </div>
            )}
          </div>
        ))}
        <div className="flex justify-end pt-1">
          <Button onClick={save} disabled={saving || loading}>
            {saving ? 'Saving…' : 'Save Rate Card'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
