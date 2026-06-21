import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface SearchableSelectOption {
  value: string;
  label: string;
  description?: string;
  keywords?: string;
}

interface SearchableSelectProps {
  id?: string;
  value?: string;
  onValueChange: (value: string) => void;
  options: SearchableSelectOption[];
  placeholder: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
  onSkip?: () => void;
  /** Called when the user advances past this field with the popover closed
   *  (plain Enter or Shift+Enter), e.g. to move focus to the next field. */
  onAdvance?: () => void;
  /** Optional focus-flow step number tagged onto the trigger button. */
  focusStep?: number;
  /** Accessible name for the trigger (screen readers otherwise announce only
   *  "combobox"). Falls back to `placeholder`. */
  ariaLabel?: string;
}

export function SearchableSelect({
  id,
  value,
  onValueChange,
  options,
  placeholder,
  searchPlaceholder = 'Search...',
  emptyText = 'No options found.',
  disabled = false,
  className,
  onSkip,
  onAdvance,
  focusStep,
  ariaLabel,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);

  const selectedOption = useMemo(
    () => options.find((option) => option.value === value),
    [options, value]
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel ?? placeholder}
          disabled={disabled}
          data-focus-step={focusStep}
          className={cn('w-full justify-between font-normal', className)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.shiftKey) {
              // Documented skip alias.
              e.preventDefault();
              setOpen(false);
              onSkip?.();
            } else if (e.key === 'Enter' && !open) {
              // Plain Enter on a closed trigger advances instead of opening the
              // popover, so it never dead-stops the keyboard flow. Open with
              // Space / ArrowDown / click instead.
              e.preventDefault();
              (onAdvance ?? onSkip)?.();
            }
          }}
        >
          <span className="truncate text-left">
            {selectedOption ? selectedOption.label : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command shouldFilter>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {options.map((option) => (
              <CommandItem
                key={option.value}
                value={[option.label, option.description, option.keywords].filter(Boolean).join(' ')}
                onSelect={() => {
                  onValueChange(option.value);
                  setOpen(false);
                }}
                className="flex items-start gap-2"
              >
                <Check
                  className={cn(
                    'mt-0.5 h-4 w-4 shrink-0',
                    value === option.value ? 'opacity-100' : 'opacity-0'
                  )}
                />
                <div className="min-w-0">
                  <div className="truncate">{option.label}</div>
                  {option.description && (
                    <div className="truncate text-xs text-muted-foreground">
                      {option.description}
                    </div>
                  )}
                </div>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
