/**
 * Messages — Patient WhatsApp inbox (/messages).
 *
 * Three panes on desktop (conversation list · thread · patient context), a
 * single pane on mobile (list → thread with a back button). Wired to
 * /api/inbox. The 24-hour reply window is surfaced in the composer and enforced
 * again server-side (a free-text send past the window returns 409 and the UI
 * switches to the template sender).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  ArrowLeft,
  BadgeCheck,
  Building2,
  Check,
  CheckCheck,
  FileText,
  ImagePlus,
  Info,
  Mail,
  Phone,
  Receipt,
  Search,
  Send,
  Star,
  UserPlus,
  Users,
} from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { useApiQuery, useApiMutation, branchRequest, useBranchId } from '@/lib/query';
import { useAuthStore } from '@/store/authStore';
import { ApiError } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

// ── Types (mirror /api/inbox responses) ──────────────────────────────────────
interface ConversationSummary {
  id: string;
  phone: string;
  patientId: string | null;
  patientName: string | null;
  patientNumber: string | null;
  branchId: string | null;
  branchName: string | null;
  branchCode: string | null;
  assignedToId: string | null;
  status: string;
  unreadCount: number;
  lastPreview: string | null;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  windowOpen: boolean;
  windowExpiresAt: string | null;
}
interface ListResponse {
  conversations: ConversationSummary[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  counts: { all: number; unread: number; mine: number; unlinked: number };
}
interface ThreadMessage {
  id: string;
  direction: 'IN' | 'OUT';
  body: string;
  messageType: string;
  status: string; // sent | delivered | read | failed
  mediaUrl: string | null;
  isAutoReply: boolean;
  staffUserId: string | null;
  createdAt: string;
}
interface VisitCtx {
  id: string;
  billNumber: string;
  status: string;
  createdAt: string;
  branchCode: string | null;
  tests: string;
  netInPaise: number;
  dueInPaise: number;
  paymentStatus: string | null;
}
interface PatientContext {
  patient: {
    id: string;
    name: string;
    patientNumber: string;
    gender: string;
    age: number | null;
  } | null;
  latestVisit: VisitCtx | null;
  recentVisits: VisitCtx[];
  lastNotification: { type: string; at: string; tests: string } | null;
}
interface ThreadResponse {
  conversation: ConversationSummary;
  messages: ThreadMessage[];
  patientContext: PatientContext | null;
}

type FilterKey = 'all' | 'unread' | 'mine' | 'unlinked';

// ── Small helpers ─────────────────────────────────────────────────────────────
const AVATAR_COLORS = [
  '#7a4ea0', '#c0642a', '#2f7a4f', '#b0405f', '#3a6ea5', '#a56a06', '#5a5aa0', '#2a8a8a',
];
function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function initials(name: string | null): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}
function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
function windowLabel(c: Pick<ConversationSummary, 'windowOpen' | 'windowExpiresAt'>): string {
  if (!c.windowOpen || !c.windowExpiresAt) return 'Window closed';
  const left = new Date(c.windowExpiresAt).getTime() - Date.now();
  if (left <= 0) return 'Window closed';
  const h = Math.floor(left / 3600000);
  if (h >= 1) return `${h}h left`;
  const m = Math.max(1, Math.floor(left / 60000));
  return `${m}m left`;
}
function money(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN')}`;
}
function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
}

const QUICK_REPLIES = [
  'Your report is ready. You can view it using the link we sent you. Thank you.',
  'Thank you for reaching out. How can we help you today?',
  'Please visit your nearest Sobhana Diagnostics branch during working hours (8 AM to 8 PM).',
  'Your test is available. Please call 9490539006 to book, or visit any Sobhana branch.',
];
function formatPhone(p: string): string {
  const d = (p || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) return `+91 ${d.slice(2, 7)} ${d.slice(7)}`;
  if (d.length === 10) return `+91 ${d.slice(0, 5)} ${d.slice(5)}`;
  return d ? `+${d}` : '';
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
function dateTimeLabel(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
export default function MessagesInbox() {
  const navigate = useNavigate();
  const branchId = useBranchId();
  const meId = useAuthStore((s) => s.user?.id);

  const [filter, setFilter] = useState<FilterKey>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Debounce search.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // ── List query ──
  // Inbound replies arrive by push: the WhatsApp webhook emits an `inbox` catalog
  // change, which invalidates every ['inbox', ...] key here and the sidebar badge.
  // The interval is now only the backstop for a blocked/dropped SSE, so it went
  // 15s → 2min (this page's poll was the heaviest in the app).
  const listQ = useApiQuery<ListResponse>({
    queryKey: ['inbox', 'list', filter, search, branchId],
    queryFn: () =>
      branchRequest<ListResponse>(
        `/inbox/conversations?filter=${filter}&search=${encodeURIComponent(search)}`,
        branchId ?? '',
      ),
    branchScoped: true,
    refetchInterval: 120000,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });

  // ── Thread query (open thread) ──
  const threadQ = useApiQuery<ThreadResponse>({
    queryKey: ['inbox', 'thread', selectedId, branchId],
    queryFn: () =>
      branchRequest<ThreadResponse>(`/inbox/conversations/${selectedId}`, branchId ?? ''),
    branchScoped: true,
    enabled: !!selectedId,
    refetchInterval: selectedId ? 120000 : false,
    refetchIntervalInBackground: false,
  });

  // ── Mutations ──
  const readM = useApiMutation<unknown, string>({
    mutationFn: (id) =>
      branchRequest(`/inbox/conversations/${id}/read`, branchId ?? '', { method: 'POST' }),
    invalidate: [['inbox', 'list'], ['inbox', 'unread']],
  });
  const unreadM = useApiMutation<unknown, string>({
    mutationFn: (id) =>
      branchRequest(`/inbox/conversations/${id}/unread`, branchId ?? '', { method: 'POST' }),
    invalidate: [['inbox', 'list'], ['inbox', 'unread']],
  });
  const assignM = useApiMutation<{ assignedToId: string | null }, { id: string; assign: boolean }>({
    mutationFn: ({ id, assign }) =>
      branchRequest(`/inbox/conversations/${id}/assign`, branchId ?? '', {
        method: 'POST',
        body: JSON.stringify({ assign }),
      }),
    invalidate: [['inbox']],
  });
  const replyM = useApiMutation<{ ok: boolean }, { id: string; text: string }>({
    mutationFn: ({ id, text }) =>
      branchRequest(`/inbox/conversations/${id}/reply`, branchId ?? '', {
        method: 'POST',
        body: JSON.stringify({ text }),
      }),
    invalidate: [['inbox']],
  });
  const templateM = useApiMutation<
    { ok: boolean },
    { id: string; templateName: string; preview: string; languageCode: string; bodyParams: string[] }
  >({
    mutationFn: ({ id, templateName, preview, languageCode, bodyParams }) =>
      branchRequest(`/inbox/conversations/${id}/template`, branchId ?? '', {
        method: 'POST',
        body: JSON.stringify({ templateName, preview, languageCode, bodyParams }),
      }),
    invalidate: [['inbox']],
  });
  const sendReportM = useApiMutation<{ ok: boolean; billNumber: string }, string>({
    mutationFn: (id) =>
      branchRequest(`/inbox/conversations/${id}/send-report`, branchId ?? '', { method: 'POST' }),
    invalidate: [['inbox']],
  });
  const sendBillM = useApiMutation<{ ok: boolean; billNumber: string }, string>({
    mutationFn: (id) =>
      branchRequest(`/inbox/conversations/${id}/send-bill`, branchId ?? '', { method: 'POST' }),
    invalidate: [['inbox']],
  });

  // Mark read when a conversation is opened with unread messages.
  const lastReadRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId) return;
    const conv = listQ.data?.conversations.find((c) => c.id === selectedId);
    if (conv && conv.unreadCount > 0 && lastReadRef.current !== selectedId) {
      lastReadRef.current = selectedId;
      readM.mutate(selectedId);
    }
  }, [selectedId, listQ.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const conversations = listQ.data?.conversations ?? [];
  const counts = listQ.data?.counts ?? { all: 0, unread: 0, mine: 0, unlinked: 0 };
  const thread = threadQ.data;
  const selectedConv = thread?.conversation ?? conversations.find((c) => c.id === selectedId);

  return (
    <AppLayout context="owner">
      <div className="mb-4">
        <h1 className="text-2xl font-bold tracking-tight">Messages</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Patient replies to reports, bills &amp; reminders. Reply inside the 24-hour window, or send an approved template.
        </p>
      </div>

      <div className="flex overflow-hidden rounded-lg border bg-card h-[calc(100vh-210px)] min-h-[520px]">
        {/* ── LIST ── */}
        <div
          className={cn(
            'w-full flex-col border-r lg:flex lg:w-[340px] lg:flex-shrink-0',
            selectedId ? 'hidden lg:flex' : 'flex',
          )}
        >
          <div className="border-b p-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Name / Phone"
                className="w-full rounded-lg border bg-card py-2 pl-9 pr-3 text-sm outline-none focus:border-ring/40 focus:ring-2 focus:ring-ring/10"
              />
            </div>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {([
                ['all', 'All', counts.all],
                ['unread', 'Unread', counts.unread],
                ['mine', 'Mine', counts.mine],
                ['unlinked', 'Unlinked', counts.unlinked],
              ] as [FilterKey, string, number][]).map(([key, label, n]) => (
                <button
                  key={key}
                  onClick={() => setFilter(key)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                    filter === key
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'bg-card text-muted-foreground hover:bg-muted',
                  )}
                >
                  {label} <span className="opacity-70">{n}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {listQ.isLoading && (
              <div className="p-6 text-center text-sm text-muted-foreground">Loading…</div>
            )}
            {!listQ.isLoading && conversations.length === 0 && (
              <div className="flex flex-col items-center gap-2 p-10 text-center text-muted-foreground">
                <Users className="h-6 w-6" />
                <p className="text-sm">No conversations</p>
              </div>
            )}
            {conversations.map((c) => (
              <ConversationRow
                key={c.id}
                c={c}
                selected={c.id === selectedId}
                mine={c.assignedToId === meId}
                onClick={() => setSelectedId(c.id)}
              />
            ))}
          </div>
        </div>

        {/* ── THREAD ── */}
        <div className={cn('min-w-0 flex-1 flex-col', selectedId ? 'flex' : 'hidden lg:flex')}>
          {!selectedConv ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <Send className="h-7 w-7" />
              <p className="text-sm">Select a conversation to reply</p>
            </div>
          ) : (
            <ThreadPane
              conv={selectedConv}
              thread={thread}
              loading={threadQ.isLoading}
              mine={selectedConv.assignedToId === meId}
              onBack={() => setSelectedId(null)}
              onMarkUnread={() => {
                lastReadRef.current = null; // let auto-read fire again on reopen
                unreadM.mutate(selectedConv.id, {
                  onSuccess: () => {
                    toast.success('Marked unread');
                    setSelectedId(null);
                  },
                  onError: (err) => toast.error(err.message || 'Failed to mark unread'),
                });
              }}
              onAssign={(assign) => assignM.mutate({ id: selectedConv.id, assign })}
              onOpen360={(pid) => navigate(`/clinic/patient-360/${pid}`)}
              onReply={(text) =>
                replyM.mutate(
                  { id: selectedConv.id, text },
                  {
                    onError: (err) => {
                      if (err instanceof ApiError && err.status === 409) {
                        toast.error('The 24-hour window has closed. Send an approved template instead.');
                      } else {
                        toast.error(err.message || 'Failed to send');
                      }
                    },
                  },
                )
              }
              onTemplate={(templateName, preview, languageCode, bodyParams) =>
                templateM.mutate(
                  { id: selectedConv.id, templateName, preview, languageCode, bodyParams },
                  {
                    onSuccess: () => toast.success('Template sent'),
                    onError: (err) => toast.error(err.message || 'Template send failed'),
                  },
                )
              }
              onSendReport={() =>
                sendReportM.mutate(selectedConv.id, {
                  onSuccess: (d) => toast.success(`Report sent (Bill ${d.billNumber})`),
                  onError: (err) => toast.error(err.message || 'Failed to send report'),
                })
              }
              onSendBill={() =>
                sendBillM.mutate(selectedConv.id, {
                  onSuccess: (d) => toast.success(`Bill sent (Bill ${d.billNumber})`),
                  onError: (err) => toast.error(err.message || 'Failed to send bill'),
                })
              }
              sending={replyM.isPending || templateM.isPending}
            />
          )}
        </div>

        {/* ── PATIENT CONTEXT (desktop wide only) ── */}
        {selectedConv && (
          <div className="hidden w-[320px] flex-shrink-0 flex-col border-l bg-muted/20 xl:flex">
            <PatientRail ctx={thread?.patientContext ?? null} conv={selectedConv} onOpen360={(pid) => navigate(`/clinic/patient-360/${pid}`)} />
          </div>
        )}
      </div>
    </AppLayout>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
function ConversationRow({
  c,
  selected,
  mine,
  onClick,
}: {
  c: ConversationSummary;
  selected: boolean;
  mine: boolean;
  onClick: () => void;
}) {
  const linked = !!c.patientName;
  return (
    <button
      onClick={onClick}
      className={cn(
        'relative flex w-full gap-3 border-b p-3 text-left transition-colors hover:bg-muted',
        selected && 'bg-accent',
      )}
    >
      {selected && <span className="absolute inset-y-0 left-0 w-[3px] bg-primary" />}
      <div
        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
        style={{ backgroundColor: linked ? avatarColor(c.patientName!) : '#8a8a8a' }}
      >
        {linked ? initials(c.patientName) : '?'}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn('flex-1 truncate text-sm font-semibold', !linked && 'font-medium italic text-muted-foreground')}>
            {linked ? c.patientName : c.phone}
          </span>
          <span className="flex-shrink-0 text-[11px] text-muted-foreground">{relativeTime(c.lastMessageAt)}</span>
        </div>
        <div className="mt-0.5 truncate text-[12.5px] text-muted-foreground">{c.lastPreview ?? ''}</div>
        <div className="mt-1.5 flex items-center gap-1.5">
          {linked ? (
            <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
              {c.branchCode ?? c.branchName ?? '—'}
            </span>
          ) : (
            <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold text-destructive">
              No patient match
            </span>
          )}
          <span
            className={cn(
              'inline-flex items-center gap-1 text-[10px] font-semibold',
              c.windowOpen ? 'text-success' : 'text-destructive',
            )}
          >
            <span className={cn('h-[7px] w-[7px] rounded-full', c.windowOpen ? 'bg-success' : 'bg-destructive')} />
            {windowLabel(c)}
          </span>
          {mine && !c.unreadCount && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-success/10 px-1.5 py-0.5 text-[10px] font-semibold text-success">
              <BadgeCheck className="h-3 w-3" /> You
            </span>
          )}
          {c.unreadCount > 0 && (
            <span className="ml-auto flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-success px-1.5 text-[11px] font-bold text-white">
              {c.unreadCount}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
function ThreadPane({
  conv,
  thread,
  loading,
  mine,
  onBack,
  onMarkUnread,
  onAssign,
  onOpen360,
  onReply,
  onTemplate,
  onSendReport,
  onSendBill,
  sending,
}: {
  conv: ConversationSummary;
  thread: ThreadResponse | undefined;
  loading: boolean;
  mine: boolean;
  onBack: () => void;
  onMarkUnread: () => void;
  onAssign: (assign: boolean) => void;
  onOpen360: (patientId: string) => void;
  onReply: (text: string) => void;
  onTemplate: (templateName: string, preview: string, languageCode: string, bodyParams: string[]) => void;
  onSendReport: () => void;
  onSendBill: () => void;
  sending: boolean;
}) {
  const [text, setText] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const messages = thread?.messages ?? [];
  const lastNotif = thread?.patientContext?.lastNotification ?? null;

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages.length, conv.id]);

  useEffect(() => {
    setText('');
  }, [conv.id]);

  const linked = !!conv.patientName;
  const send = () => {
    const t = text.trim();
    if (!t) return;
    onReply(t);
    setText('');
  };

  return (
    <>
      {/* header */}
      <div className="flex items-center gap-3 border-b p-3">
        <button onClick={onBack} className="rounded-md p-1 text-muted-foreground hover:bg-muted lg:hidden">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
          style={{ backgroundColor: linked ? avatarColor(conv.patientName!) : '#8a8a8a' }}
        >
          {linked ? initials(conv.patientName) : '?'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold">{linked ? conv.patientName : conv.phone}</div>
          <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <span className="truncate">
              {conv.phone}
              {conv.branchCode ? ` · ${conv.branchCode}` : ''}
            </span>
            <span
              className={cn(
                'inline-flex flex-shrink-0 items-center gap-1 font-semibold',
                conv.windowOpen ? 'text-success' : 'text-destructive',
              )}
            >
              <span className={cn('h-[7px] w-[7px] rounded-full', conv.windowOpen ? 'bg-success' : 'bg-destructive')} />
              {conv.windowOpen ? `Free replies open · ${windowLabel(conv)}` : 'Window closed'}
            </span>
          </div>
        </div>
        <button
          onClick={onMarkUnread}
          title="Mark as unread"
          className="inline-flex flex-shrink-0 items-center justify-center rounded-lg border p-2 text-muted-foreground hover:bg-muted"
        >
          <Mail className="h-4 w-4" />
        </button>
        <button
          onClick={() => onAssign(!mine)}
          className={cn(
            'inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12.5px] font-medium hover:bg-muted',
            mine && 'border-success/40 bg-success/10 text-success',
          )}
        >
          {mine ? <Check className="h-3.5 w-3.5" /> : <UserPlus className="h-3.5 w-3.5" />}
          {mine ? 'Assigned to you' : 'Assign to me'}
        </button>
        {conv.patientId && (
          <button
            onClick={() => onOpen360(conv.patientId!)}
            className="hidden flex-shrink-0 items-center gap-1.5 rounded-lg border border-primary bg-primary px-2.5 py-1.5 text-[12.5px] font-medium text-primary-foreground hover:opacity-90 sm:inline-flex"
          >
            <Info className="h-3.5 w-3.5" /> Open Patient 360
          </button>
        )}
      </div>

      {/* body */}
      <div ref={bodyRef} className="flex flex-1 flex-col gap-2.5 overflow-y-auto bg-muted/30 p-4">
        {loading && <div className="text-center text-sm text-muted-foreground">Loading…</div>}
        {(() => {
          // Merge the last report/bill notice into the stream at its real send time,
          // so it sits chronologically among the messages instead of pinned on top.
          const items: { at: string; node: JSX.Element }[] = messages.map((m) => ({
            at: m.createdAt,
            node: <MessageBubble key={m.id} m={m} />,
          }));
          if (lastNotif) {
            items.push({ at: lastNotif.at, node: <NotifPill key={`notif-${lastNotif.at}`} notif={lastNotif} /> });
          }
          items.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
          const out: JSX.Element[] = [];
          let prevDay = '';
          items.forEach((it, i) => {
            const d = dayLabel(it.at);
            if (d !== prevDay) {
              out.push(
                <div key={`day-${i}`} className="my-1 self-center text-[11px] font-semibold text-muted-foreground">
                  {d}
                </div>,
              );
              prevDay = d;
            }
            out.push(it.node);
          });
          return out;
        })()}
      </div>

      {/* composer */}
      <Composer
        conv={conv}
        text={text}
        setText={setText}
        onSend={send}
        onTemplate={onTemplate}
        onSendReport={onSendReport}
        onSendBill={onSendBill}
        sending={sending}
      />
    </>
  );
}

function MessageBubble({ m }: { m: ThreadMessage }) {
  const out = m.direction === 'OUT';
  return (
    <div
      className={cn(
        'max-w-[74%] rounded-xl px-3 py-2 text-[13.5px] shadow-sm',
        out
          ? 'self-end rounded-tr-sm bg-[#e7f3e8] dark:bg-success/20'
          : 'self-start rounded-tl-sm bg-card border',
      )}
    >
      <div className="whitespace-pre-wrap break-words">{m.body}</div>
      <div className="mt-1 flex items-center justify-end gap-1 text-[10.5px] text-muted-foreground">
        {m.isAutoReply && <span className="italic">auto</span>}
        {clockTime(m.createdAt)}
        {out && m.messageType !== 'system' && <Ticks status={m.status} />}
      </div>
    </div>
  );
}

/** Centered "Report sent / Bill sent" chip, placed inline in the thread by time. */
function NotifPill({ notif }: { notif: { type: string; at: string; tests: string } }) {
  return (
    <div className="inline-flex items-center gap-1.5 self-center rounded-full bg-black/[0.06] px-3 py-1 text-[11.5px] text-muted-foreground dark:bg-white/10">
      <FileText className="h-3 w-3" />
      {notif.type === 'REPORT' ? 'Report sent' : 'Bill sent'}
      {notif.tests ? ` · ${notif.tests}` : ''} · {dateTimeLabel(notif.at)}
    </div>
  );
}

/** WhatsApp-style delivery ticks: sent (grey ✓) → delivered (grey ✓✓) → read (blue ✓✓); failed = red !. */
function Ticks({ status }: { status: string }) {
  if (status === 'failed') return <AlertCircle className="h-3 w-3 text-destructive" />;
  if (status === 'read') return <CheckCheck className="h-3 w-3 text-[#4a9be0]" />;
  if (status === 'delivered') return <CheckCheck className="h-3 w-3" />;
  return <Check className="h-3 w-3" />; // sent
}

interface TemplateSummary {
  name: string;
  language: string;
  category: string;
  status: string;
  bodyText: string;
  paramCount: number;
  hasHeaderMedia: boolean;
}
function renderTemplatePreview(bodyText: string, params: string[]): string {
  return bodyText.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n) => params[Number(n) - 1]?.trim() || `{{${n}}}`);
}

