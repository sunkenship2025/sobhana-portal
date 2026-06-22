import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Building2,
  ChevronDown,
  ChevronUp,
  FlaskConical,
  RefreshCw,
  Stethoscope,
  Users,
} from 'lucide-react';
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { API_BASE } from '@/lib/api';
import { apiRequest, cn } from '@/lib/utils';

type SignalStatus = 'BELOW_EXPECTED' | 'ABOVE_EXPECTED' | 'TYPICAL';
type MetricKey = 'revenue' | 'patients' | 'diagnostics' | 'clinic';

interface MetricBand {
  median: number;
  lower_bound: number;
  upper_bound: number;
}

interface SignalMetric extends MetricBand {
  value: number;
  deviation_percent: number;
  signal_status: SignalStatus;
}

interface TrendPoint extends MetricBand {
  date: string;
  value: number;
  deviation_percent: number;
  is_anomaly: boolean;
  severity: number;
}

interface CompositionSegment {
  segment: 'clinic' | 'diagnostics';
  current_percent: number;
  baseline_percent: number;
}

interface TopIssue {
  entity_type: 'branch';
  entity_id: string;
  entity_name: string;
  value: number;
  deviation_percent: number;
  signal_status: SignalStatus;
  rank: number;
}

interface AlertItem {
  entity: string;
  issue: string;
  severity: 'HIGH';
  is_duplicate: boolean;
}

interface DoctorContributionRow {
  id: string;
  name: string;
  revenue: number;
  contribution_percent: number;
}

interface BranchBreakdownRow {
  branch_id: string;
  branch_name: string;
  revenue: number;
  patients: number;
  diagnostics: number;
  clinic: number;
  deviation_percent: number;
  signal_status: SignalStatus;
}

interface OwnerDashboardResponse {
  generated_at: string;
  window: {
    today: string;
    trend_days: number;
    baseline_weeks: number;
  };
  signals: Record<MetricKey, SignalMetric>;
  trend: {
    metric: 'revenue';
    points: TrendPoint[];
  };
  composition: {
    segments: CompositionSegment[];
  };
  insight: string;
  top_issues: TopIssue[];
  alerts: AlertItem[];
  advanced_breakdown: {
    doctor_contribution: {
      clinic_doctors: DoctorContributionRow[];
      referral_doctors: DoctorContributionRow[];
    };
    full_branch_table: BranchBreakdownRow[];
    extended_analytics: {
      anomaly_days: TrendPoint[];
      revenue_mix: {
        clinic: number;
        diagnostics: number;
      };
    };
  };
}

const currencyFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

const numberFormatter = new Intl.NumberFormat('en-IN', {
  maximumFractionDigits: 0,
});

const dateTimeFormatter = new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const METRIC_META: Record<
  MetricKey,
  {
    label: string;
    icon: typeof Users;
  }
> = {
  revenue: { label: 'Revenue', icon: Building2 },
  patients: { label: 'Patients', icon: Users },
  diagnostics: { label: 'Diagnostics', icon: FlaskConical },
  clinic: { label: 'Clinic', icon: Stethoscope },
};

function formatMetricValue(metric: MetricKey, value: number): string {
  if (metric === 'revenue') {
    return currencyFormatter.format(value);
  }

  return numberFormatter.format(value);
}

function formatExpectedRange(metric: MetricKey, lowerBound: number, upperBound: number): string {
  return `Expected ${formatMetricValue(metric, lowerBound)}-${formatMetricValue(metric, upperBound)}`;
}

function formatPercent(value: number, options?: { absolute?: boolean }): string {
  const next = options?.absolute ? Math.abs(value) : value;
  const rounded = Math.round(next);
  return `${rounded}%`;
}

function getSignalMeta(status: SignalStatus) {
  switch (status) {
    case 'BELOW_EXPECTED':
      return {
        label: 'Below Expected',
        icon: ArrowDownRight,
        className:
          'border-destructive/30 bg-destructive/10 text-destructive dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300',
      };
    case 'ABOVE_EXPECTED':
      return {
        label: 'Above Expected',
        icon: ArrowUpRight,
        className:
          'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300',
      };
    default:
      return {
        label: 'Typical',
        icon: ChevronUp,
        className:
          'border-border bg-muted text-foreground dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-300',
      };
  }
}

