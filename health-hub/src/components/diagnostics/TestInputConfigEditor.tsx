import { useState, useEffect, useRef } from 'react';
import { AlertCircle, GripVertical, Plus, Trash2, X } from 'lucide-react';
import { API_BASE } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { TestValueCombobox } from '@/components/diagnostics/TestValueCombobox';

export type TestInputType = 'NUMERIC' | 'FREE_TEXT' | 'TEXT_WITH_PRESETS' | 'SELECT_ONLY';

export interface TestInputConfigPayload {
  rootDefinitionId: string;
  inputType: TestInputType;
  defaultValue: string | null;
  valueOptions: string[];
}

const INPUT_TYPE_OPTIONS: { value: TestInputType; label: string; hint: string }[] = [
  { value: 'NUMERIC', label: 'Numeric', hint: 'Decimal-keypad number input' },
  { value: 'FREE_TEXT', label: 'Free text', hint: 'Plain text input' },
  { value: 'TEXT_WITH_PRESETS', label: 'Combobox', hint: 'Preset list + custom typing' },
  { value: 'SELECT_ONLY', label: 'Strict dropdown', hint: 'Locked to listed values' },
];

interface Props {
  rootDefinitionId: string;
  config: TestInputConfigPayload;
  onChange: (next: TestInputConfigPayload) => void;
  /** Optional: when present, shown in summary row above the form */
  testLabel?: string;
}

