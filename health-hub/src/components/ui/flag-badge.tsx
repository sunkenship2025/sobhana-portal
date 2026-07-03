import { cn } from '@/lib/utils';

interface FlagBadgeProps {
  flag: 'NORMAL' | 'HIGH' | 'LOW' | 'CRITICAL_HIGH' | 'CRITICAL_LOW' | null;
  className?: string;
}

const flagStyles: Record<string, string> = {
  NORMAL: 'flag-normal',
  HIGH: 'flag-high',
  LOW: 'flag-low',
  // Critical values render as ordinary High/Low — no distinct panic badge.
  CRITICAL_HIGH: 'flag-high',
  CRITICAL_LOW: 'flag-low',
};

const flagLabels: Record<string, string> = {
  CRITICAL_HIGH: 'HIGH',
  CRITICAL_LOW: 'LOW',
};

export function FlagBadge({ flag, className }: FlagBadgeProps) {
  if (!flag) return null;

  return (
    <span className={cn('text-xs font-medium', flagStyles[flag], className)}>
      {flagLabels[flag] ?? flag}
    </span>
  );
}
