import { cn } from '@/lib/utils';

interface FlagBadgeProps {
  flag: 'NORMAL' | 'HIGH' | 'LOW' | null;
  className?: string;
}

const flagStyles: Record<string, string> = {
  NORMAL: 'flag-normal',
  HIGH: 'flag-high',
  LOW: 'flag-low',
};

export function FlagBadge({ flag, className }: FlagBadgeProps) {
  if (!flag) return null;
  
  return (
    <span className={cn('text-xs font-medium', flagStyles[flag], className)}>
      {flag}
    </span>
  );
}