export function TestInputConfigEditor({ rootDefinitionId, config, onChange, testLabel }: Props) {
  const showPresets =
    config.inputType === 'TEXT_WITH_PRESETS' || config.inputType === 'SELECT_ONLY';
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const dragIndexRef = useRef<number | null>(null);

  const update = (patch: Partial<TestInputConfigPayload>) => {
    onChange({ ...config, ...patch });
  };

  const setOption = (idx: number, next: string) => {
    const out = [...config.valueOptions];
    out[idx] = next;
    update({ valueOptions: out });
  };

  const addOption = () => {
    update({ valueOptions: [...config.valueOptions, ''] });
  };

  const removeOption = (idx: number) => {
    update({ valueOptions: config.valueOptions.filter((_, i) => i !== idx) });
  };

  const reorder = (from: number, to: number) => {
    if (from === to) return;
    const out = [...config.valueOptions];
    const [moved] = out.splice(from, 1);
    out.splice(to, 0, moved);
    update({ valueOptions: out });
  };

  const applyBulk = () => {
    const lines = bulkText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const v of [...config.valueOptions, ...lines]) {
      const t = v.trim();
      if (!t) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      merged.push(t);
    }
    update({ valueOptions: merged });
    setBulkText('');
    setBulkOpen(false);
  };

  return (
    <div className="space-y-4">
      {testLabel && (
        <p className="text-xs text-muted-foreground">
          Editing input config for <span className="font-medium text-foreground">{testLabel}</span>{' '}
          (shared across every version, every panel that uses it).
        </p>
      )}

      <div className="space-y-2">
        <Label>Input type</Label>
        <div className="grid grid-cols-2 gap-2">
          {INPUT_TYPE_OPTIONS.map((opt) => {
            const checked = config.inputType === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => update({ inputType: opt.value })}
                className={cn(
                  'flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left text-sm transition-colors',
                  checked
                    ? 'border-primary bg-primary/5 ring-1 ring-primary/40'
                    : 'border-border hover:bg-muted'
                )}
              >
                <span className="font-medium">{opt.label}</span>
                <span className="text-xs text-muted-foreground">{opt.hint}</span>
              </button>
            );
          })}
        </div>
      </div>

      {showPresets && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Preset values</Label>
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => setBulkOpen((s) => !s)}>
                {bulkOpen ? 'Cancel bulk' : 'Bulk paste'}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={addOption}>
                <Plus className="h-3 w-3 mr-1" /> Add
              </Button>
            </div>
          </div>

          {bulkOpen && (
            <div className="space-y-2 rounded-md border border-dashed bg-muted/30 p-2">
              <Textarea
                rows={6}
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                placeholder={'NORMOCYTIC/NORMOCHROMIC\nNORMOCYTIC/HYPOCHROMIC\nMICROCYTIC/HYPOCHROMIC\n…'}
              />
              <div className="flex justify-end gap-2">
                <Button type="button" size="sm" variant="ghost" onClick={() => { setBulkText(''); setBulkOpen(false); }}>
                  Cancel
                </Button>
                <Button type="button" size="sm" onClick={applyBulk} disabled={!bulkText.trim()}>
                  Append {bulkText.split(/\r?\n/).filter((l) => l.trim()).length} value(s)
                </Button>
              </div>
            </div>
          )}

          {config.valueOptions.length === 0 ? (
            <p className="text-sm text-muted-foreground py-3 text-center">
              No preset values yet. Click <span className="font-medium">Add</span> or paste a list.
            </p>
          ) : (
            <ul className="space-y-1">
              {config.valueOptions.map((opt, idx) => (
                <li
                  key={idx}
                  draggable
                  onDragStart={() => { dragIndexRef.current = idx; }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragIndexRef.current !== null) reorder(dragIndexRef.current, idx);
                    dragIndexRef.current = null;
                  }}
                  className="flex items-center gap-1 rounded-md border bg-background p-1"
                >
                  <span className="cursor-grab px-1 text-muted-foreground" aria-label="Drag to reorder">
                    <GripVertical className="h-4 w-4" />
                  </span>
                  <Input
                    value={opt}
                    onChange={(e) => setOption(idx, e.target.value)}
                    placeholder="Value"
                    className="border-0 shadow-none focus-visible:ring-0"
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => removeOption(idx)}
                    aria-label="Remove value"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/*
        Default value renders differently per input type so the admin can't
        configure an unselectable default (e.g. text "MAYBE" when the strict
        dropdown only allows "Positive" / "Negative").
        • NUMERIC          → number-only input
        • FREE_TEXT        → plain text input
        • TEXT_WITH_PRESETS→ combobox (pick from presets or type custom — same
                              widget the tech uses at result entry, so the
                              admin can preview the runtime UX)
        • SELECT_ONLY      → select limited to preset values; disabled until
                              presets exist, since strict dropdowns can't
                              accept arbitrary text.
      */}
      {(() => {
        const dv = config.defaultValue ?? '';
        // A freshly-added preset row is an empty string until the admin types
        // into it. Never surface those as pickable options: an empty-string
        // <SelectItem> makes Radix Select throw ("must have a value prop that
        // is not an empty string") and blanks the page. Filtering here also
        // heals any blank option that slipped into saved data.
        const presetOptions = config.valueOptions.filter((o) => o.trim() !== '');
        const numericInvalid =
          config.inputType === 'NUMERIC' && dv !== '' && Number.isNaN(Number(dv));
        const selectInvalid =
          config.inputType === 'SELECT_ONLY' && dv !== '' && !config.valueOptions.includes(dv);

        return (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Default value (optional)</Label>
              {dv && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px] text-muted-foreground"
                  onClick={() => update({ defaultValue: null })}
                >
                  <X className="h-3 w-3 mr-1" /> Clear
                </Button>
              )}
            </div>

            {config.inputType === 'NUMERIC' && (
              <Input
                value={dv}
                onChange={(e) => update({ defaultValue: e.target.value })}
                inputMode="decimal"
                pattern="[0-9.\-]*"
                placeholder="e.g., 14"
              />
            )}

            {config.inputType === 'FREE_TEXT' && (
              <Input
                value={dv}
                onChange={(e) => update({ defaultValue: e.target.value })}
                placeholder="e.g., Negative"
              />
            )}

            {config.inputType === 'TEXT_WITH_PRESETS' && (
              presetOptions.length === 0 ? (
                <Input
                  value={dv}
                  onChange={(e) => update({ defaultValue: e.target.value })}
                  placeholder="Add presets above, or type a custom default"
                />
              ) : (
                <TestValueCombobox
                  value={dv}
                  onChange={(next) => update({ defaultValue: next })}
                  options={presetOptions}
                  allowCustom={true}
                  placeholder="Pick a preset or type custom…"
                />
              )
            )}

            {config.inputType === 'SELECT_ONLY' && (
              presetOptions.length === 0 ? (
                <div className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  Add at least one preset above to pick a default. A strict
                  dropdown can't accept values that aren't in the list.
                </div>
              ) : (
                <Select
                  value={dv || '__none__'}
                  onValueChange={(v) => update({ defaultValue: v === '__none__' ? null : v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Pick a preset…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No default</SelectItem>
                    {presetOptions.map((opt) => (
                      <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )
            )}

            {numericInvalid && (
              <p className="flex items-center gap-1 text-xs text-amber-600">
                <AlertCircle className="h-3 w-3" /> Default isn't a number — it
                won't pre-fill correctly for a numeric test.
              </p>
            )}
            {selectInvalid && (
              <p className="flex items-center gap-1 text-xs text-amber-600">
                <AlertCircle className="h-3 w-3" /> Default "{dv}" isn't in the
                preset list above — strict dropdown will reject it. Pick a
                preset or clear the default.
              </p>
            )}

            <p className="text-xs text-muted-foreground">
              Pre-fills the field when the tech opens the form (only when no
              value is saved).
            </p>
          </div>
        );
      })()}

      <p className="text-[11px] text-muted-foreground">
        Saved per <span className="font-mono">rootDefinitionId</span>: <span className="font-mono">{rootDefinitionId}</span>
      </p>
    </div>
  );
}

/* ───────── Hook & helpers ───────── */

export function defaultInputConfig(rootDefinitionId: string): TestInputConfigPayload {
  return {
    rootDefinitionId,
    inputType: 'NUMERIC',
    defaultValue: null,
    valueOptions: [],
  };
}

/**
 * Fetch + save helpers for TestInputConfig.
 * Uses the same auth-token pattern as the rest of the portal.
 */
export function useTestInputConfig(rootDefinitionId: string | null | undefined) {
  const token = useAuthStore((s) => s.token);
  const [config, setConfig] = useState<TestInputConfigPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!rootDefinitionId) {
      setConfig(null);
      return;
    }
    setLoading(true);
    fetch(`${API_BASE}/test-input-configs/${rootDefinitionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((data) => {
        if (cancelled) return;
        setConfig({
          rootDefinitionId: data.rootDefinitionId ?? rootDefinitionId,
          inputType: data.inputType ?? 'NUMERIC',
          defaultValue: data.defaultValue ?? null,
          valueOptions: Array.isArray(data.valueOptions) ? data.valueOptions : [],
        });
      })
      .catch(() => {
        if (cancelled) return;
        setConfig(defaultInputConfig(rootDefinitionId));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [rootDefinitionId, token]);

  const save = async (next: TestInputConfigPayload) => {
    if (!rootDefinitionId) return false;
    setSaving(true);
    try {
      const cleanedOptions = next.valueOptions.map((v) => v.trim()).filter(Boolean);
      const body = {
        inputType: next.inputType,
        defaultValue: next.defaultValue?.trim() || null,
        valueOptions: cleanedOptions,
      };
      const res = await fetch(`${API_BASE}/test-input-configs/${rootDefinitionId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.message || 'Failed to save input config');
        return false;
      }
      const saved = await res.json();
      setConfig({
        rootDefinitionId: saved.rootDefinitionId,
        inputType: saved.inputType,
        defaultValue: saved.defaultValue,
        valueOptions: Array.isArray(saved.valueOptions) ? saved.valueOptions : [],
      });
      toast.success('Input config saved');
      return true;
    } catch (e: any) {
      toast.error(e.message || 'Failed to save input config');
      return false;
    } finally {
      setSaving(false);
    }
  };

  return { config, setConfig, loading, saving, save };
}

/** Compact one-liner summary for use in panel rows / list views. */
export function summarizeInputConfig(cfg: TestInputConfigPayload | null | undefined): string {
  if (!cfg) return 'Numeric (default)';
  const typeLabel =
    cfg.inputType === 'NUMERIC'
      ? 'Numeric'
      : cfg.inputType === 'FREE_TEXT'
        ? 'Free text'
        : cfg.inputType === 'TEXT_WITH_PRESETS'
          ? 'Combobox'
          : 'Strict dropdown';
  const parts: string[] = [typeLabel];
  if (cfg.valueOptions.length > 0) parts.push(`${cfg.valueOptions.length} preset(s)`);
  if (cfg.defaultValue) parts.push(`default "${cfg.defaultValue.length > 20 ? cfg.defaultValue.slice(0, 20) + '…' : cfg.defaultValue}"`);
  return parts.join(' · ');
}
