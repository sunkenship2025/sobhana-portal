import { Cloud, CloudOff, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type AutoSyncStatus = 'idle' | 'unsaved' | 'saving' | 'saved' | 'error';

interface AutoSyncControlProps {
  /** Whether background auto-sync is on. */
  enabled: boolean;
  /** Flip the universal preference. */
  onToggle: (next: boolean) => void;
  /** Current save status — drives the manual Save button's label/enabled state. */
  status: AutoSyncStatus;
  /** Persist the current draft now (manual mode only). */
  onSaveNow: () => void;
}

/**
 * Small universal control for the report editors: a cloud toggle that switches
 * between auto-sync (draft saves in the background) and manual save. When
 * auto-sync is off, a Save button appears next to it. The preference itself
 * lives in the persisted reportSyncStore so it is remembered and shared across
 * every result-entry page.
 */
export function AutoSyncControl({ enabled, onToggle, status, onSaveNow }: AutoSyncControlProps) {
  const canSave = status === 'unsaved' || status === 'error';
  const saveLabel = status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : 'Save';

  return (
    <div className="flex items-center gap-2">
      {!enabled && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1.5"
          onClick={onSaveNow}
          disabled={status === 'saving' || !canSave}
        >
          <Save className="h-3.5 w-3.5" />
          {saveLabel}
        </Button>
      )}

      <button
        type="button"
        onClick={() => onToggle(!enabled)}
        aria-pressed={enabled}
        title={
          enabled
            ? 'Cloud sync on — changes save automatically. Click to switch to manual save.'
            : 'Cloud sync off — changes save only when you click Save. Click to turn auto-sync on.'
        }
        className={cn(
          'flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors',
          enabled
            ? 'border-primary/30 bg-primary/5 text-primary hover:bg-primary/10'
            : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted'
        )}
      >
        {enabled ? <Cloud className="h-4 w-4" /> : <CloudOff className="h-4 w-4" />}
        <span className="hidden sm:inline">{enabled ? 'Cloud sync' : 'Sync off'}</span>
      </button>
    </div>
  );
}
