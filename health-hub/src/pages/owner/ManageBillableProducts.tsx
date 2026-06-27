import { useState, useEffect, useCallback, useRef } from 'react';
import { API_BASE } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';
import { toast } from 'sonner';
import {
  Plus, Pencil, Search, Package, IndianRupee, Trash2,
  CheckCircle2, AlertCircle, Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/ui/loading-state';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
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

type WorkflowMode = 'REPORTABLE' | 'BILL_ONLY' | 'EXTERNAL_UPLOAD';

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
  { value: 'PANEL_BUNDLE', label: 'Panel Bundle', color: 'bg-purple-100 text-purple-800' },
  { value: 'CUSTOM_PACKAGE', label: 'Custom Package', color: 'bg-green-100 text-green-800' },
];

const WORKFLOW_MODES = [
  { value: 'REPORTABLE', label: 'Reportable', color: 'bg-emerald-100 text-emerald-800' },
  { value: 'BILL_ONLY', label: 'Bill Only', color: 'bg-amber-100 text-amber-800' },
  { value: 'EXTERNAL_UPLOAD', label: 'External Upload', color: 'bg-sky-100 text-sky-800' },
];

const WORKFLOW_LABELS: Record<WorkflowMode, string> = {
  REPORTABLE: 'Reportable',
  BILL_ONLY: 'Bill Only',
  EXTERNAL_UPLOAD: 'External Upload',
};

function typeBadgeColor(productType: string) {
  const pt = PRODUCT_TYPES.find(p => p.value === productType);
  return pt ? pt.color : 'bg-muted text-foreground';
}

function workflowBadgeColor(workflowMode: string) {
  const wm = WORKFLOW_MODES.find((mode) => mode.value === workflowMode);
  return wm ? wm.color : 'bg-muted text-foreground';
}

