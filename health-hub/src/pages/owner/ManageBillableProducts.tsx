import { useState, useEffect, useCallback, useRef, useMemo, type CSSProperties } from 'react';
import { API_BASE, API_BASE_URL } from '@/lib/api';
import { SearchableSelect, type SearchableSelectOption } from '@/components/ui/searchable-select';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';
import { toast } from 'sonner';
import {
  Plus, Pencil, Search, Package, IndianRupee, Trash2,
  CheckCircle2, AlertCircle, Loader2, Printer, FileSpreadsheet, ListChecks,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { LoadingState } from '@/components/ui/loading-state';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { branchRequest, useBranchId } from '@/lib/query';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useReferralCategories } from '@/lib/payoutCategories';
import {
  Tabs, TabsContent, TabsList, TabsTrigger,
} from '@/components/ui/tabs';

/* ───────── Types ───────── */

interface PanelSummary {
  id: string;
  code: string;
  name: string;
  displayName?: string;
  itemCount?: number;
}

interface ProductSummary {
  id: string;
  code: string;
  name: string;
  workflowMode: WorkflowMode;
  basePriceInPaise?: number;
  basePrice?: number;
  /** Panels this product sells, so the picker can hide them as separate rows. */
  panelIds: string[];
}

interface ProductPanel {
  id?: string;
  panelId?: string | null;
  childProductId?: string | null;
  displayOrder: number;
  panel?: PanelSummary;
  childProduct?: ProductSummary;
}

interface ProductBranchPricing {
  id?: string;
  branchId: string;
  price: number;
  isActive: boolean;
  branch?: { id: string; name: string };
}

type WorkflowMode = 'REPORTABLE' | 'BILL_ONLY' | 'EXTERNAL_UPLOAD' | 'EVENT';

interface BillableProduct {
  id: string;
  name: string;
  code: string;
  productType: string;
  workflowMode: WorkflowMode;
  basePrice: number;
  isActive: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  panels: ProductPanel[];
  panelCount: number;
  branchPricing: ProductBranchPricing[];
  effectivePrice?: number;
  payoutCategory?: string | null;
}

interface Branch { id: string; name: string }

const PRODUCT_TYPES = [
  { value: 'INDIVIDUAL_TEST', label: 'Individual Test', color: 'bg-blue-100 text-blue-800' },
  { value: 'PANEL_BUNDLE', label: 'Panel', color: 'bg-purple-100 text-purple-800' },
  { value: 'CUSTOM_PACKAGE', label: 'Custom Package', color: 'bg-green-100 text-green-800' },
  { value: 'EVENT', label: 'Event', color: 'bg-red-100 text-red-800' },
];

const WORKFLOW_MODES = [
  { value: 'REPORTABLE', label: 'Reportable', color: 'bg-emerald-100 text-emerald-800' },
  { value: 'BILL_ONLY', label: 'Bill Only', color: 'bg-amber-100 text-amber-800' },
  { value: 'EXTERNAL_UPLOAD', label: 'External Upload', color: 'bg-sky-100 text-sky-800' },
  { value: 'EVENT', label: 'Event', color: 'bg-red-100 text-red-800' },
];

const WORKFLOW_LABELS: Record<WorkflowMode, string> = {
  REPORTABLE: 'Reportable',
  BILL_ONLY: 'Bill Only',
  EXTERNAL_UPLOAD: 'External Upload',
  EVENT: 'Event',
};

function workflowBadgeColor(workflowMode: string) {
  const wm = WORKFLOW_MODES.find((mode) => mode.value === workflowMode);
  return wm ? wm.color : 'bg-muted text-foreground';
}

// The DB stores only `isBundle` (boolean), not the 3-way Individual/Panel/Package
// choice — so derive the display type: an Event by workflow, a Custom Package once
// it carries more than one line item, otherwise a single Panel (bundle) or an
// Individual Test. Keeps the Type column + filter meaningful after the round-trip.
/**
 * Both PANEL_BUNDLE and CUSTOM_PACKAGE are isBundle=true in the database; only
 * INDIVIDUAL_TEST is not. Worth stating because the 3-way type here is DERIVED,
 * not stored — effectiveProductType() promotes anything with more than one line
 * to CUSTOM_PACKAGE, so a real health-check package never reads as PANEL_BUNDLE.
 * Gating the Smart Report toggle on PANEL_BUNDLE alone hid it from every package
 * it was built for and showed it only on single panels.
 *
 * Eligibility itself stays with the backend (checkPackage reads isBundle), so
 * this only decides whether to ask.
 */
function isBundleType(t: string): boolean {
  return t === 'CUSTOM_PACKAGE' || t === 'PANEL_BUNDLE';
}

// The server derives productType now (deriveProductType in billableProducts.ts)
// and sends the finished value. Re-deriving it here is what kept this list
// unpageable: the filter could only run over rows already downloaded, so the
// page had to download all of them.
function effectiveProductType(p: BillableProduct): string {
  return p.productType;
}

// The kind of a package line item, for the at-a-glance badge: a clinical panel,
// or a child product tagged by its own workflow (Reportable / Bill Only /
// External). Reads the loaded nested childProduct first, then the dropdown list
// (fresh selection), defaulting to Bill Only since that's all the picker offers.
function lineItemKind(
  pp: ProductPanel,
  subProducts: ProductSummary[],
): { label: string; color: string } | null {
  if (pp.panelId) {
    return { label: 'Panel', color: 'bg-purple-100 text-purple-800' };
  }
  if (pp.childProductId) {
    const wm =
      pp.childProduct?.workflowMode ??
      subProducts.find((sp) => sp.id === pp.childProductId)?.workflowMode ??
      'BILL_ONLY';
    const meta = WORKFLOW_MODES.find((m) => m.value === wm);
    return {
      label: wm === 'EXTERNAL_UPLOAD' ? 'External' : meta?.label ?? 'Bill Only',
      color: meta?.color ?? 'bg-amber-100 text-amber-800',
    };
  }
  return null;
}

