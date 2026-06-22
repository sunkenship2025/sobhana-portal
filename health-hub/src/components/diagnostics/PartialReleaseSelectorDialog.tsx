import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export interface PartialReleaseOrder {
  id: string;
  label: string;
  sublabel?: string;
  hint?: string;
  hintVariant?: 'normal' | 'warning';
  defaultChecked: boolean;
  /**
   * When true, the row is rendered un-toggleable (greyed out, checkbox locked
   * to unchecked). Used to surface orders that exist on the visit but cannot
   * ship in this batch (e.g. an EXTERNAL_UPLOAD test with no PDF uploaded).
   */
  disabled?: boolean;
}

export interface PartialReleaseGroup {
  departmentName: string;
  orders: PartialReleaseOrder[];
}

interface PartialReleaseSelectorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: PartialReleaseGroup[];
  onConfirm: (selectedOrderIds: string[]) => void;
  confirmLabel?: string;
  busy?: boolean;
}

export function PartialReleaseSelectorDialog({
  open,
  onOpenChange,
  groups,
  onConfirm,
  confirmLabel = 'Continue → Preview',
  busy = false,
}: PartialReleaseSelectorDialogProps) {
  const allOrders = useMemo(
    () => groups.flatMap((g) => g.orders),
    [groups],
  );

  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  // Reseed selection from defaults whenever the dialog opens or the input
  // groups change. (Closing the dialog leaves the set as-is, but reopening
  // resets to fresh defaults — that's the right behavior since the user's
  // earlier exploratory toggling shouldn't persist across cancellation.)
  useEffect(() => {
    if (!open) return;
    const fresh = new Set<string>();
    allOrders.forEach((o) => {
      if (o.disabled) return;
      if (o.defaultChecked) fresh.add(o.id);
    });
    setSelected(fresh);
  }, [open, allOrders]);

  const toggle = (id: string) => {
    const order = allOrders.find((o) => o.id === id);
    if (order?.disabled) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectable = allOrders.filter((o) => !o.disabled);
  const blocked = allOrders.length - selectable.length;
  const total = selectable.length;
  const releasing = selected.size;
  const staying = Math.max(total - releasing, 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Continue with Partial Report</DialogTitle>
          <DialogDescription>
            Select which tests to release in this batch. Unselected tests stay in the next draft.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] overflow-y-auto space-y-5 py-1">
          {groups.map((group) => (
            <div key={group.departmentName} className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {group.departmentName}
              </div>
              <div className="space-y-2">
                {group.orders.map((order) => {
                  const isChecked = !order.disabled && selected.has(order.id);
                  return (
                    <label
                      key={order.id}
                      className={cn(
                        'flex items-start gap-3 rounded-md border px-3 py-2.5 transition-colors',
                        order.disabled
                          ? 'border-border bg-muted cursor-not-allowed opacity-70'
                          : 'cursor-pointer',
                        !order.disabled && isChecked
                          ? 'border-primary/40 bg-primary/5'
                          : !order.disabled && 'border-border bg-white hover:bg-muted',
                      )}
                    >
                      <Checkbox
                        checked={isChecked}
                        onCheckedChange={() => toggle(order.id)}
                        disabled={order.disabled}
                        className="mt-0.5"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-medium text-sm">{order.label}</span>
                          {order.sublabel && (
                            <span className="text-xs text-muted-foreground">{order.sublabel}</span>
                          )}
                        </div>
                        {order.hint && (
                          <div
                            className={cn(
                              'mt-0.5 text-xs flex items-center gap-1',
                              order.hintVariant === 'warning'
                                ? 'text-amber-700'
                                : 'text-muted-foreground',
                            )}
                          >
                            {order.hintVariant === 'warning' && (
                              <AlertTriangle className="h-3 w-3 flex-shrink-0" />
                            )}
                            {order.hint}
                          </div>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="border-t pt-3 text-sm text-muted-foreground space-y-0.5">
          <div>
            Releasing <span className="font-medium text-foreground">{releasing}</span> of {total} test{total === 1 ? '' : 's'}
            {staying > 0 && (
              <>
                . <span>{staying}</span> stays in draft.
              </>
            )}
          </div>
          {blocked > 0 && (
            <div className="flex items-center gap-1 text-amber-700">
              <AlertTriangle className="h-3 w-3 flex-shrink-0" />
              {blocked} test{blocked === 1 ? '' : 's'} cannot ship yet — upload pending.
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => onConfirm(Array.from(selected))}
            disabled={busy || releasing === 0}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
