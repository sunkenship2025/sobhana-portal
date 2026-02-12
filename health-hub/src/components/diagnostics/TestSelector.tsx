import { useState, useRef, useEffect, useMemo } from 'react';
import { X, Search, Plus } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface LabTest {
  id: string;
  name: string;
  code: string;
  priceInPaise: number;
  departmentId?: string;
}

interface TestSelectorProps {
  tests: LabTest[];
  selectedTestIds: string[];
  onSelectionChange: (testIds: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function TestSelector({
  tests,
  selectedTestIds,
  onSelectionChange,
  disabled = false,
  placeholder = "Type to search tests (e.g., CBP, LFT, Thyroid)..."
}: TestSelectorProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Filter tests based on search query
  const filteredTests = useMemo(() => {
    if (!searchQuery.trim()) return [];
    
    const query = searchQuery.toLowerCase().trim();
    
    return tests
      .filter(test => !selectedTestIds.includes(test.id))
      .filter(test => 
        test.name.toLowerCase().includes(query) ||
        test.code.toLowerCase().includes(query)
      )
      .slice(0, 10); // Limit to 10 results for performance
  }, [tests, searchQuery, selectedTestIds]);

  // Get selected test objects
  const selectedTests = useMemo(() => {
    return selectedTestIds
      .map(id => tests.find(t => t.id === id))
      .filter((t): t is LabTest => t !== undefined);
  }, [tests, selectedTestIds]);

  // Calculate total
  const totalAmount = useMemo(() => {
    return selectedTests.reduce((sum, test) => sum + (test.priceInPaise / 100), 0);
  }, [selectedTests]);

  // Reset highlight when filtered results change
  useEffect(() => {
    setHighlightedIndex(0);
  }, [filteredTests]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (listRef.current && filteredTests.length > 0) {
      const item = listRef.current.children[highlightedIndex] as HTMLElement;
      if (item) {
        item.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [highlightedIndex, filteredTests]);

  const handleAddTest = (test: LabTest) => {
    onSelectionChange([...selectedTestIds, test.id]);
    setSearchQuery('');
    setIsOpen(false);
    inputRef.current?.focus();
  };

  const handleRemoveTest = (testId: string) => {
    onSelectionChange(selectedTestIds.filter(id => id !== testId));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen || filteredTests.length === 0) {
      if (e.key === 'Backspace' && !searchQuery && selectedTestIds.length > 0) {
        // Remove last selected test on backspace when input is empty
        handleRemoveTest(selectedTestIds[selectedTestIds.length - 1]);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex(prev => 
          prev < filteredTests.length - 1 ? prev + 1 : prev
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex(prev => prev > 0 ? prev - 1 : prev);
        break;
      case 'Enter':
        e.preventDefault();
        if (filteredTests[highlightedIndex]) {
          handleAddTest(filteredTests[highlightedIndex]);
        }
        break;
      case 'Escape':
        setIsOpen(false);
        setSearchQuery('');
        break;
    }
  };

  return (
    <div className="space-y-3">
      {/* Search Input */}
      <div className="relative">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setIsOpen(true);
            }}
            onFocus={() => setIsOpen(true)}
            onBlur={() => {
              // Delay close to allow click on dropdown item
              setTimeout(() => setIsOpen(false), 200);
            }}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="pl-10 h-12 text-base"
            disabled={disabled}
          />
        </div>

        {/* Dropdown */}
        {isOpen && filteredTests.length > 0 && (
          <div 
            ref={listRef}
            className="absolute z-50 w-full mt-1 bg-popover border rounded-lg shadow-lg max-h-64 overflow-auto"
          >
            {filteredTests.map((test, index) => (
              <div
                key={test.id}
                className={cn(
                  "flex items-center justify-between px-4 py-3 cursor-pointer transition-colors",
                  index === highlightedIndex 
                    ? "bg-accent text-accent-foreground" 
                    : "hover:bg-muted"
                )}
                onMouseEnter={() => setHighlightedIndex(index)}
                onMouseDown={(e) => {
                  e.preventDefault(); // Prevent blur
                  handleAddTest(test);
                }}
              >
                <div className="flex items-center gap-3">
                  <Plus className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="font-medium">{test.name}</p>
                    <p className="text-xs text-muted-foreground">{test.code}</p>
                  </div>
                </div>
                <span className="font-semibold text-primary">
                  ₹{(test.priceInPaise / 100).toFixed(0)}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* No results message */}
        {isOpen && searchQuery.length >= 2 && filteredTests.length === 0 && (
          <div className="absolute z-50 w-full mt-1 bg-popover border rounded-lg shadow-lg p-4 text-center text-muted-foreground">
            No tests found for "{searchQuery}"
          </div>
        )}
      </div>

      {/* Selected Tests as Tags */}
      {selectedTests.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {selectedTests.map(test => (
            <Badge
              key={test.id}
              variant="secondary"
              className="pl-3 pr-1 py-1.5 text-sm flex items-center gap-2 bg-primary/10 hover:bg-primary/20"
            >
              <span>{test.name}</span>
              <span className="text-primary font-semibold">
                ₹{(test.priceInPaise / 100).toFixed(0)}
              </span>
              <button
                type="button"
                onClick={() => handleRemoveTest(test.id)}
                className="ml-1 p-0.5 rounded-full hover:bg-destructive/20 transition-colors"
                disabled={disabled}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      {/* Summary */}
      {selectedTests.length > 0 && (
        <div className="flex items-center justify-between pt-2 border-t">
          <span className="text-sm text-muted-foreground">
            {selectedTests.length} test{selectedTests.length !== 1 ? 's' : ''} selected
          </span>
          <span className="text-lg font-bold text-primary">
            Total: ₹{totalAmount.toFixed(2)}
          </span>
        </div>
      )}

      {/* Empty State */}
      {selectedTests.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-4">
          Start typing to search and add tests
        </p>
      )}
    </div>
  );
}