const CODE_REGEX = /^[A-Z0-9_]{2,20}$/;

const LOGO_URL = `${API_BASE_URL}/images/sobhana-clinic-logo.png`;

/* ───────── Component ───────── */

export default function ManageBillableProducts() {
  const { token } = useAuthStore();
  const activeBranchId = useBranchStore((state) => state.activeBranchId);
  const branches = useBranchStore((state) => state.branches);
  const getActiveBranch = useBranchStore((state) => state.getActiveBranch);
  const selectedBranch = getActiveBranch();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const [products, setProducts] = useState<BillableProduct[]>([]);
  const [availablePanels, setAvailablePanels] = useState<PanelSummary[]>([]);
  const [availableSubProducts, setAvailableSubProducts] = useState<ProductSummary[]>([]);
  const [branchOptions, setBranchOptions] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  // Search hits the server now, so it waits for a pause in typing rather than
  // firing a query per keystroke.
  const debouncedSearch = useDebouncedValue(search, 250);
  // 20 rows is what the table shows without scrolling; the list was shipping
  // 205 KB of catalogue to render that many.
  const PAGE_SIZE = 20;
  const [page, setPage] = useState(1);
  const [totalProducts, setTotalProducts] = useState(0);
  // Rows for the @media print sheet. Fetched on demand rather than taken from
  // `products`, which is one page now — a price list that silently prints 20 of
  // 342 is worse than one that takes a second to assemble.
  const [printRows, setPrintRows] = useState<BillableProduct[]>([]);
  const [printing, setPrinting] = useState(false);
  const [filterType, setFilterType] = useState('all');
  const [filterWorkflow, setFilterWorkflow] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');

  // Print / Excel selection — checkboxes only appear in select mode;
  // otherwise Print/Excel take all active products shown
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);

  const toggleSelectMode = () => {
    if (selectMode) setSelected(new Set());
    setSelectMode(!selectMode);
  };

  // Main dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const branchId = useBranchId();
  const [editingProduct, setEditingProduct] = useState<BillableProduct | null>(null);
  const [saving, setSaving] = useState(false);

  // Pricing dialog
  const [pricingOpen, setPricingOpen] = useState(false);
  const [pricingProduct, setPricingProduct] = useState<BillableProduct | null>(null);
  const [pricingData, setPricingData] = useState<ProductBranchPricing[]>([]);

  // Form fields
  const [formName, setFormName] = useState('');
  const [formCode, setFormCode] = useState('');
  const [formType, setFormType] = useState('INDIVIDUAL_TEST');
  const [formWorkflowMode, setFormWorkflowMode] = useState<WorkflowMode>('REPORTABLE');
  const [formBasePrice, setFormBasePrice] = useState('');
  const [formActive, setFormActive] = useState(true);
  const [formDescription, setFormDescription] = useState('');
  // Smart Reports: package-level opt-in. Only offered on saved bundles, and only
  // when the resolved package has no external-upload line and no narrative panel.
  const [smartEligibility, setSmartEligibility] = useState<{ eligible: boolean; reasons: string[] } | null>(null);
  const [smartEnabled, setSmartEnabled] = useState(false);
  const [smartBusy, setSmartBusy] = useState(false);

  useEffect(() => {
    if (!editingProduct || !isBundleType(formType)) {
      setSmartEligibility(null);
      setSmartEnabled(false);
      return;
    }
    let cancelled = false;
    branchRequest<{ eligible: boolean; reasons: string[]; enabled: boolean }>(
      `/smart-reports/products/${editingProduct.id}/eligibility`, branchId,
    )
      .then((d) => {
        if (cancelled) return;
        setSmartEligibility({ eligible: d.eligible, reasons: d.reasons });
        setSmartEnabled(d.enabled);
      })
      .catch(() => { if (!cancelled) setSmartEligibility(null); });
    return () => { cancelled = true; };
  }, [editingProduct, formType, branchId]);
  const [formPayoutCategory, setFormPayoutCategory] = useState('');
  const referralCategories = useReferralCategories();
  const [formPanels, setFormPanels] = useState<ProductPanel[]>([]);

  // Code validation
  const [codeAvailable, setCodeAvailable] = useState<boolean | null>(null);
  const [codeChecking, setCodeChecking] = useState(false);
  const codeCheckTimer = useRef<ReturnType<typeof setTimeout>>(null);

  // ─── Data fetching ──────────────────────────────────────────────────────

  const fetchProducts = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (selectedBranch?.id) params.set('branchId', selectedBranch.id);
      if (filterType !== 'all') params.set('type', filterType);
      if (filterWorkflow !== 'all') params.set('workflowMode', filterWorkflow);
      // The server's `active` param IS the status filter; 'all' keeps the
      // management view showing inactive rows too.
      params.set('active', filterStatus === 'all' ? 'all' : filterStatus === 'active' ? 'true' : 'false');
      params.set('page', String(page));
      params.set('pageSize', String(PAGE_SIZE));
      const res = await fetch(`${API_BASE}/billable-products?${params}`, { headers });
      if (!res.ok) throw new Error('Failed to fetch');
      const body = await res.json();
      // Envelope, because we asked for a page. Deliberately NOT cached: this is
      // catalogue data that staff edit and must see change immediately, and
      // every mutation below already refetches. A cache layer here would buy
      // milliseconds and risk showing a price that is no longer real.
      setProducts(body.results);
      setTotalProducts(body.total);
    } catch {
      toast.error('Failed to load products');
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, selectedBranch?.id, filterType, filterWorkflow, filterStatus, page]);

  const fetchDependencies = useCallback(async () => {
    try {
      // Sub-products offered as package line items: every active product, each
      // tagged by kind in the picker. Nesting expands a child into its own
      // order, so any workflow is safe — EVENT included, where the expansion
      // mints the coupon just as billing it on its own would.
      const [panelsRes, branchRes, subProductsRes] = await Promise.all([
        fetch(`${API_BASE}/clinical-panels`, { headers }),
        fetch(`${API_BASE}/branches`, { headers }),
        fetch(`${API_BASE}/billable-products?active=true`, { headers }),
      ]);
      if (panelsRes.ok) setAvailablePanels(await panelsRes.json());
      if (branchRes.ok) setBranchOptions(await branchRes.json());
      if (subProductsRes.ok) {
        const items: any[] = await subProductsRes.json();
        setAvailableSubProducts(items
          .map((p) => ({
            id: p.id,
            code: p.code,
            name: p.name,
            workflowMode: p.workflowMode,
            basePrice: p.basePrice,
            basePriceInPaise: p.basePriceInPaise,
            panelIds: (p.panels || [])
              .map((l: { panelId?: string | null }) => l.panelId)
              .filter(Boolean) as string[],
          })));
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchProducts(); }, [fetchProducts]);
  // Any narrowing restarts at page 1 — otherwise a search that matches 3 rows
  // while sitting on page 5 shows an empty table.
  useEffect(() => { setPage(1); }, [debouncedSearch, filterType, filterWorkflow, filterStatus, selectedBranch?.id]);
  useEffect(() => { fetchDependencies(); }, []);

  // ─── Debounced code uniqueness check ──────────────────────────────────

  useEffect(() => {
    if (editingProduct) { setCodeAvailable(null); return; }
    const code = formCode.trim().toUpperCase();
    if (!code || !CODE_REGEX.test(code)) { setCodeAvailable(null); return; }
    if (codeCheckTimer.current) clearTimeout(codeCheckTimer.current);
    setCodeChecking(true);
    codeCheckTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/billable-products/check-code?code=${encodeURIComponent(code)}`, { headers });
        if (res.ok) {
          const data = await res.json();
          setCodeAvailable(data.available);
        }
      } catch { /* ignore */ }
      setCodeChecking(false);
    }, 400);
    return () => { if (codeCheckTimer.current) clearTimeout(codeCheckTimer.current); };
  }, [formCode, editingProduct]);

  // ─── Form helpers ───────────────────────────────────────────────────────

  const resetForm = () => {
    setFormName(''); setFormCode(''); setFormType('INDIVIDUAL_TEST');
    setFormWorkflowMode('REPORTABLE');
    setFormBasePrice(''); setFormActive(true); setFormDescription(''); setFormPayoutCategory('');
    setFormPanels([]); setEditingProduct(null);
    setCodeAvailable(null); setCodeChecking(false);
  };

  const populateForm = (p: BillableProduct) => {
    setFormName(p.name);
    setFormCode(p.code);
    // Type isn't persisted (only isBundle) — infer it so a multi-line package
    // re-opens as Custom Package rather than Panel (and stays editable).
    setFormType(effectiveProductType(p));
    setFormWorkflowMode(p.workflowMode || 'REPORTABLE');
    setFormBasePrice(p.basePrice.toString());
    setFormActive(p.isActive);
    setFormDescription(p.description || '');
    setFormPayoutCategory(p.payoutCategory || '');
    setFormPanels((p.panels || []).map(pp => ({
      panelId: pp.panelId ?? pp.panel?.id ?? null,
      childProductId: pp.childProductId ?? pp.childProduct?.id ?? null,
      displayOrder: pp.displayOrder,
      panel: pp.panel,
      childProduct: pp.childProduct,
    })));
  };

  const openCreate = () => { resetForm(); setDialogOpen(true); };

  const openEdit = async (product: BillableProduct) => {
    try {
      const res = await fetch(`${API_BASE}/billable-products/${product.id}`, { headers });
      if (!res.ok) throw new Error('Failed');
      const detail = await res.json();
      populateForm(detail);
      setEditingProduct(detail);
      setDialogOpen(true);
    } catch {
      toast.error('Failed to load product details');
    }
  };

  // ─── Component management ──────────────────────────────────────────────

  const addPanel = () => {
    setFormPanels([...formPanels, {
      panelId: null,
      childProductId: null,
      displayOrder: formPanels.length,
    }]);
  };

  // The combined dropdown encodes selections as `panel:<id>` or `child:<id>`
  // so a single Select can drive both kinds. Save logic reads back the prefix.
  const updatePanel = (idx: number, value: string) => {
    const updated = [...formPanels];
    if (value.startsWith('panel:')) {
      updated[idx] = { ...updated[idx], panelId: value.slice('panel:'.length), childProductId: null };
    } else if (value.startsWith('child:')) {
      updated[idx] = { ...updated[idx], childProductId: value.slice('child:'.length), panelId: null };
    }
    setFormPanels(updated);
  };

  const removePanel = (idx: number) => {
    setFormPanels(formPanels.filter((_, i) => i !== idx));
  };

  // 172 of 210 panels are already sold as a product, so listing both put the
  // same real thing in the dropdown twice — 13 of them under an identical name
  // (TMT, ESR, WIDAL, HCV…) with nothing to tell them apart. A panel that has a
  // product IS that product here; pick the product, which is the one carrying
  // the price, the payout category and the commission rules.
  const panelsSoldAsAProduct = useMemo(
    () => new Set(availableSubProducts.flatMap((sp) => sp.panelIds)),
    [availableSubProducts],
  );

  // One option per real thing. The line's CURRENT value is always included even
  // when it would otherwise be hidden — otherwise every existing line pointing
  // at an attached panel would render blank.
  const lineOptions = useCallback(
    (current: ProductPanel): SearchableSelectOption[] => [
      ...availableSubProducts
        .filter((sp) => !editingProduct || sp.id !== editingProduct.id) // no self-reference
        .map((sp) => {
          const wm = WORKFLOW_MODES.find((m) => m.value === sp.workflowMode);
          return {
            value: `child:${sp.id}`,
            label: `${sp.code} – ${sp.name}`,
            description: sp.basePrice != null ? `₹${sp.basePrice}` : undefined,
            keywords: `${sp.code} ${sp.name}`,
            badge: wm
              ? { text: wm.value === 'EXTERNAL_UPLOAD' ? 'External' : wm.label, className: wm.color }
              : undefined,
            group: 'Products — carry their own price, category and commission',
          };
        }),
      ...availablePanels
        .filter((pl) => !panelsSoldAsAProduct.has(pl.id) || current.panelId === pl.id)
        .map((pl) => ({
          value: `panel:${pl.id}`,
          label: `${pl.code} – ${pl.name}`,
          description: pl.itemCount ? `${pl.itemCount} tests` : undefined,
          keywords: `${pl.code} ${pl.name}`,
          badge: { text: 'Panel only', className: 'bg-slate-100 text-slate-700' },
          group: 'Panels — print inside this product, nothing sold on their own',
        })),
    ],
    [availableSubProducts, availablePanels, panelsSoldAsAProduct, editingProduct],
  );

  const lineSelectValue = (pp: ProductPanel): string => {
    if (pp.panelId) return `panel:${pp.panelId}`;
    if (pp.childProductId) return `child:${pp.childProductId}`;
    return '';
  };

  // ─── Save product ──────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!formName.trim() || !formCode.trim()) {
      toast.error('Name and code are required');
      return;
    }

    if (!editingProduct && !CODE_REGEX.test(formCode.trim().toUpperCase())) {
      toast.error('Code must be 2-20 uppercase alphanumeric characters or underscores');
      return;
    }

    if (!editingProduct && codeAvailable === false) {
      toast.error('Code is already in use');
      return;
    }

    // Line-item validation — each row points at exactly one of panel/sub-product.
    // Only a Custom Package may carry more than one line; an Individual Test or a
    // Panel is a single line item.
    const validLines = formPanels.filter(p => p.panelId || p.childProductId);
    if (formType !== 'CUSTOM_PACKAGE' && formType !== 'EVENT' && validLines.length > 1) {
      toast.error('Only Custom Package products can have multiple line items');
      return;
    }
    if (formWorkflowMode === 'REPORTABLE' && validLines.length < 1) {
      toast.error('Reportable products must have at least 1 line item');
      return;
    }
    if (formWorkflowMode === 'EXTERNAL_UPLOAD' && validLines.length > 0) {
      toast.error('External Upload products do not support line items');
      return;
    }

    if (!formBasePrice || isNaN(parseFloat(formBasePrice))) {
      toast.error('Valid base price is required');
      return;
    }

    setSaving(true);
    try {
      const body = {
        name: formName.trim(),
        code: formCode.trim(),
        productType: formType === 'EVENT' ? 'INDIVIDUAL_TEST' : formType,
        workflowMode: formType === 'EVENT' ? 'EVENT' : formWorkflowMode,
        basePrice: parseFloat(formBasePrice),
        isActive: formActive,
        description: formDescription || null,
        payoutCategory: formPayoutCategory || null,
        panels: formPanels
          .filter(p => p.panelId || p.childProductId)
          .map((p, i) => ({
            panelId: p.panelId ?? null,
            childProductId: p.childProductId ?? null,
            displayOrder: i,
          })),
      };

      const url = editingProduct
        ? `${API_BASE}/billable-products/${editingProduct.id}`
        : `${API_BASE}/billable-products`;
      const method = editingProduct ? 'PUT' : 'POST';

      const res = await fetch(url, { method, headers, body: JSON.stringify(body) });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || 'Save failed');
      }

      toast.success(editingProduct ? 'Product updated' : 'Product created');
      setDialogOpen(false);
      resetForm();
      fetchProducts();
    } catch (err: any) {
      toast.error(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  // ─── Toggle active ─────────────────────────────────────────────────────

  const toggleActive = async (product: BillableProduct) => {
    try {
      const res = await fetch(`${API_BASE}/billable-products/${product.id}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ isActive: !product.isActive }),
      });
      if (!res.ok) throw new Error('Toggle failed');
      toast.success(`Product ${product.isActive ? 'deactivated' : 'activated'}`);
      fetchProducts();
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  // ─── Delete product ────────────────────────────────────────────────────

  const [deleteConfirm, setDeleteConfirm] = useState<BillableProduct | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    setDeleting(true);
    try {
      const res = await fetch(`${API_BASE}/billable-products/${deleteConfirm.id}`, {
        method: 'DELETE', headers,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || 'Delete failed');
      }
      toast.success(`Product "${deleteConfirm.name}" deleted`);
      setDeleteConfirm(null);
      fetchProducts();
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete');
    } finally {
      setDeleting(false);
    }
  };

  // ─── Branch pricing ────────────────────────────────────────────────────

  const openPricing = async (product: BillableProduct) => {
    try {
      const res = await fetch(`${API_BASE}/billable-products/${product.id}/pricing`, { headers });
      if (!res.ok) throw new Error('Failed');
      // GET returns rows in paise (priceInPaise); the editor works in rupees (price).
      const rows = await res.json();
      setPricingData((Array.isArray(rows) ? rows : []).map((r: any) => ({ ...r, price: (r.priceInPaise ?? 0) / 100 })));
      setPricingProduct(product);
      setPricingOpen(true);
    } catch {
      toast.error('Failed to load pricing');
    }
  };

  const updatePricingRow = (idx: number, field: string, val: any) => {
    const updated = [...pricingData];
    (updated[idx] as any)[field] = val;
    setPricingData(updated);
  };

  const addPricingRow = () => {
    setPricingData([...pricingData, {
      branchId: '',
      price: 0,
      isActive: true,
    }]);
  };

  const removePricingRow = (idx: number) => {
    setPricingData(pricingData.filter((_, i) => i !== idx));
  };

  const savePricing = async () => {
    if (!pricingProduct) return;
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/billable-products/${pricingProduct.id}/pricing`, {
        method: 'PUT', headers,
        // Backend PUT /:id/pricing reads { pricing: [{ branchId, priceInPaise, isActive }] }.
        // The old body used the wrong envelope key (pricingOverrides), the wrong
        // field (price), and rupees instead of paise (100x off) — so pricing never saved.
        body: JSON.stringify({ pricing: pricingData.map(p => ({
          branchId: p.branchId, priceInPaise: Math.round((p.price ?? 0) * 100), isActive: p.isActive,
        })) }),
      });
      if (!res.ok) throw new Error('Save failed');
      toast.success('Pricing updated');
      setPricingOpen(false);
      fetchProducts();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  // ─── Print / Excel export ──────────────────────────────────────────────

  // Client-side filters (Type / Workflow / Status) layered on top of the
  // server-side name/code search.
  // Server-filtered, server-paged: `products` IS the current page, already
  // narrowed. Filtering again here would be filtering one page and calling it
  // the whole catalogue.
  const filteredProducts = products;
  const filtersActive = filterType !== 'all' || filterWorkflow !== 'all' || filterStatus !== 'all';
  const clearFilters = () => {
    setFilterType('all');
    setFilterWorkflow('all');
    setFilterStatus('all');
  };

  // Derived from the SELECTION, not from the page. `products` is one page now,
  // so counting selected rows out of it would have reported only what happens
  // to be on screen — tick five rows, turn the page, and Print would have said
  // nothing was selected and quietly exported that page instead.
  const selectedCount = selected.size;
  // Empty selection means "everything active", and the export route already
  // resolves that server-side when it receives no ids — so an unselected export
  // stays the whole price list rather than the twenty rows currently rendered.

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allShownSelected = filteredProducts.length > 0 && filteredProducts.every(p => selected.has(p.id));
  const toggleSelectAll = () => {
    setSelected(allShownSelected ? new Set() : new Set(filteredProducts.map(p => p.id)));
  };

  const handlePrint = async () => {
    setPrinting(true);
    try {
      // No `page` → the full list, which is exactly what a price list needs and
      // is why pagination was made opt-in rather than mandatory.
      const params = new URLSearchParams({ active: 'true' });
      if (selectedBranch?.id) params.set('branchId', selectedBranch.id);
      const res = await fetch(`${API_BASE}/billable-products?${params}`, { headers });
      if (!res.ok) throw new Error('Failed');
      const all: BillableProduct[] = await res.json();
      setPrintRows(selectedCount ? all.filter(p => selected.has(p.id)) : all);
      // Let React commit the print block before the dialog opens, or the sheet
      // prints the previous contents.
      await new Promise(requestAnimationFrame);
      window.print();
    } catch {
      toast.error('Could not assemble the price list');
    } finally {
      setPrinting(false);
    }
  };

  const exportExcel = async () => {
    setExporting(true);
    try {
      const res = await fetch(`${API_BASE}/billable-products/export`, {
        method: 'POST',
        headers: selectedBranch?.id ? { ...headers, 'X-Branch-Id': selectedBranch.id } : headers,
        body: JSON.stringify(selectedCount ? { ids: [...selected] } : {}),
      });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `price-list-${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Failed to export the price list');
    } finally {
      setExporting(false);
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────────

  const formatPrice = (p: number) => `₹${p.toLocaleString('en-IN')}`;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Package className="h-5 w-5" /> Billable Products
          </h2>
          <p className="text-sm text-muted-foreground">Manage tests, bundles and packages with branch-specific pricing</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={selectMode ? 'secondary' : 'outline'}
            size="sm"
            onClick={toggleSelectMode}
            title={selectMode ? 'Exit selection' : 'Pick specific tests for print / Excel'}
          >
            <ListChecks className="h-4 w-4 mr-1" /> Select
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handlePrint}
            disabled={printing}
            title={selectedCount ? `Print ${selectedCount} selected` : 'Print all active products'}
          >
            <Printer className="h-4 w-4 mr-1" />
            Print{selectedCount ? ` (${selectedCount})` : ''}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={exporting}
            onClick={exportExcel}
            title={selectedCount ? `Export ${selectedCount} selected` : 'Export all active products'}
          >
            {exporting
              ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              : <FileSpreadsheet className="h-4 w-4 mr-1" />}
            Excel{selectedCount ? ` (${selectedCount})` : ''}
          </Button>
          <Button onClick={openCreate} size="sm">
            <Plus className="h-4 w-4 mr-1" /> New Product
          </Button>
        </div>
      </div>

      {/* Search + filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search products..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
        <Select value={filterType} onValueChange={setFilterType}>
          <SelectTrigger className="w-[160px]"><SelectValue placeholder="Type" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {PRODUCT_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filterWorkflow} onValueChange={setFilterWorkflow}>
          <SelectTrigger className="w-[170px]"><SelectValue placeholder="Workflow" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All workflows</SelectItem>
            {WORKFLOW_MODES.map(w => <SelectItem key={w.value} value={w.value}>{w.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="w-[140px]"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
          </SelectContent>
        </Select>
        {filtersActive && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>Clear</Button>
        )}
      </div>

      {/* Table */}
      {loading ? (
        <LoadingState />
      ) : filteredProducts.length === 0 ? (
        <EmptyState title="No products found" />
      ) : (
        <div className="border rounded-lg overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40">
                {selectMode && (
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allShownSelected ? true : selected.size > 0 ? 'indeterminate' : false}
                      onCheckedChange={toggleSelectAll}
                      aria-label="Select all"
                    />
                  </TableHead>
                )}
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Workflow</TableHead>
                <TableHead>Base Price</TableHead>
                <TableHead>Effective Price</TableHead>
                  <TableHead className="text-center">Panels</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredProducts.map(product => (
                <TableRow key={product.id} className="hover:bg-muted/50">
                  {selectMode && (
                    <TableCell>
                      <Checkbox
                        checked={selected.has(product.id)}
                        onCheckedChange={() => toggleSelect(product.id)}
                        aria-label={`Select ${product.name}`}
                      />
                    </TableCell>
                  )}
                  <TableCell>
                    <Badge variant="secondary" className="font-mono text-xs">{product.code}</Badge>
                  </TableCell>
                  <TableCell>
                    <div>
                      <div className="font-medium">{product.name}</div>
                      {product.description && <div className="text-xs text-muted-foreground truncate max-w-[200px]">{product.description}</div>}
                    </div>
                  </TableCell>
                  <TableCell>
                    {(() => {
                      const et = effectiveProductType(product);
                      const meta = PRODUCT_TYPES.find(t => t.value === et);
                      return (
                        <Badge className={meta?.color ?? 'bg-muted text-foreground'}>
                          {meta?.label ?? et.replace(/_/g, ' ')}
                        </Badge>
                      );
                    })()}
                  </TableCell>
                  <TableCell>
                    <Badge className={workflowBadgeColor(product.workflowMode)}>
                      {WORKFLOW_LABELS[product.workflowMode] ?? 'Reportable'}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-sm">{formatPrice(product.basePrice)}</TableCell>
                  <TableCell>
                    {product.effectivePrice !== undefined && product.effectivePrice !== product.basePrice ? (
                      <span className="text-blue-600 font-medium font-mono">{formatPrice(product.effectivePrice)}</span>
                    ) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge variant="outline" className="text-xs">{product.panelCount ?? product.panels?.length ?? 0}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge className={product.isActive ? 'bg-green-100 text-green-800' : 'bg-muted text-foreground'}>
                      {product.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center gap-0.5 justify-end">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(product)} title="Edit" className="h-7 w-7 p-0">
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => openPricing(product)} title="Branch Pricing" className="h-7 w-7 p-0">
                        <IndianRupee className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleteConfirm(product)} title="Delete product" className="h-7 w-7 p-0 text-destructive hover:text-destructive hover:bg-destructive/10">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                      <Switch
                        checked={product.isActive}
                        onCheckedChange={() => toggleActive(product)}
                        className="ml-1"
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Counts describe the whole filtered set, not the page — "Showing 20"
          on a 342-row catalogue reads as data loss. Buttons reuse the outline
          size-sm shape already used by Select / Print / Excel above. */}
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          {totalProducts === 0
            ? 'No products'
            : `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, totalProducts)} of ${totalProducts}`}
          {selected.size > 0 && ` · ${selected.size} selected`}
        </p>
        {totalProducts > PAGE_SIZE && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1 || loading}
              onClick={() => setPage(p => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <span className="text-xs text-muted-foreground">
              Page {page} of {Math.max(1, Math.ceil(totalProducts / PAGE_SIZE))}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={page * PAGE_SIZE >= totalProducts || loading}
              onClick={() => setPage(p => p + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </div>

      {/* Print-only price list (visible only via @media print) */}
      <PriceListPrint rows={printRows} branchName={selectedBranch?.name} />

      {/* ─── Create/Edit Dialog ───────────────────────────────────────────── */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingProduct ? `Edit Product: ${editingProduct.name}` : 'New Billable Product'}
            </DialogTitle>
            <DialogDescription>
              {editingProduct
                ? 'Update product details, components, and pricing configuration.'
                : 'Create a new billable product — individual test, panel bundle, or custom package.'}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Name *</Label>
              <Input value={formName} onChange={e => setFormName(e.target.value)} />
            </div>
            <div>
              <Label>Code *</Label>
              <div className="relative">
                <Input
                  value={formCode}
                  onChange={e => setFormCode(e.target.value.toUpperCase())}
                  className="font-mono pr-8"
                />
                {!editingProduct && formCode.trim() && (
                  <span className="absolute right-2 top-2.5">
                    {codeChecking ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> :
                     !CODE_REGEX.test(formCode.trim()) ? <AlertCircle className="h-4 w-4 text-destructive" /> :
                     codeAvailable === true ? <CheckCircle2 className="h-4 w-4 text-green-600" /> :
                     codeAvailable === false ? <AlertCircle className="h-4 w-4 text-destructive" /> : null}
                  </span>
                )}
              </div>
              {!editingProduct && formCode.trim() && !CODE_REGEX.test(formCode.trim()) && (
                <p className="text-xs text-destructive mt-0.5">2-20 uppercase letters, digits, or underscores</p>
              )}
              {!editingProduct && codeAvailable === false && (
                <p className="text-xs text-destructive mt-0.5">Code already in use</p>
              )}
            </div>
            <div>
              <Label>Product Type</Label>
              <Select value={formType} onValueChange={(v) => {
                setFormType(v);
                if (v === 'EVENT') setFormWorkflowMode('EVENT');
                else if (formWorkflowMode === 'EVENT') setFormWorkflowMode('REPORTABLE');
              }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PRODUCT_TYPES.map(pt => (
                    <SelectItem key={pt.value} value={pt.value}>{pt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {formType !== 'EVENT' && (
            <div>
              <Label>Workflow</Label>
              <Select
                value={formWorkflowMode}
                onValueChange={(value) => setFormWorkflowMode(value as WorkflowMode)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {WORKFLOW_MODES.filter((mode) => mode.value !== 'EVENT').map((mode) => (
                    <SelectItem key={mode.value} value={mode.value}>{mode.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            )}
            <div>
              <Label>Base Price (₹) *</Label>
              <Input type="number" value={formBasePrice} onChange={e => setFormBasePrice(e.target.value)} />
            </div>
            <div className="flex items-center gap-2 col-span-2">
              <Switch checked={formActive} onCheckedChange={setFormActive} />
              <Label>Active</Label>
            </div>
            <div className="col-span-2">
              <Label>Description</Label>
              <Input value={formDescription} onChange={e => setFormDescription(e.target.value)} />
            </div>
            <div className="col-span-2">
              <Label>Category</Label>
              <Select value={formPayoutCategory || '__none__'} onValueChange={v => setFormPayoutCategory(v === '__none__' ? '' : v)}>
                <SelectTrigger><SelectValue placeholder="Auto-detect from name" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Auto-detect from name</SelectItem>
                  {referralCategories.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <Separator />

          {/* ─── Panels ──────────────────────────────────────────────── */}
          {formWorkflowMode === 'EXTERNAL_UPLOAD' || formWorkflowMode === 'EVENT' ? (
            <div className="mt-2 rounded border border-dashed p-3 text-xs text-muted-foreground">
              {formWorkflowMode === 'EVENT'
                ? 'Event products carry no tests. Billing this ₹0 item issues a campaign coupon and sends the WhatsApp reward — no bill or report.'
                : "External Upload products do not require panels. Staff will attach the report PDF on the result-entry screen; the upload is merged into the patient's report with the Sobhana letterhead."}
            </div>
          ) : (
            <div className="mt-2">
              <div className="flex items-center justify-between mb-2">
                <Label className="text-sm font-semibold">Line Items</Label>
                <Button size="sm" variant="outline" onClick={addPanel}>
                  <Plus className="h-3 w-3 mr-1" /> Add Item
                </Button>
              </div>

              <p className="mb-3 text-xs text-muted-foreground">
                {formWorkflowMode === 'REPORTABLE'
                  ? 'Reportable products require at least one line item — a clinical panel or a sub-product. A sub-product (reportable, external or bill-only) expands into its own report/upload when this package is billed.'
                  : 'Bill-only products can be billed without lines. Linked lines are only used after switching back to Reportable.'}
              </p>

              {formPanels.length === 0 ? (
                <p className="text-sm text-muted-foreground">No items linked.</p>
              ) : (
                <div className="space-y-2">
                  {formPanels.map((pp, i) => (
                    <div key={i} className="flex items-center gap-2 border p-2 rounded">
                      <span className="text-sm text-muted-foreground w-6 text-center">{i + 1}</span>
                      <SearchableSelect
                        value={lineSelectValue(pp)}
                        onValueChange={v => updatePanel(i, v)}
                        options={lineOptions(pp)}
                        placeholder="Select panel or product..."
                        searchPlaceholder="Search by code or name..."
                        emptyText="Nothing matches."
                        className="flex-1 h-8 text-xs"
                      />
                      {(() => {
                        const kind = lineItemKind(pp, availableSubProducts);
                        return kind ? (
                          <Badge className={`${kind.color} shrink-0 text-[10px] px-1.5`}>{kind.label}</Badge>
                        ) : null;
                      })()}
                      <Button size="sm" variant="ghost" onClick={() => removePanel(i)} className="text-destructive shrink-0 h-8 w-8 p-0">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {editingProduct && isBundleType(formType) && (
            <div className="rounded-lg border p-3 space-y-2">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <Label className="text-sm font-medium">Smart Report for this package</Label>
                  <p className="text-xs text-muted-foreground">
                    Patients who buy this package get a plain-language report alongside the lab report.
                  </p>
                </div>
                <Switch
                  checked={smartEnabled}
                  disabled={smartBusy || (smartEligibility ? !smartEligibility.eligible : true)}
                  onCheckedChange={async (v) => {
                    setSmartBusy(true);
                    try {
                      await branchRequest(
                        `/smart-reports/products/${editingProduct.id}/enabled`,
                        branchId,
                        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: v }) },
                      );
                      setSmartEnabled(v);
                      toast.success(v ? 'Smart Report enabled for this package' : 'Smart Report disabled');
                    } catch {
                      toast.error('Could not change the Smart Report setting');
                    } finally {
                      setSmartBusy(false);
                    }
                  }}
                />
              </div>
              {smartEligibility && !smartEligibility.eligible && (
                <p className="text-xs text-amber-700">
                  Not available for this package: {smartEligibility.reasons.join('; ')}.
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : editingProduct ? 'Update Product' : 'Create Product'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Branch Pricing Dialog ────────────────────────────────────────── */}
      <Dialog open={pricingOpen} onOpenChange={setPricingOpen}>
        <DialogContent className="max-w-xl max-h-[75vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <IndianRupee className="h-4 w-4" /> Branch Pricing: {pricingProduct?.name}
            </DialogTitle>
            <DialogDescription>
              Override the base price for specific branches. Branches without overrides use the base price.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 rounded-lg text-sm">
            <span className="text-muted-foreground">Base price:</span>
            <span className="font-mono font-medium">{pricingProduct ? formatPrice(pricingProduct.basePrice) : '—'}</span>
          </div>

          <div className="space-y-2">
            {pricingData.map((row, i) => (
              <div key={i} className="flex items-center gap-2">
                <Select value={row.branchId} onValueChange={v => updatePricingRow(i, 'branchId', v)}>
                  <SelectTrigger className="flex-1 h-8 text-xs">
                    <SelectValue placeholder="Select branch..." />
                  </SelectTrigger>
                  <SelectContent>
                    {branchOptions.map(b => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Input type="number" placeholder="Price" value={row.price}
                  onChange={e => updatePricingRow(i, 'price', parseFloat(e.target.value) || 0)}
                  className="w-24 h-8 text-xs" />
                <Switch checked={row.isActive} onCheckedChange={v => updatePricingRow(i, 'isActive', v)} />
                <Button size="sm" variant="ghost" onClick={() => removePricingRow(i)} className="text-destructive h-8 w-8 p-0">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>

          <Button onClick={addPricingRow} size="sm" variant="outline" className="mt-2">
            <Plus className="h-3 w-3 mr-1" /> Add Override
          </Button>

          <DialogFooter>
            <Button variant="outline" onClick={() => setPricingOpen(false)}>Cancel</Button>
            <Button onClick={savePricing} disabled={saving}>
              {saving ? 'Saving...' : 'Save Pricing'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Delete Confirmation Dialog ──────────────────────────────────── */}
      <Dialog open={!!deleteConfirm} onOpenChange={open => { if (!open) setDeleteConfirm(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Product</DialogTitle>
            <DialogDescription>
              Are you sure you want to permanently delete <strong>{deleteConfirm?.name}</strong>?
              This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)} disabled={deleting}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}

/* ───────── Print document ─────────
 * Hidden on screen; the global @media print rules show only `.print-content`.
 * Black-and-white letterhead, same conventions as the payout statement print.
 */
function PriceListPrint({ rows, branchName }: { rows: BillableProduct[]; branchName?: string }) {
  const td: CSSProperties = { border: '1px solid #999', padding: '3px 6px', fontSize: 10 };
  const th: CSSProperties = { ...td, background: '#eee', fontWeight: 600, textAlign: 'left' };
  const today = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

  return (
    <div className="hidden print:block print-content print-page" style={{ paddingTop: '8mm' }}>
      {/* Letterhead — img needs explicit centering (Tailwind resets img to display:block) */}
      <div style={{ textAlign: 'center', borderBottom: '2px solid #111', paddingBottom: 8, marginBottom: 10 }}>
        <img src={LOGO_URL} alt="Sobhana" style={{ height: 46, display: 'block', margin: '0 auto' }} />
        <div style={{ fontWeight: 700, letterSpacing: '0.14em', marginTop: 6, fontSize: 13 }}>
          PRICE LIST
        </div>
      </div>

      {/* Meta */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, marginBottom: 8 }}>
        <div>
          {branchName && <><b>{branchName}</b><br /></>}
          Effective: {today}
        </div>
        <div style={{ textAlign: 'right' }}>
          {rows.length} item{rows.length === 1 ? '' : 's'}
        </div>
      </div>

      {/* Table */}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ ...th, width: 34, textAlign: 'center' }}>S.No</th>
            <th style={{ ...th, width: 90 }}>Code</th>
            <th style={th}>Test / Investigation</th>
            <th style={{ ...th, width: 90, textAlign: 'right' }}>Price (₹)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => (
            <tr key={p.id}>
              <td style={{ ...td, textAlign: 'center' }}>{i + 1}</td>
              <td style={{ ...td, fontFamily: 'ui-monospace, monospace', fontSize: 9 }}>{p.code}</td>
              <td style={td}>{p.name}</td>
              <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {(p.effectivePrice ?? p.basePrice).toLocaleString('en-IN')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Footer */}
      <div style={{ marginTop: 10, fontSize: 9, color: '#444', textAlign: 'center' }}>
        Prices are subject to change without notice.
      </div>
    </div>
  );
}