function LayerHeading({
  layer,
  title,
  description,
}: {
  layer: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
        {layer}
      </p>
      <div>
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
    </div>
  );
}

function SignalCard({
  metricKey,
  metric,
}: {
  metricKey: MetricKey;
  metric: SignalMetric;
}) {
  const meta = METRIC_META[metricKey];
  const signalMeta = getSignalMeta(metric.signal_status);
  const SignalIcon = signalMeta.icon;
  const Icon = meta.icon;
  const deviationDirection = metric.deviation_percent > 0 ? 'above' : 'below';

  return (
    <Card className="border-border/70 shadow-sm">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <div className="rounded-full bg-primary/10 p-2 text-primary">
                <Icon className="h-4 w-4" />
              </div>
              <p className="text-sm font-semibold text-foreground">{meta.label}</p>
            </div>

            <div className="space-y-1">
              <p className="text-3xl font-bold tracking-tight text-foreground">
                {formatMetricValue(metricKey, metric.value)}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className={cn('gap-1 rounded-full px-2.5 py-1 text-xs font-medium', signalMeta.className)}
                >
                  <SignalIcon className="h-3.5 w-3.5" />
                  {signalMeta.label}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  {metric.deviation_percent === 0
                    ? 'On baseline'
                    : `${formatPercent(metric.deviation_percent, { absolute: true })} ${deviationDirection} median`}
                </span>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-border/60 bg-muted/40 px-3 py-2 text-right">
            <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
              Range
            </p>
            <p className="mt-1 text-sm font-semibold text-foreground">
              {formatExpectedRange(metricKey, metric.lower_bound, metric.upper_bound).replace('Expected ', '')}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function TrendTooltipContent({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: TrendPoint }>;
}) {
  if (!active || !payload?.length) {
    return null;
  }

  const point = payload[0].payload;
  return (
    <div className="rounded-xl border bg-background px-3 py-2 shadow-lg">
      <p className="text-sm font-semibold text-foreground">{point.date}</p>
      <div className="mt-2 space-y-1 text-sm">
        <p className="text-foreground">Revenue: {currencyFormatter.format(point.value)}</p>
        <p className="text-muted-foreground">
          Expected: {currencyFormatter.format(point.lower_bound)} - {currencyFormatter.format(point.upper_bound)}
        </p>
        <p className={cn(point.deviation_percent < 0 ? 'text-destructive' : 'text-emerald-600')}>
          Deviation: {formatPercent(point.deviation_percent)}
        </p>
      </div>
    </div>
  );
}

function TrendDot(props: {
  cx?: number;
  cy?: number;
  payload?: TrendPoint;
}) {
  const { cx, cy, payload } = props;
  if (!payload?.is_anomaly || cx === undefined || cy === undefined) {
    return null;
  }

  return (
    <circle
      cx={cx}
      cy={cy}
      r={5}
      fill="#dc2626"
      stroke="white"
      strokeWidth={2}
    />
  );
}

function ComparisonTooltipContent({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string; value?: number }>;
  label?: string;
}) {
  if (!active || !payload?.length) {
    return null;
  }

  const current = payload.find((entry) => entry.dataKey === 'current_percent')?.value ?? 0;
  const baseline = payload.find((entry) => entry.dataKey === 'baseline_percent')?.value ?? 0;

  return (
    <div className="rounded-xl border bg-background px-3 py-2 shadow-lg">
      <p className="text-sm font-semibold text-foreground">{label}</p>
      <div className="mt-2 space-y-1 text-sm">
        <p className="text-foreground">Current: {formatPercent(current)}</p>
        <p className="text-muted-foreground">Baseline: {formatPercent(baseline)}</p>
      </div>
    </div>
  );
}

