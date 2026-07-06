import { Cloud, CloudOff, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type AutoSyncStatus = 'idle' | 'unsaved' | 'saving' | 'saved' | 'error';

interface AutoSyncControlProps {
  /** Whether background auto-sync is on. */
  enabled: boolean;
  /** Flip the preference. */
  onToggle: (next: boolean) => void;
  /** Current save status — drives the manual Save button's label/enabled state. */
  status: AutoSyncStatus;
  /** Persist the current report now (manual mode only). */
  onSaveNow: () => void;
}

/**
 * Elegant cloud-sync switch that sits on top of each narrative/text report.
 * It reads like a form toggle: the cloud icon rides in the knob and slides
 * between a filled "on" track (Cloud) and a muted "off" track (CloudOff). When
 * sync is off, a Save button appears next to it to persist that report on
 * demand.
 */
export function AutoSyncControl({ enabled, onToggle, status, onSaveNow }: AutoSyncControlProps) {
  const canSave = status === 'unsaved' || status === 'error';
  const saveLabel = status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : 'Save';
  const hint = enabled ? 'Turn sync off' : 'Turn sync on';

  return (
    // Switch stays first so it never shifts when the Save button appears/hides.
    <div className="flex items-center gap-2">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={hint}
        title={hint}
        onClick={() => onToggle(!enabled)}
        className={cn(
          'relative inline-flex h-7 w-[52px] shrink-0 items-center rounded-full transition-colors duration-200',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-1',
          enabled ? 'bg-primary' : 'border border-border bg-muted',
        )}
      >
        <span
          className={cn(
            'pointer-events-none flex h-6 w-6 items-center justify-center rounded-full bg-white shadow-sm',
            'transition-transform duration-200 ease-out',
            enabled ? 'translate-x-[26px]' : 'translate-x-[2px]',
          )}
        >
          {enabled ? (
            <Cloud className="h-3.5 w-3.5 text-primary" />
          ) : (
            <CloudOff className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </span>
      </button>

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
    </div>
  );
}
