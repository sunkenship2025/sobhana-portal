/**
 * ItemInspector — the Report Builder's per-test inspector (Figma-style side panel).
 *
 * Presentation fields (display label, subgroup, indent, style, per-test method)
 * patch the panel item locally — no version. The canonical clinical contract
 * (unit, default range, criticals, age/gender ranges, formula, interpretation
 * mode) is a versioned TestDefinition edit: it loads the FULL current definition,
 * and "Save as new version" POSTs /clinical-definitions/:rootId/new-version with
 * If-Match, sending ONLY what changed (omitted fields/arrays are preserved by the
 * backend's pick()/`?? current` fallback), then re-points the item to the new
 * version. Value-input (type/presets/default) is unversioned TestInputConfig.
 */
import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '@/lib/api';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2, AlertTriangle, MousePointerClick } from 'lucide-react';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  TestInputConfigEditor, defaultInputConfig, type TestInputConfigPayload,
} from '@/components/diagnostics/TestInputConfigEditor';

const INTERP_MODES = ['NONE', 'RANGE_BASED', 'TEXT_MATCH', 'FORMULA'];
const YEAR = 365;

export interface InspectorItem {
  testDefinitionId: string;
  code: string; name: string;
  displayLabel: string | null; subGroup: string | null;
  indentLevel: number; isBold: boolean; isItalic: boolean;
  methodText: string | null;
}
export interface CanonicalPatch {
  testDefinitionId: string;
  referenceUnit: string | null; referenceMin: number | null; referenceMax: number | null;
  referenceText: string | null; criticalMin: number | null; criticalMax: number | null;
  method: string | null;
}

interface RangeRow {
  category: string | null; gender: string | null;
  minAgeDays: number | null; maxAgeDays: number | null;
  referenceMin: number | null; referenceMax: number | null;
  referenceUnit: string | null; referenceText: string | null;
  criticalMin: number | null; criticalMax: number | null;
}

const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s));

