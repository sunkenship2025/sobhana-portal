/**
 * Templates. Meta owns approval; this screen owns knowing.
 *
 * Every status is shown, not only APPROVED — the moment that matters most is a
 * REJECTED template and the journeys it just stopped, and hiding the row is what made
 * that impossible to see.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { LoadingState } from '@/components/ui/loading-state';
import { listTemplates, listAutomations, type TemplateSummary } from './api';

function statusTone(s: string) {
  if (s === 'APPROVED') return 'border-emerald-200 text-emerald-700';
  if (s === 'REJECTED' || s === 'DISABLED') return 'border-destructive/30 text-destructive';
  return 'border-amber-200 text-amber-700';
}

export function TemplatesTab() {
  const [open, setOpen] = useState<TemplateSummary | null>(null);
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['templates'], queryFn: listTemplates,
  });
  const { data: automations } = useQuery({ queryKey: ['automations'], queryFn: listAutomations });

  if (isLoading) return <LoadingState />;
  const templates = data?.templates ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Templates</h2>
          <p className="text-sm text-muted-foreground">What a journey is allowed to say.</p>
        </div>
        <Button variant="secondary" disabled={isFetching} onClick={() => refetch()}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh from Meta
        </Button>
      </div>

      {templates.length === 0 ? (
        <p className="rounded-lg border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          No templates found. Check that the WhatsApp business account is configured.
        </p>
      ) : (
        <div className="divide-y rounded-lg border">
          {templates.map((t) => (
            <button key={`${t.name}-${t.language}`} onClick={() => setOpen(open?.name === t.name ? null : t)}
              className="w-full px-4 py-3 text-left hover:bg-muted/50">
              <div className="flex items-center gap-3">
                <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${
                  t.status === 'APPROVED' ? 'bg-emerald-500' : 'bg-destructive'}`} />
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-sm font-medium">{t.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t.language} · {t.paramCount} blank{t.paramCount === 1 ? '' : 's'}
                    {t.hasHeaderMedia && ' · needs a header image'}
                  </span>
                </span>
                <Badge variant="outline" className="shrink-0 text-[11px] font-normal">
                  {t.category === 'MARKETING' ? 'Marketing' : t.category === 'UTILITY' ? 'Utility' : 'Auth'}
                </Badge>
                <Badge variant="outline" className={`shrink-0 text-[11px] font-normal ${statusTone(t.status)}`}>
                  {t.status.charAt(0) + t.status.slice(1).toLowerCase()}
                </Badge>
              </div>

              {open?.name === t.name && (
                <div className="mt-3 space-y-3 border-t pt-3">
                  <div>
                    <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      What the patient sees
                    </p>
                    <div className="rounded-lg bg-[#e6ded5] p-3">
                      <div className="max-w-[320px] rounded-lg rounded-bl-sm bg-white px-3 py-2 text-[13px] leading-relaxed shadow-sm">
                        {t.bodyText || <span className="text-muted-foreground">No body text</span>}
                      </div>
                    </div>
                  </div>
                  {t.status !== 'APPROVED' && (
                    <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
                      <b>This template cannot be sent.</b> Any journey using it will pause itself rather
                      than keep firing — a campaign sending into a rejected template burns the number's
                      quality rating for every message the centre sends, report-ready included.
                    </p>
                  )}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