function Composer({
  conv,
  text,
  setText,
  onSend,
  onTemplate,
  onSendReport,
  onSendBill,
  sending,
}: {
  conv: ConversationSummary;
  text: string;
  setText: (t: string) => void;
  onSend: () => void;
  onTemplate: (templateName: string, preview: string, languageCode: string, bodyParams: string[]) => void;
  onSendReport: () => void;
  onSendBill: () => void;
  sending: boolean;
}) {
  const branchId = useBranchId();
  const [showQuick, setShowQuick] = useState(false);
  const [selectedName, setSelectedName] = useState('');
  const [params, setParams] = useState<string[]>([]);
  const [manualName, setManualName] = useState('');

  // Approved templates, fetched only when the window is closed.
  const templatesQ = useApiQuery<{ templates: TemplateSummary[]; enabled: boolean; error?: string }>({
    queryKey: ['inbox', 'templates'],
    queryFn: () => branchRequest('/inbox/templates', branchId ?? ''),
    enabled: !conv.windowOpen,
    staleTime: 5 * 60 * 1000,
  });
  const templates = templatesQ.data?.templates ?? [];

  const role = useAuthStore((s) => s.user?.role);
  const isOwner = role === 'owner';

  // Default out-of-window template (owner-chosen). Staff are locked to it.
  const defaultQ = useApiQuery<{ default: { templateName: string; language: string } | null }>({
    queryKey: ['inbox', 'default-template'],
    queryFn: () => branchRequest('/inbox/default-template', branchId ?? ''),
    enabled: !conv.windowOpen,
    staleTime: 5 * 60 * 1000,
  });
  const defaultName = defaultQ.data?.default?.templateName ?? null;
  const setDefaultM = useApiMutation<unknown, { templateName: string; language: string }>({
    mutationFn: (v) =>
      branchRequest('/inbox/default-template', branchId ?? '', {
        method: 'POST',
        body: JSON.stringify(v),
      }),
    invalidate: [['inbox', 'default-template']],
  });

  // Owners pick freely; everyone else is locked to the owner-set default.
  const effectiveName = isOwner ? selectedName : defaultName ?? '';
  const selected = templates.find((t) => t.name === effectiveName) ?? null;

  useEffect(() => {
    setSelectedName('');
    setParams([]);
    setManualName('');
  }, [conv.id]);

  // Owner: pre-select the saved default once templates load.
  useEffect(() => {
    if (isOwner && !selectedName && defaultName && templates.some((t) => t.name === defaultName)) {
      setSelectedName(defaultName);
    }
  }, [isOwner, defaultName, templates, selectedName]);

  if (!conv.windowOpen) {
    const needParams = selected?.paramCount ?? 0;
    const missing = !selected || selected.hasHeaderMedia || Array.from({ length: needParams }).some((_, i) => !params[i]?.trim());
    const hasTemplates = templates.length > 0;
    const noDefaultForStaff = !isOwner && !defaultName;

    return (
      <div className="border-t bg-card p-3.5">
        <div className="mb-3 flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-[12px] font-medium text-destructive">
          <Info className="h-4 w-4 flex-shrink-0" />
          The 24-hour free-reply window has closed. Send an approved template, or wait for the patient to message again.
        </div>

        {templatesQ.isLoading && <div className="text-sm text-muted-foreground">Loading templates…</div>}

        {!templatesQ.isLoading && noDefaultForStaff && (
          <div className="rounded-lg bg-muted p-3 text-[12.5px] text-muted-foreground">
            No default template is set. Ask an owner to choose one before sending out-of-window replies.
          </div>
        )}

        {!templatesQ.isLoading && hasTemplates && !noDefaultForStaff && (
          <div className="space-y-2.5">
            {isOwner ? (
              <select
                value={selectedName}
                onChange={(e) => {
                  setSelectedName(e.target.value);
                  setParams([]);
                }}
                className="w-full rounded-lg border bg-card px-3 py-2.5 text-sm outline-none focus:border-ring/40"
              >
                <option value="">Choose an approved template…</option>
                {templates.map((t) => (
                  <option key={`${t.name}:${t.language}`} value={t.name}>
                    {t.name} · {t.category.toLowerCase()} ({t.language})
                    {t.name === defaultName ? '  ★ default' : ''}
                  </option>
                ))}
              </select>
            ) : (
              <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-sm">
                <BadgeCheck className="h-4 w-4 flex-shrink-0 text-success" />
                <span className="font-medium">{defaultName}</span>
                <span className="text-muted-foreground">· default template (set by owner)</span>
              </div>
            )}

            {selected && (
              <>
                {selected.hasHeaderMedia && (
                  <div className="rounded-lg bg-warning/10 px-3 py-2 text-[12px] font-medium text-warning">
                    This template needs a media header — not supported here yet. Pick a text-only template.
                  </div>
                )}
                {Array.from({ length: needParams }).map((_, i) => (
                  <input
                    key={i}
                    value={params[i] ?? ''}
                    onChange={(e) => {
                      const next = [...params];
                      next[i] = e.target.value;
                      setParams(next);
                    }}
                    placeholder={`Value for {{${i + 1}}}`}
                    className="w-full rounded-lg border bg-card px-3 py-2 text-sm outline-none focus:border-ring/40"
                  />
                ))}
                <div className="rounded-lg border bg-muted/40 p-3 text-[13px]">
                  <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Preview</div>
                  <div className="whitespace-pre-wrap">{renderTemplatePreview(selected.bodyText, params)}</div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    disabled={missing || sending}
                    onClick={() =>
                      onTemplate(
                        selected.name,
                        renderTemplatePreview(selected.bodyText, params),
                        selected.language,
                        params.slice(0, needParams),
                      )
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
                  >
                    <Send className="h-4 w-4" /> Send template
                  </button>
                  {isOwner && selected.name === defaultName && (
                    <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-success">
                      <Star className="h-3.5 w-3.5 fill-current" /> Default
                    </span>
                  )}
                  {isOwner && selected.name !== defaultName && (
                    <button
                      onClick={() =>
                        setDefaultM.mutate(
                          { templateName: selected.name, language: selected.language },
                          {
                            onSuccess: () => toast.success('Default template set'),
                            onError: (e) => toast.error(e.message || 'Failed to set default'),
                          },
                        )
                      }
                      className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2.5 text-sm font-medium hover:bg-muted"
                    >
                      <Star className="h-4 w-4" /> Set as default
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {!templatesQ.isLoading && !hasTemplates && isOwner && (
          <>
            <div className="flex items-end gap-2">
              <input
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                placeholder="Approved template name (e.g. lab_report_ready)"
                className="flex-1 rounded-lg border bg-card px-3 py-2.5 text-sm outline-none focus:border-ring/40"
              />
              <button
                disabled={!manualName.trim() || sending}
                onClick={() => onTemplate(manualName.trim(), `[Template: ${manualName.trim()}]`, 'en', [])}
                className="inline-flex h-11 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                <Send className="h-4 w-4" /> Send
              </button>
            </div>
            {templatesQ.data?.error && (
              <div className="mt-2 text-[11.5px] text-muted-foreground">{templatesQ.data.error}</div>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="border-t bg-card p-3">
      <div className="mb-2.5 flex items-center gap-2 rounded-lg bg-success/10 px-3 py-1.5 text-[12px] font-medium text-success">
        <Check className="h-3.5 w-3.5 flex-shrink-0" />
        Free-text replies open · {windowLabel(conv)}
      </div>

      <div className="mb-2.5 flex flex-wrap gap-1.5">
        <QuickBtn icon={FileText} label="Send report link" onClick={onSendReport} />
        <QuickBtn icon={Receipt} label="Send bill" onClick={onSendBill} />
        <a
          href={`tel:+${conv.phone}`}
          className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] font-medium text-foreground hover:bg-muted"
        >
          <Phone className="h-3.5 w-3.5" /> {formatPhone(conv.phone)}
        </a>
        <button
          onClick={() => setShowQuick((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] font-medium hover:bg-muted"
        >
          Canned replies
        </button>
        <QuickBtn
          icon={ImagePlus}
          label="Request image"
          onClick={() =>
            setText('Please share a clear photo here (prescription / previous report / receipt) and our team will assist you. 📷')
          }
        />
      </div>
      {showQuick && (
        <div className="mb-2.5 space-y-1 rounded-lg border bg-muted/40 p-2">
          {QUICK_REPLIES.map((q, i) => (
            <button
              key={i}
              onClick={() => {
                setText(q);
                setShowQuick(false);
              }}
              className="block w-full truncate rounded px-2 py-1.5 text-left text-[12.5px] hover:bg-card"
            >
              {q}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2.5">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder="Type a reply…  (Enter to send, Shift+Enter for a new line)"
          rows={1}
          className="max-h-32 min-h-[44px] flex-1 resize-none rounded-xl border bg-card px-3.5 py-3 text-[13.5px] outline-none focus:border-ring/40"
        />
        <button
          disabled={!text.trim() || sending}
          onClick={onSend}
          className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground disabled:opacity-50"
          style={{ backgroundColor: 'var(--branch-sidebar-bg)' }}
        >
          <Send className="h-[18px] w-[18px]" />
        </button>
      </div>
    </div>
  );
}

function QuickBtn({ icon: Icon, label, onClick }: { icon: any; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] font-medium hover:bg-muted"
    >
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
function PatientRail({
  ctx,
  conv,
  onOpen360,
}: {
  ctx: PatientContext | null;
  conv: ConversationSummary;
  onOpen360: (patientId: string) => void;
}) {
  if (!conv.patientId || !ctx?.patient) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
        <Building2 className="h-6 w-6" />
        <p className="text-sm">No patient matched to this number.</p>
        <p className="text-xs">Register or link the patient to see their history here.</p>
      </div>
    );
  }
  const p = ctx.patient;
  const lv = ctx.latestVisit;
  const reportReady = lv?.status === 'COMPLETED';

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <Card title="Patient">
        <div className="text-base font-bold">{p.name}</div>
        <div className="mt-0.5 text-[12.5px] text-muted-foreground">
          {p.gender}
          {p.age != null ? ` · ${p.age}y` : ''} · {p.patientNumber}
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {reportReady && <Pill tone="green">Report ready</Pill>}
          {lv && lv.dueInPaise > 0 && <Pill tone="amber">Due {money(lv.dueInPaise)}</Pill>}
          {lv && lv.dueInPaise === 0 && <Pill tone="green">Paid</Pill>}
        </div>
      </Card>

      {lv && (
        <Card title="Latest visit">
          <Kv k="Bill no." v={lv.billNumber} />
          <Kv k="Date" v={new Date(lv.createdAt).toLocaleDateString('en-IN')} />
          {lv.tests && <Kv k="Tests" v={lv.tests} />}
          <Kv
            k="Report"
            v={lv.status === 'COMPLETED' ? 'Finalized' : lv.status}
            tone={lv.status === 'COMPLETED' ? 'green' : undefined}
          />
          <Kv k="Amount" v={money(lv.netInPaise)} />
          <Kv k="Due" v={money(lv.dueInPaise)} tone={lv.dueInPaise > 0 ? 'amber' : undefined} />
        </Card>
      )}

      {ctx.recentVisits.length > 1 && (
        <Card title="Recent visits">
          {ctx.recentVisits.slice(1).map((v) => (
            <div key={v.id} className="flex items-center justify-between gap-2 border-b py-2 text-[12.5px] last:border-b-0">
              <div className="min-w-0">
                <div className="truncate font-medium">{v.tests || v.billNumber}</div>
                <div className="text-[11.5px] text-muted-foreground">
                  {new Date(v.createdAt).toLocaleDateString('en-IN')}
                </div>
              </div>
              <Pill tone={v.status === 'COMPLETED' ? 'green' : 'amber'}>
                {v.status === 'COMPLETED' ? 'Sent' : v.status}
              </Pill>
            </div>
          ))}
        </Card>
      )}

      <div className="flex flex-col gap-2">
        <button
          onClick={() => onOpen360(p.id)}
          className="rounded-lg border border-primary bg-primary py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Open full Patient 360
        </button>
        {lv && lv.dueInPaise > 0 && (
          <button
            onClick={() => onOpen360(p.id)}
            className="rounded-lg border py-2.5 text-sm font-medium hover:bg-muted"
          >
            Collect due {money(lv.dueInPaise)}
          </button>
        )}
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 rounded-lg border bg-card p-3.5">
      <div className="mb-2.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}
function Kv({ k, v, tone }: { k: string; v: string; tone?: 'amber' | 'green' }) {
  return (
    <div className="flex justify-between gap-3 border-b border-dashed py-1.5 text-[12.5px] last:border-b-0">
      <span className="flex-shrink-0 text-muted-foreground">{k}</span>
      <span
        className={cn(
          'text-right font-semibold',
          tone === 'amber' && 'text-warning',
          tone === 'green' && 'text-success',
        )}
      >
        {v}
      </span>
    </div>
  );
}
function Pill({ tone, children }: { tone: 'green' | 'amber' | 'red'; children: React.ReactNode }) {
  const map = {
    green: 'bg-success/10 text-success',
    amber: 'bg-warning/10 text-warning',
    red: 'bg-destructive/10 text-destructive',
  };
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold', map[tone])}>
      {children}
    </span>
  );
}