/** The inspector CONTENT — embedded directly in the dock (no slide-over). */
export function ItemInspectorBody({
  item, headers, showSubgroup, onPatch, onCanonicalSaved, focusRanges,
}: {
  item: InspectorItem | null;
  headers: Record<string, string>;
  showSubgroup: boolean;
  onPatch: (patch: Partial<InspectorItem>) => void;
  onCanonicalSaved: (patch: CanonicalPatch) => void;
  focusRanges?: number;
}) {
  const rangesRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [def, setDef] = useState<any>(null); // full current definition
  const [canon, setCanon] = useState({
    referenceUnit: '', referenceMin: '', referenceMax: '', referenceText: '',
    criticalMin: '', criticalMax: '', formulaExpression: '', dependsOnCodes: '',
    interpretationMode: 'NONE', method: '',
  });
  const [ranges, setRanges] = useState<RangeRow[]>([]);
  const [canonDirty, setCanonDirty] = useState(false);
  const [inputCfg, setInputCfg] = useState<TestInputConfigPayload | null>(null);
  const [cfgDirty, setCfgDirty] = useState(false);

  const rootId = def?.rootDefinitionId as string | undefined;
  const isActive = def?.status === 'ACTIVE';

  useEffect(() => {
    if (!item) return;
    let cancelled = false;
    setLoading(true);
    setCanonDirty(false); setCfgDirty(false); setInputCfg(null);
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/clinical-definitions/${item.testDefinitionId}`, { headers });
        if (!res.ok) throw new Error('Failed to load definition');
        const d = await res.json();
        if (cancelled) return;
        setDef(d);
        setCanon({
          referenceUnit: d.referenceUnit ?? '',
          referenceMin: d.referenceMin?.toString() ?? '',
          referenceMax: d.referenceMax?.toString() ?? '',
          referenceText: d.referenceText ?? '',
          criticalMin: d.criticalMin?.toString() ?? '',
          criticalMax: d.criticalMax?.toString() ?? '',
          formulaExpression: d.formulaExpression ?? '',
          dependsOnCodes: Array.isArray(d.dependsOnCodes) ? d.dependsOnCodes.join(', ') : '',
          interpretationMode: d.interpretationMode ?? 'NONE',
          method: d.method ?? '',
        });
        setRanges((d.ranges ?? []).map((r: any) => ({
          category: r.category ?? null, gender: r.gender ?? null,
          minAgeDays: r.minAgeDays ?? null, maxAgeDays: r.maxAgeDays ?? null,
          referenceMin: r.referenceMin ?? null, referenceMax: r.referenceMax ?? null,
          referenceUnit: r.referenceUnit ?? null, referenceText: r.referenceText ?? null,
          criticalMin: r.criticalMin ?? null, criticalMax: r.criticalMax ?? null,
        })));
        // input config (unversioned)
        const cfgRes = await fetch(`${API_BASE}/test-input-configs/${d.rootDefinitionId}`, { headers });
        if (cfgRes.ok && !cancelled) {
          const c = await cfgRes.json();
          setInputCfg({
            rootDefinitionId: d.rootDefinitionId,
            inputType: c.inputType ?? 'NUMERIC',
            defaultValue: c.defaultValue ?? '',
            valueOptions: Array.isArray(c.valueOptions) ? c.valueOptions : [],
          });
        } else if (!cancelled) {
          setInputCfg(defaultInputConfig(d.rootDefinitionId));
        }
      } catch (e) {
        if (!cancelled) toast.error((e as Error).message || 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.testDefinitionId]);

  useEffect(() => { if (focusRanges) rangesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [focusRanges]);

  const setC = (patch: Partial<typeof canon>) => { setCanon((c) => ({ ...c, ...patch })); setCanonDirty(true); };
  const patchRange = (i: number, patch: Partial<RangeRow>) => {
    setRanges((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r))); setCanonDirty(true);
  };
  const addRange = () => { setRanges((rs) => [...rs, { category: null, gender: null, minAgeDays: null, maxAgeDays: null, referenceMin: null, referenceMax: null, referenceUnit: null, referenceText: null, criticalMin: null, criticalMax: null }]); setCanonDirty(true); };
  const delRange = (i: number) => { setRanges((rs) => rs.filter((_, idx) => idx !== i)); setCanonDirty(true); };

  const saveNewVersion = async () => {
    if (!def || !rootId) return;
    if (!isActive) { toast.error(`Can't edit a ${def.status} version — this test isn't the active latest.`); return; }
    setSaving(true);
    try {
      const body: any = {
        // scalars — sending current-or-edited values (unchanged ones are a no-op)
        referenceUnit: canon.referenceUnit || null,
        referenceMin: numOrNull(canon.referenceMin),
        referenceMax: numOrNull(canon.referenceMax),
        referenceText: canon.referenceText || null,
        criticalMin: numOrNull(canon.criticalMin),
        criticalMax: numOrNull(canon.criticalMax),
        formulaExpression: canon.formulaExpression || null,
        dependsOnCodes: canon.dependsOnCodes ? canon.dependsOnCodes.split(',').map((s) => s.trim()).filter(Boolean) : [],
        interpretationMode: canon.interpretationMode,
        method: canon.method || null,
        // ranges: full array (add/edit/delete honored). interpretationRules OMITTED → preserved.
        ranges: ranges.map((r) => ({
          minAgeDays: r.minAgeDays, maxAgeDays: r.maxAgeDays,
          gender: r.gender || null, category: r.category || null, categoryLabel: null,
          referenceMin: r.referenceMin, referenceMax: r.referenceMax,
          referenceUnit: r.referenceUnit || null, referenceText: r.referenceText || null,
          criticalMin: r.criticalMin, criticalMax: r.criticalMax,
        })),
      };
      const res = await fetch(`${API_BASE}/clinical-definitions/${rootId}/new-version`, {
        method: 'POST',
        headers: { ...headers, 'If-Match': def.updatedAt ?? '' },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.message || `Save failed (${res.status})`); }
      const nd = await res.json();
      toast.success(`${nd.code} v${nd.version} created`);
      setDef(nd);
      setCanonDirty(false);
      onCanonicalSaved({
        testDefinitionId: nd.id,
        referenceUnit: nd.referenceUnit ?? null,
        referenceMin: nd.referenceMin ?? null, referenceMax: nd.referenceMax ?? null,
        referenceText: nd.referenceText ?? null,
        criticalMin: nd.criticalMin ?? null, criticalMax: nd.criticalMax ?? null,
        method: nd.method ?? null,
      });
    } catch (e) {
      toast.error((e as Error).message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const saveInputConfig = async () => {
    if (!rootId || !inputCfg) return;
    try {
      const res = await fetch(`${API_BASE}/test-input-configs/${rootId}`, {
        method: 'PUT', headers, body: JSON.stringify(inputCfg),
      });
      if (!res.ok) throw new Error('Failed to save input config');
      toast.success('Value-input settings saved');
      setCfgDirty(false);
    } catch (e) {
      toast.error((e as Error).message || 'Save failed');
    }
  };

  if (!item) {
    return (
      <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground">
        <MousePointerClick className="h-6 w-6 opacity-50" />
        Select a test row on the report (or its ⚙) to edit its clinical contract — units, reference ranges, critical values, input type and formula.
      </div>
    );
  }
  return (
    <div className="p-4">
      <div className="mb-0.5 flex items-baseline gap-2">
        <span className="font-semibold">{item.displayLabel || item.name}</span>
        <span className="text-xs font-mono text-muted-foreground">{item.code}</span>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">Presentation is per-report; unit/ranges/formula are the versioned clinical contract.</p>
      {loading && <div className="py-16 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}
      {!loading && (
          <div className="space-y-5">
            {/* Presentation */}
            <section className="space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Layout in this panel · no version</h4>
              <div className="space-y-1.5">
                <Label className="text-xs">Display label</Label>
                <Input value={item.displayLabel ?? ''} onChange={(e) => onPatch({ displayLabel: e.target.value || null })} placeholder={item.name} />
              </div>
              {showSubgroup && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Subgroup</Label>
                  <Input value={item.subGroup ?? ''} onChange={(e) => onPatch({ subGroup: e.target.value || null })} placeholder="e.g. DIFFERENTIAL COUNT" />
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">Indent</Label>
                  <Select value={String(item.indentLevel)} onValueChange={(v) => onPatch({ indentLevel: Number(v) })}>
                    <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                    <SelectContent>{[0, 1, 2].map((n) => <SelectItem key={n} value={String(n)}>{n === 0 ? 'None' : n}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Style</Label>
                  <Select value={item.isBold ? 'bold' : item.isItalic ? 'italic' : 'normal'} onValueChange={(v) => onPatch({ isBold: v === 'bold', isItalic: v === 'italic' })}>
                    <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="normal">Normal</SelectItem><SelectItem value="bold">Bold</SelectItem><SelectItem value="italic">Italic</SelectItem></SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Per-test method (shows live)</Label>
                <Input value={item.methodText ?? ''} onChange={(e) => onPatch({ methodText: e.target.value || null })} placeholder="e.g. ECLIA" />
              </div>
            </section>

            <Separator />

            {/* Value input — unversioned */}
            {inputCfg && rootId && (
              <section className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Value input · TestInputConfig</h4>
                <TestInputConfigEditor rootDefinitionId={rootId} config={inputCfg} testLabel={item.name} onChange={(c) => { setInputCfg(c); setCfgDirty(true); }} />
                {cfgDirty && <Button size="sm" variant="secondary" onClick={saveInputConfig}>Save value-input settings</Button>}
              </section>
            )}

            <Separator />

            {/* Canonical contract — versioned */}
            <section className="space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Clinical contract · TestDefinition {def && <span className="font-normal normal-case">· v{def.version} {def.status}</span>}</h4>
              {!isActive && def && (
                <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" /> This is a {def.status} version — canonical edits are locked. It should re-point to the active latest on save.
                </div>
              )}
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1.5"><Label className="text-xs">Unit</Label><Input value={canon.referenceUnit} onChange={(e) => setC({ referenceUnit: e.target.value })} disabled={!isActive} /></div>
                <div className="space-y-1.5"><Label className="text-xs">Ref min</Label><Input value={canon.referenceMin} onChange={(e) => setC({ referenceMin: e.target.value })} disabled={!isActive} /></div>
                <div className="space-y-1.5"><Label className="text-xs">Ref max</Label><Input value={canon.referenceMax} onChange={(e) => setC({ referenceMax: e.target.value })} disabled={!isActive} /></div>
              </div>
              <div className="space-y-1.5"><Label className="text-xs">…or text range (e.g. Negative)</Label><Input value={canon.referenceText} onChange={(e) => setC({ referenceText: e.target.value })} disabled={!isActive} /></div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5"><Label className="text-xs">Critical low</Label><Input value={canon.criticalMin} onChange={(e) => setC({ criticalMin: e.target.value })} disabled={!isActive} /></div>
                <div className="space-y-1.5"><Label className="text-xs">Critical high</Label><Input value={canon.criticalMax} onChange={(e) => setC({ criticalMax: e.target.value })} disabled={!isActive} /></div>
              </div>

              {/* Age / gender variants */}
              <div className="space-y-2" ref={rangesRef}>
                <Label className="text-xs">Age / gender variants</Label>
                {ranges.map((r, i) => (
                  <div key={i} className="rounded-md border p-2 space-y-2">
                    <div className="flex items-center gap-2">
                      <Select value={r.gender ?? '__none__'} onValueChange={(v) => patchRange(i, { gender: v === '__none__' ? null : v })}>
                        <SelectTrigger className="h-7 text-xs w-24"><SelectValue /></SelectTrigger>
                        <SelectContent><SelectItem value="__none__">All</SelectItem><SelectItem value="M">Male</SelectItem><SelectItem value="F">Female</SelectItem><SelectItem value="O">Other</SelectItem></SelectContent>
                      </Select>
                      <Input className="h-7 text-xs" placeholder="min age (y)" value={r.minAgeDays == null ? '' : Math.round(r.minAgeDays / YEAR)} onChange={(e) => patchRange(i, { minAgeDays: e.target.value === '' ? null : Number(e.target.value) * YEAR })} disabled={!isActive} />
                      <Input className="h-7 text-xs" placeholder="max age (y)" value={r.maxAgeDays == null ? '' : Math.round(r.maxAgeDays / YEAR)} onChange={(e) => patchRange(i, { maxAgeDays: e.target.value === '' ? null : Number(e.target.value) * YEAR })} disabled={!isActive} />
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => delRange(i)} disabled={!isActive}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </div>
                    <div className="flex items-center gap-2">
                      <Input className="h-7 text-xs" placeholder="min" value={r.referenceMin ?? ''} onChange={(e) => patchRange(i, { referenceMin: numOrNull(e.target.value) })} disabled={!isActive} />
                      <span className="text-muted-foreground">–</span>
                      <Input className="h-7 text-xs" placeholder="max" value={r.referenceMax ?? ''} onChange={(e) => patchRange(i, { referenceMax: numOrNull(e.target.value) })} disabled={!isActive} />
                    </div>
                  </div>
                ))}
                <Button variant="outline" size="sm" className="w-full" onClick={addRange} disabled={!isActive}><Plus className="h-3.5 w-3.5 mr-1" /> Add variant</Button>
              </div>

              <div className="space-y-1.5"><Label className="text-xs">Derived formula</Label><Input className="font-mono" value={canon.formulaExpression} onChange={(e) => setC({ formulaExpression: e.target.value })} placeholder="e.g. (ALB / GLOB)" disabled={!isActive} /></div>
              <div className="space-y-1.5"><Label className="text-xs">Depends on (codes, comma-sep)</Label><Input value={canon.dependsOnCodes} onChange={(e) => setC({ dependsOnCodes: e.target.value })} placeholder="ALB, GLOB" disabled={!isActive} /></div>
              <div className="space-y-1.5">
                <Label className="text-xs">Interpretation mode</Label>
                <Select value={canon.interpretationMode} onValueChange={(v) => setC({ interpretationMode: v })} disabled={!isActive}>
                  <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                  <SelectContent>{INTERP_MODES.map((m) => <SelectItem key={m} value={m}>{m.replace(/_/g, ' ')}</SelectItem>)}</SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">Interpretation rules (value → text) are edited in the Clinical Definitions tab and preserved across versions here.</p>
              </div>

              {canonDirty && isActive && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-2">
                  <p className="text-xs text-amber-800">Canonical change → this locks v{def?.version} and mints v{(def?.version ?? 1) + 1}, re-pointing every report that uses this test.</p>
                  <Button size="sm" className="w-full" onClick={saveNewVersion} disabled={saving}>
                    {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} Save as new version
                  </Button>
                </div>
              )}
            </section>
          </div>
      )}
    </div>
  );
}

/** Slide-over wrapper — kept for any non-dock use; the builder embeds the body directly. */
export function ItemInspector(props: {
  item: InspectorItem | null; open: boolean; onOpenChange: (v: boolean) => void;
  headers: Record<string, string>; showSubgroup: boolean;
  onPatch: (patch: Partial<InspectorItem>) => void; onCanonicalSaved: (patch: CanonicalPatch) => void;
}) {
  const { open, onOpenChange, ...body } = props;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto p-0">
        <SheetHeader className="sr-only"><SheetTitle>Test inspector</SheetTitle><SheetDescription>Edit the clinical contract</SheetDescription></SheetHeader>
        <ItemInspectorBody {...body} />
      </SheetContent>
    </Sheet>
  );
}