const CODE_REGEX = /^[A-Z0-9_]{2,20}$/;

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

  // Main dialog
  const [dialogOpen, setDialogOpen] = useState(false);
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
  const [formPayoutCategory, setFormPayoutCategory] = useState('');
  const [formPanels, setFormPanels] = useState<ProductPanel[]>([]);

  // Payout-category suggestions: the centre's departments + any category labels
  // already in use across products (so the owner reuses consistent names).
  const [departmentNames, setDepartmentNames] = useState<string[]>([]);
  const categorySuggestions = Array.from(
    new Set([
      ...departmentNames,
      ...products.map((p) => p.payoutCategory).filter((c): c is string => !!c),
    ])
  ).sort((a, b) => a.localeCompare(b));

  // Code validation
  const [codeAvailable, setCodeAvailable] = useState<boolean | null>(null);
  const [codeChecking, setCodeChecking] = useState(false);
  const codeCheckTimer = useRef<ReturnType<typeof setTimeout>>(null);

  // ─── Data fetching ──────────────────────────────────────────────────────

  const fetchProducts = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (selectedBranch?.id) params.set('branchId', selectedBranch.id);
      params.set('active', 'all'); // Show active and inactive products in management view
      const res = await fetch(`${API_BASE}/billable-products?${params}`, { headers });
      if (!res.ok) throw new Error('Failed to fetch');
      setProducts(await res.json());
    } catch {
      toast.error('Failed to load products');
    } finally {
      setLoading(false);
    }
  }, [search, selectedBranch?.id]);

  const fetchDependencies = useCallback(async () => {
    try {
      const [panelsRes, branchRes, billOnlyRes, deptRes] = await Promise.all([
        fetch(`${API_BASE}/clinical-panels`, { headers }),
        fetch(`${API_BASE}/branches`, { headers }),
        fetch(`${API_BASE}/billable-products?workflowMode=BILL_ONLY`, { headers }),
        fetch(`${API_BASE}/departments`, { headers }),
      ]);
      if (panelsRes.ok) setAvailablePanels(await panelsRes.json());
      if (branchRes.ok) setBranchOptions(await branchRes.json());
      if (deptRes.ok) {
        const depts: any[] = await deptRes.json();
        setDepartmentNames(depts.map((d) => d.name).filter(Boolean));
      }
      if (billOnlyRes.ok) {
        const items: any[] = await billOnlyRes.json();
        setAvailableSubProducts(items.map((p) => ({
          id: p.id,
          code: p.code,
          name: p.name,
          workflowMode: p.workflowMode,
          basePrice: p.basePrice,
          basePriceInPaise: p.basePriceInPaise,
        })));
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchProducts(); }, [fetchProducts]);
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
    setFormBasePrice(''); setFormActive(true); setFormDescription('');
    setFormPayoutCategory('');
    setFormPanels([]); setEditingProduct(null);
    setCodeAvailable(null); setCodeChecking(false);
  };

  const populateForm = (p: BillableProduct) => {
    setFormName(p.name);
    setFormCode(p.code);
    setFormType(p.productType);
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

    // Line-item validation — each row points at exactly one of panel/sub-product
    const validLines = formPanels.filter(p => p.panelId || p.childProductId);
    if (formWorkflowMode === 'REPORTABLE' && formType === 'INDIVIDUAL_TEST' && validLines.length > 1) {
      toast.error('Individual Test products can have at most 1 line item');
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
        productType: formType,
        workflowMode: formWorkflowMode,
        basePrice: parseFloat(formBasePrice),
        isActive: formActive,
        description: formDescription || null,
        payoutCategory: formPayoutCategory.trim() || null,
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
      setPricingData(await res.json());
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
        body: JSON.stringify({ pricingOverrides: pricingData.map(p => ({
          branchId: p.branchId, price: p.price, isActive: p.isActive,
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
        <Button onClick={openCreate} size="sm">
          <Plus className="h-4 w-4 mr-1" /> New Product
        </Button>
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search products..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="pl-8"
        />
      </div>

      {/* Table */}
      {loading ? (
        <LoadingState />
      ) : products.length === 0 ? (
        <EmptyState title="No products found" />
      ) : (
        <div className="border rounded-lg overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40">
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
              {products.map(product => (
                <TableRow key={product.id} className="hover:bg-muted/50">
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
                    <Badge className={typeBadgeColor(product.productType)}>
                      {product.productType.replace(/_/g, ' ')}
                    </Badge>
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

      <p className="text-xs text-muted-foreground text-right">
        Showing {products.length} product{products.length !== 1 ? 's' : ''}
      </p>

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
              <Select value={formType} onValueChange={setFormType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PRODUCT_TYPES.map(pt => (
                    <SelectItem key={pt.value} value={pt.value}>{pt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Workflow</Label>
              <Select
                value={formWorkflowMode}
                onValueChange={(value) => setFormWorkflowMode(value as WorkflowMode)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {WORKFLOW_MODES.map((mode) => (
                    <SelectItem key={mode.value} value={mode.value}>{mode.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Base Price (₹) *</Label>
              <Input type="number" value={formBasePrice} onChange={e => setFormBasePrice(e.target.value)} />
            </div>
            <div>
              <Label>Payout category</Label>
              <Input
                value={formPayoutCategory}
                onChange={e => setFormPayoutCategory(e.target.value)}
                list="payout-category-options"
                placeholder="e.g. X-Ray, Laboratory"
              />
              <datalist id="payout-category-options">
                {categorySuggestions.map(c => <option key={c} value={c} />)}
              </datalist>
            </div>
            <div className="flex items-center gap-2 col-span-2">
              <Switch checked={formActive} onCheckedChange={setFormActive} />
              <Label>Active</Label>
            </div>
            <div className="col-span-2">
              <Label>Description</Label>
              <Input value={formDescription} onChange={e => setFormDescription(e.target.value)} />
            </div>
          </div>

          <Separator />

          {/* ─── Panels ──────────────────────────────────────────────── */}
          {formWorkflowMode === 'EXTERNAL_UPLOAD' ? (
            <div className="mt-2 rounded border border-dashed p-3 text-xs text-muted-foreground">
              External Upload products do not require panels. Staff will attach the report PDF on the result-entry screen; the upload is merged into the patient's report with the Sobhana letterhead.
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
                  ? 'Reportable products require at least one line item — a clinical panel or a bill-only sub-product.'
                  : 'Bill-only products can be billed without lines. Linked lines are only used after switching back to Reportable.'}
              </p>

              {formPanels.length === 0 ? (
                <p className="text-sm text-muted-foreground">No items linked.</p>
              ) : (
                <div className="space-y-2">
                  {formPanels.map((pp, i) => (
                    <div key={i} className="flex items-center gap-2 border p-2 rounded">
                      <span className="text-sm text-muted-foreground w-6 text-center">{i + 1}</span>
                      <Select
                        value={lineSelectValue(pp)}
                        onValueChange={v => updatePanel(i, v)}
                      >
                        <SelectTrigger className="flex-1 h-8 text-xs">
                          <SelectValue placeholder="Select panel or bill-only item..." />
                        </SelectTrigger>
                        <SelectContent>
                          {availablePanels.length > 0 && (
                            <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                              Clinical Panels
                            </div>
                          )}
                          {availablePanels.map(p => (
                            <SelectItem key={`panel:${p.id}`} value={`panel:${p.id}`}>
                              {p.code} – {p.name}{p.itemCount ? ` (${p.itemCount} tests)` : ''}
                            </SelectItem>
                          ))}
                          {availableSubProducts.length > 0 && (
                            <div className="px-2 py-1 mt-1 border-t text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                              Bill-Only Items
                            </div>
                          )}
                          {availableSubProducts
                            // Don't allow a product to include itself
                            .filter(sp => !editingProduct || sp.id !== editingProduct.id)
                            .map(sp => (
                              <SelectItem key={`child:${sp.id}`} value={`child:${sp.id}`}>
                                {sp.code} – {sp.name}
                                {sp.basePrice != null ? ` (₹${sp.basePrice})` : ''}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                      <Button size="sm" variant="ghost" onClick={() => removePanel(i)} className="text-destructive shrink-0 h-8 w-8 p-0">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
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