function DoctorContributionChart({
  title,
  description,
  rows,
  emptyText,
  barColor,
}: {
  title: string;
  description: string;
  rows: DoctorContributionRow[];
  emptyText: string;
  barColor: string;
}) {
  const chartRows = rows
    .slice(0, 6)
    .map((row) => ({
      ...row,
      short_name: row.name.length > 18 ? `${row.name.slice(0, 18)}…` : row.name,
    }))
    .reverse();

  return (
    <Card className="border-border/70">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            {emptyText}
          </div>
        ) : (
          <>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartRows} layout="vertical" margin={{ top: 0, right: 16, left: 16, bottom: 0 }}>
                  <CartesianGrid horizontal={false} strokeDasharray="3 3" strokeOpacity={0.2} />
                  <XAxis type="number" tickFormatter={(value) => currencyFormatter.format(value)} />
                  <YAxis
                    type="category"
                    dataKey="short_name"
                    width={110}
                    tick={{ fontSize: 12 }}
                  />
                  <Tooltip
                    cursor={{ fill: 'rgba(148, 163, 184, 0.12)' }}
                    formatter={(value: number) => currencyFormatter.format(value)}
                  />
                  <Bar dataKey="revenue" fill={barColor} radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="space-y-2">
              {rows.slice(0, 4).map((row) => (
                <div key={row.id} className="flex items-center justify-between gap-3 rounded-xl bg-muted/40 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{row.name}</p>
                    <p className="text-xs text-muted-foreground">{formatPercent(row.contribution_percent)} of tracked revenue</p>
                  </div>
                  <p className="text-sm font-semibold text-foreground">{currencyFormatter.format(row.revenue)}</p>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Business Metrics Panel — KPI cards backed by /api/owner/metrics
// ---------------------------------------------------------------------------

type MetricsWindow = 'today' | '7d' | '30d';

interface OwnerMetricsResponse {
  window: MetricsWindow;
  windowStart: string;
  windowEnd: string;
  generatedAt: string;
  visits: { total: number; diagnostics: number; clinic: number };
  revenue: {
    grossInPaise: number;
    netInPaise: number;
    paidInPaise: number;
    dueInPaise: number;
    discountInPaise: number;
    billCount: number;
    averageBillInPaise: number;
  };
  mix: { reportable: number; billOnly: number; externalUpload: number };
  operations: {
    reportsFinalized: number;
    timeToFinalize: { p50Minutes: number | null; p95Minutes: number | null; samples: number };
    whatsapp: { sent: number; delivered: number; failed: number; deliveryRatePct: number | null };
  };
  topTests: Array<{ key: string; label: string; count: number }>;
  topReferringDoctors: Array<{ key: string; label: string; count: number; totalPayoutInPaise: number }>;
}

function formatRupeesFromPaise(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
}

function formatMinutes(min: number | null): string {
  if (min === null) return '—';
  if (min < 60) return `${Math.round(min)}m`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function BusinessMetricsPanel() {
  const [window, setWindow] = useState<MetricsWindow>('7d');

  const metricsQuery = useQuery({
    queryKey: ['owner-metrics', window],
    queryFn: () => apiRequest<OwnerMetricsResponse>(`${API_BASE}/owner/metrics?window=${window}`),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const windowLabel: Record<MetricsWindow, string> = {
    today: 'Today',
    '7d': 'Last 7 days',
    '30d': 'Last 30 days',
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Business snapshot</h2>
          <p className="text-sm text-muted-foreground">
            Volume, revenue, operations — at a glance.
            {metricsQuery.data ? ` Updated ${new Date(metricsQuery.data.generatedAt).toLocaleTimeString()}` : ''}
          </p>
        </div>
        <div className="inline-flex rounded-xl border bg-muted/30 p-1">
          {(['today', '7d', '30d'] as MetricsWindow[]).map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWindow(w)}
              className={cn(
                'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                window === w ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {windowLabel[w]}
            </button>
          ))}
        </div>
      </div>

      {metricsQuery.isLoading && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full rounded-2xl" />
          ))}
        </div>
      )}

      {metricsQuery.isError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Could not load business metrics: {(metricsQuery.error as Error)?.message || 'unknown error'}
          </AlertDescription>
        </Alert>
      )}

      {metricsQuery.data && (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Card className="border-border/70">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Visits</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-semibold">{metricsQuery.data.visits.total.toLocaleString('en-IN')}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {metricsQuery.data.visits.diagnostics} diagnostics · {metricsQuery.data.visits.clinic} clinic
                </p>
              </CardContent>
            </Card>

            <Card className="border-border/70">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Net revenue</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-semibold">{formatRupeesFromPaise(metricsQuery.data.revenue.netInPaise)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Paid {formatRupeesFromPaise(metricsQuery.data.revenue.paidInPaise)} · Due{' '}
                  <span className={metricsQuery.data.revenue.dueInPaise > 0 ? 'font-medium text-amber-700' : ''}>
                    {formatRupeesFromPaise(metricsQuery.data.revenue.dueInPaise)}
                  </span>
                </p>
              </CardContent>
            </Card>

            <Card className="border-border/70">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Reports finalized</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-semibold">{metricsQuery.data.operations.reportsFinalized.toLocaleString('en-IN')}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Time-to-finalize p50 {formatMinutes(metricsQuery.data.operations.timeToFinalize.p50Minutes)} · p95{' '}
                  {formatMinutes(metricsQuery.data.operations.timeToFinalize.p95Minutes)}
                </p>
              </CardContent>
            </Card>

            <Card className="border-border/70">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">WhatsApp delivery</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-semibold">
                  {metricsQuery.data.operations.whatsapp.deliveryRatePct === null
                    ? '—'
                    : `${metricsQuery.data.operations.whatsapp.deliveryRatePct}%`}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {metricsQuery.data.operations.whatsapp.delivered} delivered ·{' '}
                  <span className={metricsQuery.data.operations.whatsapp.failed > 0 ? 'font-medium text-destructive' : ''}>
                    {metricsQuery.data.operations.whatsapp.failed} failed
                  </span>
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <Card className="border-border/70">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Visit mix</CardTitle>
                <CardDescription>By workflow type</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Reportable</span>
                  <span className="font-medium">{metricsQuery.data.mix.reportable}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Bill-only</span>
                  <span className="font-medium">{metricsQuery.data.mix.billOnly}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">External upload</span>
                  <span className="font-medium">{metricsQuery.data.mix.externalUpload}</span>
                </div>
              </CardContent>
            </Card>

            <Card className="border-border/70">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Top tests</CardTitle>
                <CardDescription>By order count</CardDescription>
              </CardHeader>
              <CardContent className="space-y-1.5 text-sm">
                {metricsQuery.data.topTests.length === 0 ? (
                  <p className="text-muted-foreground">No reportable tests in window</p>
                ) : (
                  metricsQuery.data.topTests.map((t) => (
                    <div key={t.key} className="flex justify-between">
                      <span className="truncate text-muted-foreground">{t.label}</span>
                      <span className="font-medium">{t.count}</span>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card className="border-border/70">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Top referring doctors</CardTitle>
                <CardDescription>By visit count</CardDescription>
              </CardHeader>
              <CardContent className="space-y-1.5 text-sm">
                {metricsQuery.data.topReferringDoctors.length === 0 ? (
                  <p className="text-muted-foreground">No referrals in window</p>
                ) : (
                  metricsQuery.data.topReferringDoctors.map((d) => (
                    <div key={d.key} className="flex justify-between">
                      <span className="truncate text-muted-foreground">{d.label}</span>
                      <span className="font-medium">{d.count}</span>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </section>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-28 w-full rounded-3xl" />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-40 w-full rounded-2xl" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-[1.1fr_1.9fr]">
        <Skeleton className="h-[360px] w-full rounded-2xl" />
        <Skeleton className="h-[360px] w-full rounded-2xl" />
      </div>
      <Skeleton className="h-28 w-full rounded-2xl" />
      <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <Skeleton className="h-72 w-full rounded-2xl" />
        <Skeleton className="h-72 w-full rounded-2xl" />
      </div>
    </div>
  );
}

const OwnerDashboard = () => {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const dashboardQuery = useQuery({
    queryKey: ['owner-dashboard'],
    queryFn: () => apiRequest<OwnerDashboardResponse>(`${API_BASE}/owner/dashboard`),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });

  const trendChartData = useMemo(
    () =>
      (dashboardQuery.data?.trend.points ?? []).map((point) => ({
        ...point,
        band_span: Math.max(point.upper_bound - point.lower_bound, 0),
      })),
    [dashboardQuery.data],
  );

  const compositionChartData = useMemo(
    () => dashboardQuery.data?.composition.segments.map((segment) => ({
      name: segment.segment === 'clinic' ? 'Clinic' : 'Diagnostics',
      current_percent: segment.current_percent,
      baseline_percent: segment.baseline_percent,
    })) ?? [],
    [dashboardQuery.data],
  );

  if (dashboardQuery.isLoading) {
    return (
      <AppLayout context="owner" hideContextBanner>
        <DashboardSkeleton />
      </AppLayout>
    );
  }

  if (dashboardQuery.isError || !dashboardQuery.data) {
    return (
      <AppLayout context="owner" hideContextBanner>
        <div className="space-y-6">
          <div className="rounded-3xl border bg-gradient-to-r from-slate-900 via-slate-800 to-slate-700 p-6 text-white shadow-xl">
            <h1 className="text-3xl font-semibold tracking-tight">Decision-First Owner Dashboard</h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-200">
              This view is designed to surface today&apos;s business signal first, then only the deeper context you need to act.
            </p>
          </div>

          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Owner dashboard unavailable</AlertTitle>
            <AlertDescription>
              {(dashboardQuery.error as Error | undefined)?.message || 'We could not load analytics right now.'}
            </AlertDescription>
          </Alert>

          <Button onClick={() => dashboardQuery.refetch()} className="w-fit">
            <RefreshCw className="mr-2 h-4 w-4" />
            Retry
          </Button>
        </div>
      </AppLayout>
    );
  }

  const data = dashboardQuery.data;
  const todayRevenueMix = data.advanced_breakdown.extended_analytics.revenue_mix;
  const hasTodayRevenue = (todayRevenueMix.clinic + todayRevenueMix.diagnostics) > 0;
  const hasTodayOperationalActivity = data.advanced_breakdown.full_branch_table.some(
    (branch) => branch.patients > 0 || branch.revenue > 0 || branch.diagnostics > 0 || branch.clinic > 0,
  );
  const hasComparisonData = compositionChartData.some(
    (segment) => segment.current_percent > 0 || segment.baseline_percent > 0,
  );

  return (
    <AppLayout context="owner" hideContextBanner>
      <div className="space-y-6">
        <section className="rounded-[28px] border bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 p-6 text-white shadow-xl">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-3">
              <Badge
                variant="outline"
                className="w-fit rounded-full border-white/15 bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-white"
              >
                Owner Analytics
              </Badge>
              <div>
                <h1 className="text-3xl font-semibold tracking-tight">Decision-First Owner Dashboard</h1>
                <p className="mt-2 max-w-3xl text-sm text-slate-200">
                  Current health first, explanations second, and deep analysis only when you ask for it.
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm">
                <p className="text-slate-300">Updated</p>
                <p className="font-medium text-white">{dateTimeFormatter.format(new Date(data.generated_at))}</p>
              </div>
              <Button
                variant="secondary"
                className="rounded-2xl bg-white text-foreground hover:bg-muted"
                onClick={() => dashboardQuery.refetch()}
                disabled={dashboardQuery.isFetching}
              >
                <RefreshCw className={cn('mr-2 h-4 w-4', dashboardQuery.isFetching && 'animate-spin')} />
                Refresh
              </Button>
            </div>
          </div>
        </section>

        <BusinessMetricsPanel />

        <section className="space-y-4">
          <LayerHeading
            layer="Signal Layer"
            title="Business status in one glance"
            description="These cards are the default read. They show only today’s signal against the expected range."
          />
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {(['revenue', 'patients', 'diagnostics', 'clinic'] as MetricKey[]).map((metricKey) => (
              <SignalCard
                key={metricKey}
                metricKey={metricKey}
                metric={data.signals[metricKey]}
              />
            ))}
          </div>
        </section>

        <section className="grid gap-4 xl:grid-cols-[1.05fr_1.95fr]">
          <Card className="overflow-hidden border-border/70 shadow-sm">
            <CardHeader className="space-y-3">
              <LayerHeading
                layer="Comparison Layer"
                title="Revenue shift"
                description="Current mix versus the same weekday baseline."
              />
            </CardHeader>
            <CardContent className="space-y-4">
              {hasComparisonData ? (
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={compositionChartData} margin={{ top: 12, right: 12, left: 12, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} strokeOpacity={0.2} />
                      <XAxis dataKey="name" tickLine={false} axisLine={false} />
                      <YAxis
                        tickFormatter={(value) => `${value}%`}
                        tickLine={false}
                        axisLine={false}
                        width={56}
                        tickMargin={8}
                        allowDecimals={false}
                        domain={[0, 100]}
                        ticks={[0, 25, 50, 75, 100]}
                      />
                      <Tooltip content={<ComparisonTooltipContent />} />
                      <Bar dataKey="current_percent" name="Current" fill="#1d4ed8" radius={[8, 8, 0, 0]} />
                      <Bar dataKey="baseline_percent" name="Baseline" fill="#bfdbfe" radius={[8, 8, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-border px-4 py-10 text-center">
                  <p className="text-sm font-medium text-foreground">No billed revenue in the current comparison window yet.</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    The owner API is connected, but today has no clinic or diagnostics bills yet, so there is no mix shift to compare.
                  </p>
                </div>
              )}

              <div className="grid gap-2 sm:grid-cols-2">
                {data.composition.segments.map((segment) => (
                  <div key={segment.segment} className="rounded-2xl bg-muted/40 px-4 py-3">
                    <p className="text-sm font-medium text-foreground">
                      {segment.segment === 'clinic' ? 'Clinic' : 'Diagnostics'}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Current {formatPercent(segment.current_percent)} vs baseline {formatPercent(segment.baseline_percent)}
                    </p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/70 shadow-sm">
            <CardHeader className="space-y-3">
              <LayerHeading
                layer="Temporal Layer"
                title={`Revenue trend (${data.window.trend_days} days)`}
                description="Actual revenue against the expected band, with only the strongest anomalies marked."
              />
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={trendChartData} margin={{ top: 10, right: 10, left: -12, bottom: 0 }}>
                    <defs>
                      <linearGradient id="owner-trend-band" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#93c5fd" stopOpacity={0.6} />
                        <stop offset="100%" stopColor="#dbeafe" stopOpacity={0.16} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} strokeOpacity={0.2} />
                    <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={20} />
                    <YAxis
                      tickFormatter={(value) => currencyFormatter.format(value)}
                      tickLine={false}
                      axisLine={false}
                      width={74}
                    />
                    <Tooltip content={<TrendTooltipContent />} />
                    <Area dataKey="lower_bound" stackId="expected" fill="transparent" stroke="transparent" />
                    <Area dataKey="band_span" stackId="expected" fill="url(#owner-trend-band)" stroke="transparent" />
                    <Line
                      type="monotone"
                      dataKey="value"
                      stroke="#0f4f85"
                      strokeWidth={3}
                      dot={<TrendDot />}
                      activeDot={{ r: 6, strokeWidth: 0, fill: '#0f4f85' }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              <div className="rounded-2xl border border-border/70 bg-muted/30 px-4 py-3">
                <p className="text-sm text-muted-foreground">
                  {data.trend.points.filter((point) => point.is_anomaly).length} anomaly markers shown from the last {data.window.trend_days} days.
                </p>
              </div>
            </CardContent>
          </Card>
        </section>

        <section>
          <Card className="border-border/70 shadow-sm">
            <CardHeader className="space-y-3">
              <LayerHeading
                layer="Causal Layer"
                title="Primary insight"
                description="A single synthesized explanation pulled from the current signal, mix, and branch pattern."
              />
            </CardHeader>
            <CardContent>
              <div className="rounded-2xl border border-primary/20 bg-primary/5 px-5 py-4">
                <p className="text-lg font-medium leading-7 text-foreground">{data.insight}</p>
              </div>
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
          <Card className="border-border/70 shadow-sm">
            <CardHeader className="space-y-3">
              <LayerHeading
                layer="Drilldown Layer"
                title="Top issues"
                description="The worst branch-level misses, sorted by deviation so you know where to intervene first."
              />
            </CardHeader>
            <CardContent>
              {data.top_issues.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                  No branches are materially below expected right now.
                </div>
              ) : (
                <div className="space-y-3">
                  {data.top_issues.map((issue) => {
                    const signalMeta = getSignalMeta(issue.signal_status);
                    return (
                      <div
                        key={issue.entity_id}
                        className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-card px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="flex items-start gap-3">
                          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-destructive/10 text-sm font-semibold text-destructive dark:bg-red-950/40 dark:text-red-300">
                            {issue.rank}
                          </div>
                          <div>
                            <p className="font-semibold text-foreground">{issue.entity_name}</p>
                            <p className="text-sm text-muted-foreground">
                              Revenue {currencyFormatter.format(issue.value)}
                            </p>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                          <Badge
                            variant="outline"
                            className={cn('rounded-full px-2.5 py-1 text-xs font-medium', signalMeta.className)}
                          >
                            {signalMeta.label}
                          </Badge>
                          <p className="text-sm font-medium text-destructive dark:text-red-300">
                            {formatPercent(issue.deviation_percent)} vs median
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-border/70 shadow-sm">
            <CardHeader className="space-y-3">
              <LayerHeading
                layer="Alert Layer"
                title="Critical warnings"
                description="High-severity warnings not already covered by the main signal cards or top issues."
              />
            </CardHeader>
            <CardContent>
              {data.alerts.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                  No additional critical warnings right now.
                </div>
              ) : (
                <div className="space-y-3">
                  {data.alerts.map((alert) => (
                    <div
                      key={`${alert.entity}-${alert.issue}`}
                      className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50/70 px-4 py-4 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100"
                    >
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <div>
                        <p className="font-semibold">{alert.entity}</p>
                        <p className="text-sm opacity-90">{alert.issue}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        <section>
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <Card className="border-border/70 shadow-sm">
              <CardHeader className="space-y-3">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <LayerHeading
                    layer="Exploratory Layer"
                    title="Advanced breakdown (optional)"
                    description="Expanded detail for owners who want to investigate contribution, branch spread, and anomalies."
                  />
                  <CollapsibleTrigger asChild>
                    <Button variant="outline" className="w-fit rounded-2xl">
                      {advancedOpen ? (
                        <ChevronUp className="mr-2 h-4 w-4" />
                      ) : (
                        <ChevronDown className="mr-2 h-4 w-4" />
                      )}
                      {advancedOpen ? 'Hide details' : 'Show details'}
                    </Button>
                  </CollapsibleTrigger>
                </div>
              </CardHeader>

              <CollapsibleContent>
                <CardContent className="space-y-6">
                  <div className="grid gap-4 xl:grid-cols-2">
                    <DoctorContributionChart
                      title="Clinic doctor contribution"
                      description="Last 30 days of clinic revenue by doctor."
                      rows={data.advanced_breakdown.doctor_contribution.clinic_doctors}
                      emptyText="No tracked clinic doctor contribution in the current window."
                      barColor="#0f766e"
                    />
                    <DoctorContributionChart
                      title="Referral doctor contribution"
                      description="Last 30 days of diagnostics revenue allocated across referral doctors."
                      rows={data.advanced_breakdown.doctor_contribution.referral_doctors}
                      emptyText="No referral-driven diagnostics revenue in the current window."
                      barColor="#7c3aed"
                    />
                  </div>

                  <div className="grid gap-4 xl:grid-cols-[1.4fr_0.6fr]">
                    <Card className="border-border/70">
                    <CardHeader className="pb-3">
                        <CardTitle className="text-base">Full branch table</CardTitle>
                        <CardDescription>All active branches with today&apos;s revenue, volume, and branch-level signal.</CardDescription>
                      </CardHeader>
                      <CardContent>
                        {!hasTodayOperationalActivity && (
                          <div className="mb-4 rounded-2xl border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
                            No branch activity has been recorded yet today. These rows are live from the owner API, but they&apos;re correctly showing zero until visits or bills come in.
                          </div>
                        )}
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Branch</TableHead>
                              <TableHead className="text-right">Revenue</TableHead>
                              <TableHead className="text-right">Patients</TableHead>
                              <TableHead className="text-right">Diagnostics</TableHead>
                              <TableHead className="text-right">Clinic</TableHead>
                              <TableHead className="text-right">Signal</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {data.advanced_breakdown.full_branch_table.map((branch) => {
                              const signalMeta = getSignalMeta(branch.signal_status);
                              return (
                                <TableRow key={branch.branch_id}>
                                  <TableCell className="font-medium">{branch.branch_name}</TableCell>
                                  <TableCell className="text-right">{currencyFormatter.format(branch.revenue)}</TableCell>
                                  <TableCell className="text-right">{numberFormatter.format(branch.patients)}</TableCell>
                                  <TableCell className="text-right">{numberFormatter.format(branch.diagnostics)}</TableCell>
                                  <TableCell className="text-right">{numberFormatter.format(branch.clinic)}</TableCell>
                                  <TableCell className="text-right">
                                    <div className="inline-flex flex-col items-end gap-1">
                                      <Badge
                                        variant="outline"
                                        className={cn('rounded-full px-2.5 py-1 text-xs font-medium', signalMeta.className)}
                                      >
                                        {signalMeta.label}
                                      </Badge>
                                      <span className="text-xs text-muted-foreground">
                                        {formatPercent(branch.deviation_percent)} vs median
                                      </span>
                                    </div>
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </CardContent>
                    </Card>

                    <div className="space-y-4">
                      <Card className="border-border/70">
                        <CardHeader className="pb-3">
                          <CardTitle className="text-base">Revenue mix</CardTitle>
                          <CardDescription>Today&apos;s revenue split used in the comparison layer.</CardDescription>
                        </CardHeader>
                        <CardContent className="grid gap-3">
                          <div className="rounded-2xl bg-muted/40 px-4 py-3">
                            <p className="text-sm text-muted-foreground">Clinic</p>
                            <p className="mt-1 text-xl font-semibold text-foreground">
                              {currencyFormatter.format(todayRevenueMix.clinic)}
                            </p>
                          </div>
                          <div className="rounded-2xl bg-muted/40 px-4 py-3">
                            <p className="text-sm text-muted-foreground">Diagnostics</p>
                            <p className="mt-1 text-xl font-semibold text-foreground">
                              {currencyFormatter.format(todayRevenueMix.diagnostics)}
                            </p>
                          </div>
                          {!hasTodayRevenue && (
                            <p className="text-sm text-muted-foreground">
                              No billed revenue has been recorded yet for today.
                            </p>
                          )}
                        </CardContent>
                      </Card>

                      <Card className="border-border/70">
                        <CardHeader className="pb-3">
                          <CardTitle className="text-base">Strongest anomaly days</CardTitle>
                          <CardDescription>Top flagged revenue deviations from the temporal layer.</CardDescription>
                        </CardHeader>
                        <CardContent>
                          {data.advanced_breakdown.extended_analytics.anomaly_days.length === 0 ? (
                            <div className="rounded-2xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                              No anomaly days crossed the current threshold.
                            </div>
                          ) : (
                            <div className="space-y-3">
                              {data.advanced_breakdown.extended_analytics.anomaly_days.map((day) => (
                                <div key={`${day.date}-${day.value}`} className="rounded-2xl bg-muted/40 px-4 py-3">
                                  <div className="flex items-center justify-between gap-3">
                                    <p className="font-medium text-foreground">{day.date}</p>
                                    <p className="text-sm font-semibold text-foreground">
                                      {currencyFormatter.format(day.value)}
                                    </p>
                                  </div>
                                  <p className="mt-1 text-sm text-muted-foreground">
                                    {formatPercent(day.deviation_percent)} vs expected range
                                  </p>
                                </div>
                              ))}
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    </div>
                  </div>
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        </section>
      </div>
    </AppLayout>
  );
};

export default OwnerDashboard;
