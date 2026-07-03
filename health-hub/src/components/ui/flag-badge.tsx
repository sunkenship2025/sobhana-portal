import { cn } from '@/lib/utils';

interface FlagBadgeProps {
  flag: 'NORMAL' | 'HIGH' | 'LOW' | 'CRITICAL_HIGH' | 'CRITICAL_LOW' | null;
  className?: string;
}

const flagStyles: Record<string, string> = {
  NORMAL: 'flag-normal',
  HIGH: 'flag-high',
  LOW: 'flag-low',
  // Critical (panic) values must be unmistakable, not grey fall-through text.
  CRITICAL_HIGH: 'rounded bg-red-600 px-1.5 py-0.5 font-bold text-white',
  CRITICAL_LOW: 'rounded bg-red-600 px-1.5 py-0.5 font-bold text-white',
};

const flagLabels: Record<string, string> = {
  CRITICAL_HIGH: 'CRITICAL HIGH',
  CRITICAL_LOW: 'CRITICAL LOW',
};

export function FlagBadge({ flag, className }: FlagBadgeProps) {
  if (!flag) return null;

  return (
    <span className={cn('text-xs font-medium', flagStyles[flag], className)}>
      {flagLabels[flag] ?? flag}
    </span>
  );
}
