/**
 * Creating one: pick what it should be, answer what it asks.
 *
 * Neither the list of kinds nor the shape of a definition lives here. The backend
 * serves blueprints — a title, and the questions that kind needs answered — and this
 * renders the questions and posts the answers back. Adding a new kind of automation is
 * an entry in blueprints.ts and nothing else; this file does not change.
 *
 * That is the same rule the condition vocabulary already follows, applied to the thing
 * one level up.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { LoadingState } from '@/components/ui/loading-state';
import { useBranchStore } from '@/store/branchStore';
import { toast } from 'sonner';
import {
  listBlueprints, createFromBlueprint, listTemplates,
  type Blueprint, type BlueprintField,
} from './api';

type Values = Record<string, unknown>;

export function CreateAutomation({ open, onClose, onCreated }: {
  open: boolean; onClose: () => void; onCreated: (id: string) => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [picked, setPicked] = useState<Blueprint | null>(null);
  const [name, setName] = useState('');
  const [values, setValues] = useState<Values>({});

  const { data, isLoading } = useQuery({
    queryKey: ['blueprints'], queryFn: listBlueprints, enabled: open,
  });
  const { data: templateData } = useQuery({
    queryKey: ['templates'], queryFn: listTemplates, enabled: open,
  });
  const branches = useBranchStore((s) => s.branches);

  // Defaults come from the blueprint, so the server decides them once.
  useEffect(() => {
    if (!picked) return;
    const next: Values = {};
    for (const f of picked.fields) if (f.default !== undefined) next[f.key] = f.default;
    setValues(next);
  }, [picked]);

  const create = useMutation({
    mutationFn: () => createFromBlueprint({
      blueprintId: picked!.id, name: name.trim() || undefined, values,
    }),
    onSuccess: (a) => {
      toast.success('Created as a draft. Nothing sends until you activate it.');
      reset();
      onCreated(a.id);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reset = () => { setStep(1); setPicked(null); setName(''); setValues({}); };

  const missing = useMemo(() => {
    if (!picked) return [];
    return picked.fields.filter((f) => {
      if (!f.required) return false;
      const v = values[f.key];
      return v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
    });
  }, [picked, values]);

  const groups = useMemo(() => {
    const list = data?.blueprints ?? [];
    return [...new Set(list.map((b) => b.group))].map((g) => ({
      group: g, items: list.filter((b) => b.group === g),
    }));
  }, [data]);

  const set = (key: string, v: unknown) => setValues((x) => ({ ...x, [key]: v }));

  const renderField = (f: BlueprintField) => {
    const v = values[f.key];
    switch (f.type) {
      case 'CHOICE':
        return (
          <div className="divide-y rounded-lg border">
            {(f.options ?? []).map((o) => (
              <button key={o.value} type="button" onClick={() => set(f.key, o.value)}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-muted/50">
                <span aria-hidden className={`h-3.5 w-3.5 shrink-0 rounded-full border-[3px] ${
                  v === o.value ? 'border-foreground' : 'border-muted-foreground/40'}`} />
                {o.label}
              </button>
            ))}
          </div>
        );
      case 'BRANCHES':
        return branches.length === 0 ? (
          <p className="rounded-lg border px-3 py-2.5 text-xs text-muted-foreground">
            No branches loaded.
          </p>
        ) : (
          <div className="max-h-40 divide-y overflow-y-auto rounded-lg border">
            {branches.map((b) => {
              const chosen = Array.isArray(v) ? (v as string[]) : [];
              return (
                <label key={b.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                  <Checkbox
                    checked={chosen.includes(b.id)}
                    onCheckedChange={() =>
                      set(f.key, chosen.includes(b.id)
                        ? chosen.filter((x) => x !== b.id)
                        : [...chosen, b.id])}
                  />
                  <span>{b.name}</span>
                </label>
              );
            })}
          </div>
        );
      case 'TEMPLATE': {
        const list = (templateData?.templates ?? [])
          .filter((t) => (f.approvedOnly ? t.status === 'APPROVED' : true));
        return list.length === 0 ? (
          <p className="rounded-lg border border-amber-200 bg-amber-50/50 px-3 py-2.5 text-xs">
            No approved templates yet. You can still create the draft — a step naming an unapproved
            template is refused at save, so nothing goes out by accident.
          </p>
        ) : (
          <div className="max-h-40 divide-y overflow-y-auto rounded-lg border">
            {list.map((t) => (
              <button key={t.name} type="button" onClick={() => set(f.key, t.name)}
                className={`block w-full px-3 py-2 text-left hover:bg-muted/50 ${
                  v === t.name ? 'bg-muted' : ''}`}>
                <span className="block font-mono text-sm">{t.name}</span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {t.bodyText.slice(0, 90)}
                </span>
              </button>
            ))}
          </div>
        );
      }
      case 'TIME':
        return <Input type="time" className="w-32" value={String(v ?? '')}
          onChange={(e) => set(f.key, e.target.value)} />;
      case 'NUMBER':
        return <Input className="w-28" value={String(v ?? '')}
          onChange={(e) => set(f.key, e.target.value === '' ? undefined : Number(e.target.value))} />;
      default:
        return <Input value={String(v ?? '')} onChange={(e) => set(f.key, e.target.value)} />;
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { reset(); onClose(); } }}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{step === 1 ? 'Create automation' : picked?.title}</DialogTitle>
          <DialogDescription>
            {step === 1
              ? 'What do you want to automate?'
              : 'Created as a draft — every step can be changed before you activate it.'}
          </DialogDescription>
        </DialogHeader>

        {step === 1 ? (
          isLoading ? <LoadingState /> : (
            <div className="space-y-4">
              {groups.map((g) => (
                <div key={g.group}>
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {g.group}
                  </p>
                  <div className="divide-y rounded-lg border">
                    {g.items.map((b) => (
                      <button key={b.id} onClick={() => { setPicked(b); setStep(2); }}
                        className="flex w-full items-start gap-3 px-3 py-3 text-left hover:bg-muted/50">
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium">{b.title}</span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">{b.sub}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )
        ) : picked && (
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Name</Label>
              <Input className="mt-1.5" placeholder={picked.title}
                value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            {picked.fields.map((f) => (
              <div key={f.key}>
                <Label className="text-xs">
                  {f.label}{f.required && <span className="ml-1 text-muted-foreground">·  required</span>}
                </Label>
                <div className="mt-1.5">{renderField(f)}</div>
                {f.help && <p className="mt-1.5 text-xs text-muted-foreground">{f.help}</p>}
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          {step === 2 && <Button variant="outline" onClick={() => setStep(1)}>Back</Button>}
          <Button variant="outline" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          {step === 2 && (
            <Button disabled={create.isPending || missing.length > 0} onClick={() => create.mutate()}>
              {create.isPending ? 'Creating…'
                : missing.length > 0 ? `Needs ${missing[0].label.toLowerCase()}`
                : 'Create draft'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
