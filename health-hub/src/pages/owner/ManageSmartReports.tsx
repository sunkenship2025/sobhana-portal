import { useEffect, useState } from 'react';
import { branchRequest, useBranchId } from '@/lib/query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { Sparkles, Loader2 } from 'lucide-react';

interface Config {
  enabled: boolean;
  recommendationsEnabled: boolean;
  futureTestsEnabled: boolean;
  trendsEnabled: boolean;
  essentialsEnabled: boolean;
  language: string;
  accentColor: string;
  tagline: string | null;
  websiteLine: string | null;
  disclaimerOverride: string | null;
  minScoredParameters: number;
  minPatientAgeYears: number;
  maxFindingPages: number;
  model: string;
}

const TOGGLES: { key: keyof Config; label: string; hint: string }[] = [
  { key: 'enabled', label: 'Smart Reports', hint: 'Master switch. Off means nothing is generated and nothing is shown to patients.' },
  { key: 'recommendationsEnabled', label: 'Diet & lifestyle advice', hint: 'The Health Advisory page. Off leaves results and explanations only.' },
  { key: 'futureTestsEnabled', label: 'Suggested follow-up tests', hint: 'Only ever suggests tests this centre actually sells.' },
  { key: 'trendsEnabled', label: 'Comparison with last visit', hint: 'Compares only when the unit matches. Never converts units.' },
  { key: 'essentialsEnabled', label: 'Health Essentials page', hint: 'BMI, calories and macros. Hidden automatically when height or weight is missing.' },
];

export default function ManageSmartReports() {
  const branchId = useBranchId();
  const [cfg, setCfg] = useState<Config | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    branchRequest<Config>('/smart-reports/config', branchId)
      .then(setCfg)
      .catch(() => toast.error('Could not load Smart Report settings'));
  }, [branchId]);

  const set = <K extends keyof Config>(k: K, v: Config[K]) =>
    setCfg((c) => (c ? { ...c, [k]: v } : c));

  const save = async () => {
    if (!cfg) return;
    setSaving(true);
    try {
      await branchRequest('/smart-reports/config', branchId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      toast.success('Smart Report settings saved');
    } catch {
      toast.error('Could not save settings');
    } finally {
      setSaving(false);
    }
  };

  if (!cfg) {
    return (
      <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading settings…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <Sparkles className="mt-1 h-5 w-5 text-primary" />
        <div>
          <h2 className="text-lg font-semibold">Smart Reports</h2>
          <p className="text-sm text-muted-foreground">
            A plain-language version of the finalized report for the patient. Generated only at the
            final finalize, and only for packages you have switched on under Billable Products.
          </p>
        </div>
      </div>

      <div className="space-y-4 rounded-lg border p-4">
        {TOGGLES.map((t) => (
          <div key={t.key} className="flex items-start justify-between gap-6">
            <div>
              <Label className="text-sm font-medium">{t.label}</Label>
              <p className="text-xs text-muted-foreground">{t.hint}</p>
            </div>
            <Switch
              checked={Boolean(cfg[t.key])}
              onCheckedChange={(v) => set(t.key, v as never)}
            />
          </div>
        ))}
      </div>

      <Separator />

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label className="text-sm">Tagline under the logo</Label>
          <Input value={cfg.tagline ?? ''} onChange={(e) => set('tagline', e.target.value)}
            placeholder="Accurate Results, Explained Simply" />
        </div>
        <div>
          <Label className="text-sm">Website line</Label>
          <Input value={cfg.websiteLine ?? ''} onChange={(e) => set('websiteLine', e.target.value)}
            placeholder="www.example.in" />
        </div>
        <div>
          <Label className="text-sm">Accent colour</Label>
          <Input value={cfg.accentColor} onChange={(e) => set('accentColor', e.target.value)} placeholder="#3FA34D" />
        </div>
        <div>
          <Label className="text-sm">Model</Label>
          <Input value={cfg.model} onChange={(e) => set('model', e.target.value)} placeholder="deepseek-chat" />
        </div>
        <div>
          <Label className="text-sm">Minimum parameters to score</Label>
          <Input type="number" value={cfg.minScoredParameters}
            onChange={(e) => set('minScoredParameters', Number(e.target.value))} />
          <p className="mt-1 text-xs text-muted-foreground">Below this the report is skipped — a Smart Report over two analytes is noise.</p>
        </div>
        <div>
          <Label className="text-sm">Minimum patient age</Label>
          <Input type="number" value={cfg.minPatientAgeYears}
            onChange={(e) => set('minPatientAgeYears', Number(e.target.value))} />
          <p className="mt-1 text-xs text-muted-foreground">Adult calorie and diet formulas are wrong for children, so younger patients are skipped rather than given bad advice.</p>
        </div>
      </div>

      <div>
        <Label className="text-sm">Disclaimer override</Label>
        <Textarea rows={3} value={cfg.disclaimerOverride ?? ''}
          onChange={(e) => set('disclaimerOverride', e.target.value)}
          placeholder="Leave blank to use the standard disclaimer." />
        <p className="mt-1 text-xs text-muted-foreground">
          The standard text already states that this is not a diagnosis, and that a patient already
          under treatment may have different targets from their doctor.
        </p>
      </div>

      <div className="flex justify-end">
        <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</Button>
      </div>
    </div>
  );
}
