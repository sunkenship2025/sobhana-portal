import { useState, useRef, useEffect, useMemo } from 'react';
import { X, Search, Plus, Package, FlaskConical, Layers, FileUp } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// ─── Types ──────────────────────────────────────────────────────────
export interface ProductForSelector {
  id: string;
  name: string;
  code: string;
  productType: string;          // 'INDIVIDUAL_TEST' | 'PANEL_BUNDLE' | 'CUSTOM_PACKAGE'
  workflowMode?: 'REPORTABLE' | 'BILL_ONLY' | 'EXTERNAL_UPLOAD';
  basePrice: number;            // in ₹
  effectivePrice: number;       // branch-resolved ₹
  priceSource: string;          // 'BASE' | 'BRANCH_OVERRIDE'
  description: string | null;
  panelCount: number;
  isActive: boolean;
}

interface ProductSelectorProps {
  products: ProductForSelector[];
  selectedProductIds: string[];
  onQuickAddBillOnly?: (draftName: string) => void;
  onDone?: () => void;
  disabled?: boolean;
  placeholder?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────
type ProductVisualKind = 'BILL_ONLY' | 'EXTERNAL_UPLOAD' | 'PANEL_BUNDLE' | 'CUSTOM_PACKAGE' | 'INDIVIDUAL_TEST';

function getProductVisualKind(product: Pick<ProductForSelector, 'productType' | 'workflowMode'>): ProductVisualKind {
  // Workflow takes precedence over product type for external uploads and bill-only,
  // because both carry their result in a way that doesn't fit the standard test/panel/package taxonomy.
  if (product.workflowMode === 'BILL_ONLY') {
    return 'BILL_ONLY';
  }
  if (product.workflowMode === 'EXTERNAL_UPLOAD') {
    return 'EXTERNAL_UPLOAD';
  }
  return (product.productType || 'INDIVIDUAL_TEST') as ProductVisualKind;
}

function typeLabel(kind: ProductVisualKind) {
  switch (kind) {
    case 'BILL_ONLY': return 'Bill Item';
    case 'EXTERNAL_UPLOAD': return 'External';
    case 'PANEL_BUNDLE': return 'Panel';
    case 'CUSTOM_PACKAGE': return 'Package';
    default: return 'Test';
  }
}

function typeColor(kind: ProductVisualKind) {
  switch (kind) {
    case 'BILL_ONLY': return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
    case 'EXTERNAL_UPLOAD': return 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300';
    case 'PANEL_BUNDLE': return 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300';
    case 'CUSTOM_PACKAGE': return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300';
    default: return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300';
  }
}

function groupLabel(kind: ProductVisualKind) {
  switch (kind) {
    case 'BILL_ONLY': return 'Bill-Only Items';
    case 'EXTERNAL_UPLOAD': return 'External Reports';
    case 'PANEL_BUNDLE': return 'Panels';
    case 'CUSTOM_PACKAGE': return 'Packages';
    default: return 'Tests';
  }
}

function TypeIcon({ productType, className }: { productType: ProductVisualKind; className?: string }) {
  switch (productType) {
    case 'BILL_ONLY':
      return <Package className={className} />;
    case 'EXTERNAL_UPLOAD':
      return <FileUp className={className} />;
    case 'PANEL_BUNDLE':
      return <Layers className={className} />;
    case 'CUSTOM_PACKAGE':
      return <Package className={className} />;
    default:
      return <FlaskConical className={className} />;
  }
}

// ─── Component ──────────────────────────────────────────────────────
export function ProductSelector({
  selectedProductIds,
  onSelectionChange,
  onQuickAddBillOnly,
  onDone,
  disabled = false,
  placeholder = "Type to search products (e.g., CBP, LFT, Thyroid)..."
}: ProductSelectorProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Filter products based on search query
  const filteredProducts = useMemo(() => {
    if (!searchQuery.trim()) return [];

    const query = searchQuery.toLowerCase().trim();

    return products
      .filter(p => !selectedProductIds.includes(p.id))
      .filter(p =>
        p.name.toLowerCase().includes(query) ||
        p.code.toLowerCase().includes(query) ||
        (p.description && p.description.toLowerCase().includes(query))
      )
      .slice(0, 12);
  }, [products, searchQuery, selectedProductIds]);

  // Group by product type for cleaner display
  const groupedProducts = useMemo(() => {
    const groups: { type: ProductVisualKind; label: string; products: ProductForSelector[] }[] = [];
    const typeMap = new Map<string, ProductForSelector[]>();

    for (const product of filteredProducts) {
      const key = getProductVisualKind(product);
      if (!typeMap.has(key)) typeMap.set(key, []);
      typeMap.get(key)!.push(product);
    }

    // Sort: reportable tests first, then panels, then packages, then external reports, then bill-only items
    const order: ProductVisualKind[] = ['INDIVIDUAL_TEST', 'PANEL_BUNDLE', 'CUSTOM_PACKAGE', 'EXTERNAL_UPLOAD', 'BILL_ONLY'];
    for (const key of order) {
      const items = typeMap.get(key);
      if (items && items.length > 0) {
        groups.push({ type: key, label: groupLabel(key), products: items });
      }
    }

    // Anything else
    for (const [key, items] of typeMap) {
      if (!order.includes(key)) {
        groups.push({ type: key as ProductVisualKind, label: key, products: items });
      }
    }

    return groups;
  }, [filteredProducts]);

  // Flat list for keyboard nav
  const flatList = useMemo(() => {
    const flat: ProductForSelector[] = [];
    for (const group of groupedProducts) {
      flat.push(...group.products);
    }
    return flat;
  }, [groupedProducts]);

  // Selected product objects
  const selectedProducts = useMemo(() => {
    return selectedProductIds
      .map(id => products.find(p => p.id === id))
      .filter((p): p is ProductForSelector => p !== undefined);
  }, [products, selectedProductIds]);

  // Running total
  const totalAmount = useMemo(() => {
    return selectedProducts.reduce((sum, p) => sum + (p.effectivePrice ?? p.basePrice ?? 0), 0);
  }, [selectedProducts]);

  // Reset highlight when results change
  useEffect(() => {
    setHighlightedIndex(0);
  }, [filteredProducts]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (listRef.current && flatList.length > 0) {
      const items = listRef.current.querySelectorAll('[data-product-item]');
      const item = items[highlightedIndex] as HTMLElement;
      if (item) item.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightedIndex, flatList]);

  const handleAdd = (product: ProductForSelector) => {
    onSelectionChange([...selectedProductIds, product.id]);
    setSearchQuery('');
    setIsOpen(false);
    inputRef.current?.focus();
  };

  const handleRemove = (productId: string) => {
    onSelectionChange(selectedProductIds.filter(id => id !== productId));
  };

  const handleQuickAdd = () => {
    if (!onQuickAddBillOnly || disabled) {
      return;
    }

    onQuickAddBillOnly(searchQuery.trim());
    setIsOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen || flatList.length === 0) {
      if (e.key === 'Enter') {
        if (searchQuery.trim() && onQuickAddBillOnly) {
          e.preventDefault();
          handleQuickAdd();
          return;
        } else if (!searchQuery.trim() && onDone) {
          e.preventDefault();
          onDone();
          return;
        }
      }
      if (e.key === 'Backspace' && !searchQuery && selectedProductIds.length > 0) {
        handleRemove(selectedProductIds[selectedProductIds.length - 1]);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex(prev => prev < flatList.length - 1 ? prev + 1 : prev);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex(prev => prev > 0 ? prev - 1 : prev);
        break;
      case 'Enter':
        e.preventDefault();
        if (flatList[highlightedIndex]) handleAdd(flatList[highlightedIndex]);
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
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
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
              onBlur={() => setTimeout(() => setIsOpen(false), 200)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              className="pl-10 h-12 text-base"
              disabled={disabled}
            />
          </div>

          {onQuickAddBillOnly && (
            <Button
              type="button"
              variant="outline"
              className="h-12 shrink-0"
              onClick={handleQuickAdd}
              disabled={disabled}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add Bill-Only
            </Button>
          )}
        </div>

        {/* Dropdown */}
        {isOpen && filteredProducts.length > 0 && (
          <div
            ref={listRef}
            className="absolute z-50 w-full mt-1 bg-popover border rounded-lg shadow-lg max-h-72 overflow-auto"
          >
            {groupedProducts.map((group) => (
              <div key={group.type}>
                <div className="px-4 py-1.5 text-xs font-semibold text-muted-foreground bg-muted/50 sticky top-0 flex items-center gap-1.5">
                  <TypeIcon productType={group.type} className="h-3 w-3" />
                  {group.label}
                </div>
                {group.products.map((product) => {
                  const flatIdx = flatList.indexOf(product);
                  const effectivePrice = product.effectivePrice ?? product.basePrice ?? 0;
                  const basePrice = product.basePrice ?? 0;
                  return (
                    <div
                      key={product.id}
                      data-product-item
                      className={cn(
                        "flex items-center justify-between px-4 py-3 cursor-pointer transition-colors",
                        flatIdx === highlightedIndex
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-muted"
                      )}
                      onMouseEnter={() => setHighlightedIndex(flatIdx)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        handleAdd(product);
                      }}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="font-medium truncate">{product.name}</p>
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[10px] px-1.5 py-0 shrink-0",
                                typeColor(getProductVisualKind(product))
                              )}
                            >
                              {typeLabel(getProductVisualKind(product))}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            <span className="font-mono">{product.code}</span>
                            {product.panelCount > 0 && (
                              <span className="ml-2 opacity-70">
                                {product.panelCount} panel{product.panelCount !== 1 ? 's' : ''}
                              </span>
                            )}
                          </p>
                        </div>
                      </div>
                      <div className="text-right shrink-0 ml-3">
                        <span className="font-semibold text-primary">
                          ₹{effectivePrice.toFixed(0)}
                        </span>
                        {product.priceSource === 'BRANCH_OVERRIDE' && (
                          <p className="text-[10px] text-muted-foreground line-through">
                            ₹{basePrice.toFixed(0)}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {/* No results */}
        {isOpen && searchQuery.length >= 2 && filteredProducts.length === 0 && (
          <div className="absolute z-50 w-full mt-1 bg-popover border rounded-lg shadow-lg p-4 text-center text-muted-foreground space-y-3">
            <p>No products found for &ldquo;{searchQuery}&rdquo;</p>
            {onQuickAddBillOnly && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleQuickAdd();
                }}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add as Bill-Only Item
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Selected Products as Chips */}
      {selectedProducts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {selectedProducts.map((product) => {
            const effectivePrice = product.effectivePrice ?? product.basePrice ?? 0;

            return (
              <Badge
                key={product.id}
                variant="secondary"
                className="pl-2 pr-1 py-1.5 text-sm flex items-center gap-1.5 bg-primary/10 hover:bg-primary/20"
              >
                <TypeIcon productType={getProductVisualKind(product)} className="h-3 w-3 text-muted-foreground" />
                <span className="truncate max-w-[160px]">{product.name}</span>
                <span className="text-primary font-semibold">
                  ₹{effectivePrice.toFixed(0)}
                </span>
                <button
                  type="button"
                  onClick={() => handleRemove(product.id)}
                  className="ml-0.5 p-0.5 rounded-full hover:bg-destructive/20 transition-colors"
                  disabled={disabled}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </Badge>
            );
          })}
        </div>
      )}

      {/* Summary — Running Total */}
      {selectedProducts.length > 0 && (
        <div className="flex items-center justify-between pt-2 border-t">
          <span className="text-sm text-muted-foreground">
            {selectedProducts.length} item{selectedProducts.length !== 1 ? 's' : ''} selected
          </span>
          <span className="text-lg font-bold text-primary">
            Total: ₹{totalAmount.toFixed(2)}
          </span>
        </div>
      )}

      {/* Empty State */}
      {selectedProducts.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-4">
          Start typing to search and add tests, panels, or bill-only items.
        </p>
      )}
    </div>
  );
}
