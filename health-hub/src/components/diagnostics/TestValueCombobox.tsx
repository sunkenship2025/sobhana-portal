import { useMemo, useRef, useState } from 'react';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

interface TestValueComboboxProps {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  /**
   * When true (TEXT_WITH_PRESETS), users can also type custom values not in the list.
   * When false (SELECT_ONLY), only listed options are accepted.
   */
  allowCustom: boolean;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

export function TestValueCombobox({
  value,
  onChange,
  options,
  allowCustom,
  placeholder = 'Select value…',
  className,
  disabled = false,
}: TestValueComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);

  const trimmedQuery = query.trim();
  const exactMatch = useMemo(
    () => options.some((opt) => opt.toLowerCase() === trimmedQuery.toLowerCase()),
    [options, trimmedQuery]
  );

  const showCustomFooter = allowCustom && trimmedQuery.length > 0 && !exactMatch;

  const commit = (next: string) => {
    onChange(next);
    setOpen(false);
    setQuery('');

    // Advance focus to the next input in the form
    setTimeout(() => {
      if (!triggerRef.current) return;
      const form = triggerRef.current.closest('form') || document;
      const inputs = Array.from(
        form.querySelectorAll('.test-value-input:not([disabled]):not([readonly])')
      ) as HTMLElement[];
      const index = inputs.indexOf(triggerRef.current);
      if (index > -1 && index < inputs.length - 1) {
        inputs[index + 1].focus();
      }
    }, 10); // Small delay to let Radix finish closing and restoring focus before we move it
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          // Native tooltip surfaces the full value on hover/focus when the
          // trigger column is too narrow to show it inline. Screen readers
          // pick this up too.
          title={value || undefined}
          className={cn(
            'w-full justify-between font-normal test-value-input',
            !value && 'text-muted-foreground',
            className
          )}
        >
          <span className="truncate text-left">{value || placeholder}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      {/*
        Popover sizing strategy:
        • min-width = max(trigger-width, 280px) — never narrower than the
          anchor (which would look broken) and never below a readable floor.
        • max-width caps inside the viewport on small screens.
        • w-auto lets the popover grow to fit the longest option, up to max.
        Items wrap to multiple lines when content exceeds the width instead
        of truncating to "NORMO…".
      */}
      <PopoverContent
        className="p-0 max-w-[min(560px,calc(100vw-2rem))] w-auto"
        style={{ minWidth: 'max(var(--radix-popover-trigger-width), 280px)' }}
        align="start"
      >
        {/*
          Pass `value` to Command so cmdk highlights and scrolls the
          currently-selected option into view when the popover opens.
          Without this, reopening the dropdown lands at the top regardless
          of selection — the user has to hunt.
        */}
        <Command shouldFilter value={value || undefined}>
          <CommandInput
            placeholder={allowCustom ? 'Search or type custom value…' : 'Search…'}
            value={query}
            onValueChange={setQuery}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && showCustomFooter) {
                e.preventDefault();
                commit(trimmedQuery);
              }
            }}
          />
          <CommandList className="max-h-[320px]">
            <CommandEmpty>
              {allowCustom ? 'No matches — press Enter to use custom value' : 'No options found.'}
            </CommandEmpty>
            <CommandGroup>
              {options.map((opt) => (
                <CommandItem
                  key={opt}
                  value={opt}
                  onSelect={() => commit(opt)}
                  className="flex items-start gap-2"
                >
                  <Check
                    className={cn(
                      'mt-0.5 h-4 w-4 shrink-0',
                      value === opt ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span className="min-w-0 whitespace-normal break-words leading-snug">{opt}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            {showCustomFooter && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    value={`__custom__${trimmedQuery}`}
                    onSelect={() => commit(trimmedQuery)}
                    className="flex items-start gap-2 text-muted-foreground"
                  >
                    <Plus className="mt-0.5 h-4 w-4 shrink-0" />
                    <span className="min-w-0 whitespace-normal break-words leading-snug">
                      Use custom: <span className="font-medium text-foreground">"{trimmedQuery}"</span>
                    </span>
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
