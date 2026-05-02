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
          className={cn(
            'w-full justify-between font-normal',
            !value && 'text-muted-foreground',
            className
          )}
        >
          <span className="truncate text-left">{value || placeholder}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command shouldFilter>
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
          <CommandList>
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
                  <span className="min-w-0 truncate">{opt}</span>
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
                    className="flex items-center gap-2 text-muted-foreground"
                  >
                    <Plus className="h-4 w-4 shrink-0" />
                    <span className="truncate">
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
