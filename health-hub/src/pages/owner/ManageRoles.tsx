import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiQuery, apiCall } from '@/lib/query';
import { toast } from 'sonner';
import {
  ShieldCheck, Lock, Crown, FlaskConical, Users, Megaphone, GripVertical,
  UserMinus, UserX, UserPlus, Copy, Check, MessageCircle, TriangleAlert, Send, Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ROLE_LABELS, UserRole } from '@/store/authStore';

/* ───────── Types ───────── */

interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  /** 10-digit mobile. Automated messages send here — see Config > Automated messages. */
  phone?: string | null;
  isActive: boolean;
  /** Set = invited on WhatsApp, hasn't replied yet, so they have no password. */
  portalInviteAt?: string | null;
  activeBranch?: { id: string; name: string } | null;
}

/** Roles an owner can assign here, in display order. `owner` is assignable now;
 *  the server refuses any change that would remove the last active owner. */
const ASSIGNABLE_ROLES: UserRole[] = ['owner', 'lab_incharge', 'staff', 'sales'];

/** Every lane shown on the board (owner first, then the assignable roles). */
const LANES: {
  role: UserRole;
  icon: typeof ShieldCheck;
  blurb: string;
  accent: string;
}[] = [
  { role: 'owner', icon: Crown, blurb: 'Full access, including finalizing reports.', accent: 'text-amber-600' },
  { role: 'lab_incharge', icon: FlaskConical, blurb: 'Full lab workflow, and the only non-owner who can finalize.', accent: 'text-emerald-600' },
  { role: 'staff', icon: Users, blurb: 'Operations and billing. Cannot finalize reports.', accent: 'text-sky-600' },
  { role: 'sales', icon: Megaphone, blurb: 'Referrals and payouts only. No WhatsApp.', accent: 'text-violet-600' },
];

/* ───────── Component ───────── */

export default function ManageRoles() {
  const qc = useQueryClient();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overRole, setOverRole] = useState<UserRole | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<TeamMember | null>(null);
  const [removeTarget, setRemoveTarget] = useState<TeamMember | null>(null);
  // A resend to somebody who already has a password ROTATES it, so that one asks
  // first. An unanswered invite has nothing to lose and goes straight out.
  const [resetTarget, setResetTarget] = useState<TeamMember | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState<{ name: string; phone: string; role: UserRole }>({
    name: '', phone: '', role: 'staff',
  });
  // Shown after creation. There is no password to show: it is generated only when
  // the invitee replies on WhatsApp, which is the one moment credentials may be
  // sent (a template cannot carry them). So this reports the invite, not a secret.
  const [issued, setIssued] = useState<
    { name: string; email: string; delivered: boolean; error?: string } | null
  >(null);
  const [copied, setCopied] = useState(false);

  // Consulting doctors are Users too, but they belong to Consulting Doctors, not
  // here — there is no lane for them, so an active one was invisible while a
  // deactivated one still turned up in the Deactivated strip below, offering a
  // Reactivate that would quietly hand back a doctor-portal login from a screen
  // that never showed the account in the first place. Out of both, or in both.
  const { data: members = [], isLoading } = useApiQuery<TeamMember[]>({
    queryKey: ['users'],
    queryFn: () =>
      apiCall<{ data: TeamMember[] }>('/users').then((r) => r.data.filter((m) => m.role !== 'doctor')),
  });

  // Optimistic role change — the card jumps to its new lane immediately and
  // rolls back if the request fails.
  // Phone is what automated messages send to. The column always existed but
  // nothing ever wrote it, so every member had none.
  const phoneMutation = useMutation<TeamMember, Error, { id: string; phone: string | null; name: string }>({
    mutationFn: ({ id, phone }) =>
      apiCall<{ data: TeamMember }>(`/users/${id}/phone`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      }).then((r) => r.data),
    onError: (err, vars) => toast.error(err.message || `Couldn't save ${vars.name}'s number`),
    onSuccess: (u) => toast.success(u.phone ? `${u.name}: +91 ${u.phone}` : `${u.name}'s number cleared`),
    onSettled: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  const roleMutation = useMutation<
    TeamMember,
    Error,
    { id: string; role: UserRole; name: string },
    { prev?: TeamMember[] }
  >({
    mutationFn: ({ id, role }) =>
      apiCall<{ data: TeamMember }>(`/users/${id}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      }).then((r) => r.data),
    onMutate: async ({ id, role }) => {
      await qc.cancelQueries({ queryKey: ['users'] });
      const prev = qc.getQueryData<TeamMember[]>(['users']);
      qc.setQueryData<TeamMember[]>(['users'], (old) =>
        old?.map((m) => (m.id === id ? { ...m, role } : m)),
      );
      return { prev };
    },
    onError: (err, vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(['users'], ctx.prev);
      toast.error(err.message || `Couldn't move ${vars.name}`);
    },
    onSuccess: (updated) =>
      toast.success(`${updated.name} is now ${ROLE_LABELS[updated.role]}`),
    onSettled: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  const changeRole = (m: TeamMember, role: UserRole) => {
    // Owner is no longer refused here. The one rule that matters — never remove
    // the final owner — is enforced on the server, where it can count them;
    // doing it in the browser would be advisory only.
    if (role === m.role) return;
    roleMutation.mutate({ id: m.id, role, name: m.name });
  };

  type InviteResult = { invite: { success: boolean; error?: string } };

  // Add a member. Only a name and a mobile: the login and the password are both
  // generated, so there is nothing here for an operator to get wrong.
  const addMutation = useMutation<
    { data: TeamMember } & InviteResult,
    Error,
    { name: string; phone: string; role: UserRole }
  >({
    mutationFn: (body) =>
      apiCall<{ data: TeamMember } & InviteResult>('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (r) => {
      setAddOpen(false);
      setForm({ name: '', phone: '', role: 'staff' });
      setCopied(false);
      setIssued({
        name: r.data.name,
        email: r.data.email,
        delivered: !!r.invite?.success,
        error: r.invite?.error,
      });
      qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e) => toast.error(e.message || 'Could not add them'),
  });

  // Send (or resend) the WhatsApp invite. Doubles as the forgotten-password
  // path: replying mints a fresh password, so there is no separate reset to keep
  // in step. Their current one keeps working until they actually reply.
  const inviteMutation = useMutation<InviteResult, Error, TeamMember>({
    mutationFn: (m) => apiCall<InviteResult>(`/users/${m.id}/invite`, { method: 'POST' }),
    onSuccess: (r, m) =>
      r.invite?.success
        ? toast.success(`Invite sent to ${m.name} — they get their password when they reply`)
        : toast.error(r.invite?.error || `Could not send an invite to ${m.name}`),
    onError: (e) => toast.error(e.message || 'Could not send the invite'),
    onSettled: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  // Deliberately NOT optimistic, unlike the activate toggle. The server refuses
  // to remove anybody who has been given their sign-in details, so a refusal is
  // an ordinary outcome here — the row must not vanish and reappear. Its message
  // is what the toast shows.
  const removeMutation = useMutation<{ id: string }, Error, TeamMember>({
    mutationFn: (m) =>
      apiCall<{ data: { id: string } }>(`/users/${m.id}`, { method: 'DELETE' }).then((r) => r.data),
    onError: (err, m) => toast.error(err.message || `Couldn't remove ${m.name}`),
    onSuccess: (_d, m) => toast.success(`${m.name} removed — ${m.email} is free again`),
    onSettled: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  // Deactivate / reactivate a member. Deactivating blocks login and revokes
  // any live session; the account (and its history) is kept and can be
  // reactivated. Optimistic — the card leaves its lane immediately.
  const activeMutation = useMutation<
    TeamMember,
    Error,
    { id: string; isActive: boolean; name: string },
    { prev?: TeamMember[] }
  >({
    mutationFn: ({ id, isActive }) =>
      apiCall<{ data: TeamMember }>(`/users/${id}/active`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive }),
      }).then((r) => r.data),
    onMutate: async ({ id, isActive }) => {
      await qc.cancelQueries({ queryKey: ['users'] });
      const prev = qc.getQueryData<TeamMember[]>(['users']);
      qc.setQueryData<TeamMember[]>(['users'], (old) =>
        old?.map((m) => (m.id === id ? { ...m, isActive } : m)),
      );
      return { prev };
    },
    onError: (err, vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(['users'], ctx.prev);
      toast.error(err.message || `Couldn't update ${vars.name}`);
    },
    onSuccess: (updated, vars) =>
      toast.success(vars.isActive ? `${updated.name} reactivated` : `${updated.name} deactivated`),
    onSettled: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  const handleDrop = (role: UserRole) => {
    setOverRole(null);
    const m = members.find((x) => x.id === dragId);
    setDragId(null);
    if (m) changeRole(m, role);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-primary/10 p-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Roles</h2>
            <p className="text-muted-foreground text-sm">
              Drag a member into a role, or use the selector on their card. There must
              always be at least one owner.
            </p>
          </div>
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <UserPlus className="mr-2 h-4 w-4" /> Add member
        </Button>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground py-8 text-center text-sm">Loading team…</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {LANES.map((lane) => {
            const Icon = lane.icon;
            const laneMembers = members.filter((m) => m.role === lane.role && m.isActive);
            const isOwnerLane = lane.role === 'owner';
            const isDropTarget = overRole === lane.role;
            const canDropHere = !isOwnerLane;

            return (
              <div
                key={lane.role}
                onDragOver={(e) => {
                  if (canDropHere && dragId) {
                    e.preventDefault();
                    setOverRole(lane.role);
                  }
                }}
                onDragLeave={(e) => {
                  // Only clear when the pointer actually leaves the lane.
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                    setOverRole((r) => (r === lane.role ? null : r));
                  }
                }}
                onDrop={() => canDropHere && handleDrop(lane.role)}
                className={cn(
                  'flex flex-col rounded-xl border bg-muted/20 transition-colors',
                  isDropTarget && 'border-primary bg-primary/5 ring-2 ring-primary/20',
                  isOwnerLane && dragId && 'opacity-60',
                )}
              >
                {/* Lane header */}
                <div className="border-b px-3 py-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Icon className={cn('h-4 w-4', lane.accent)} />
                      <span className="text-sm font-semibold">{ROLE_LABELS[lane.role]}</span>
                      {isOwnerLane && <Lock className="h-3 w-3 text-muted-foreground" />}
                    </div>
                    <span className="text-muted-foreground rounded-full bg-background px-2 py-0.5 text-xs font-medium">
                      {laneMembers.length}
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                    {lane.blurb}
                  </p>
                </div>

                {/* Members */}
                <div className="flex flex-1 flex-col gap-2 p-2">
                  {laneMembers.length === 0 ? (
                    <div className="text-muted-foreground/70 flex flex-1 items-center justify-center rounded-lg border border-dashed py-6 text-center text-xs">
                      {isOwnerLane ? 'No owners' : 'Drop a member here'}
                    </div>
                  ) : (
                    laneMembers.map((m) => {
                      const locked = m.role === 'owner';
                      const dragging = dragId === m.id;
                      return (
                        <div
                          key={m.id}
                          draggable={!locked}
                          onDragStart={(e) => {
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('text/plain', m.id);
                            setDragId(m.id);
                          }}
                          onDragEnd={() => {
                            setDragId(null);
                            setOverRole(null);
                          }}
                          className={cn(
                            'rounded-lg border bg-background p-2.5 shadow-sm transition',
                            locked ? 'cursor-default' : 'cursor-grab active:cursor-grabbing hover:border-primary/40',
                            dragging && 'opacity-40',
                          )}
                        >
                          <div className="flex items-start gap-2">
                            {locked ? (
                              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            ) : (
                              <GripVertical className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                            )}
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium">{m.name}</p>
                              <p className="text-muted-foreground truncate text-xs">{m.email}</p>
                              <input
                                type="tel"
                                inputMode="numeric"
                                defaultValue={m.phone ?? ''}
                                placeholder="Add mobile"
                                aria-label={`${m.name} mobile number`}
                                className="text-muted-foreground w-full border-0 bg-transparent p-0 text-xs outline-none placeholder:italic focus:text-foreground"
                                onBlur={(e) => {
                                  const next = e.target.value.trim();
                                  if (next === (m.phone ?? '')) return;
                                  phoneMutation.mutate({ id: m.id, phone: next || null, name: m.name });
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                                }}
                              />
                              {m.activeBranch?.name && (
                                <p className="text-muted-foreground/80 truncate text-xs">
                                  {m.activeBranch.name}
                                </p>
                              )}
                              {m.portalInviteAt && (
                                <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-amber-600">
                                  <MessageCircle className="h-3 w-3 shrink-0" />
                                  Waiting for their WhatsApp reply
                                </p>
                              )}
                            </div>
                            {/* Resend is offered for EVERY member, owners included:
                                an owner who has lost their password needs it most,
                                and they are exactly who `locked` would exclude. */}
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 shrink-0 text-muted-foreground/60 hover:text-foreground"
                              disabled={inviteMutation.isPending}
                              onClick={() => (m.portalInviteAt ? inviteMutation.mutate(m) : setResetTarget(m))}
                              aria-label={`Send ${m.name} their sign-in details on WhatsApp`}
                              title={m.portalInviteAt ? 'Resend WhatsApp invite' : 'Send a new password on WhatsApp'}
                            >
                              <Send className="h-3.5 w-3.5" />
                            </Button>
                            {/* Remove, for the mistyped name. The login is derived
                                from it and there is no email edit, so without this
                                a typo sits in the list forever AND keeps its local
                                part reserved. Only while the invite is unanswered —
                                after that the server refuses anyway. */}
                            {m.portalInviteAt && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 shrink-0 text-muted-foreground/60 hover:text-destructive"
                                disabled={removeMutation.isPending}
                                onClick={() => setRemoveTarget(m)}
                                aria-label={`Remove ${m.name}`}
                                title="Remove"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            {!locked && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 shrink-0 text-muted-foreground/60 hover:text-destructive"
                                onClick={() => setDeactivateTarget(m)}
                                aria-label={`Deactivate ${m.name}`}
                              >
                                <UserMinus className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </div>

                          {/* Fallback toggle — same action as dragging. Rendered for
                              owners too: the lane now accepts them, so without it a
                              promotion could be made and never undone. */}
                          <Select
                            value={m.role}
                            onValueChange={(role) => changeRole(m, role as UserRole)}
                          >
                            <SelectTrigger className="mt-2 h-7 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {ASSIGNABLE_ROLES.map((role) => (
                                <SelectItem key={role} value={role} className="text-xs">
                                  {ROLE_LABELS[role]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Deactivated members — kept for their history, blocked from access. */}
      {(() => {
        const deactivated = members.filter((m) => !m.isActive);
        if (deactivated.length === 0) return null;
        return (
          <div className="rounded-xl border bg-muted/20">
            <div className="border-b px-3 py-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <UserX className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-semibold">Deactivated</span>
                </div>
                <span className="text-muted-foreground rounded-full bg-background px-2 py-0.5 text-xs font-medium">
                  {deactivated.length}
                </span>
              </div>
              <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                Signed out and blocked from logging in. Reactivate to restore access.
              </p>
            </div>
            <div className="grid gap-2 p-2 md:grid-cols-2 xl:grid-cols-4">
              {deactivated.map((m) => (
                <div
                  key={m.id}
                  className="flex items-start gap-2 rounded-lg border bg-background p-2.5 shadow-sm"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{m.name}</p>
                    <p className="text-muted-foreground truncate text-xs">{m.email}</p>
                    <p className="text-muted-foreground/80 truncate text-xs">
                      {ROLE_LABELS[m.role]}
                      {m.activeBranch?.name ? ` · ${m.activeBranch.name}` : ''}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 shrink-0 text-xs"
                    disabled={activeMutation.isPending}
                    onClick={() => activeMutation.mutate({ id: m.id, isActive: true, name: m.name })}
                  >
                    Reactivate
                  </Button>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      <AlertDialog
        open={!!deactivateTarget}
        onOpenChange={(open) => !open && setDeactivateTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate {deactivateTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              They'll be signed out and blocked from logging in. Their reports, visits and
              history stay intact, and you can reactivate them any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={activeMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              disabled={activeMutation.isPending}
              onClick={() => {
                if (deactivateTarget) {
                  activeMutation.mutate({
                    id: deactivateTarget.id,
                    isActive: false,
                    name: deactivateTarget.name,
                  });
                }
                setDeactivateTarget(null);
              }}
            >
              Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Resending to somebody who already signed in replaces their password, so
          it asks first. A pending invite skips this — it has nothing to replace. */}
      <AlertDialog open={!!resetTarget} onOpenChange={(open) => !open && setResetTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send {resetTarget?.name} a new password?</AlertDialogTitle>
            <AlertDialogDescription>
              They get a WhatsApp asking them to reply. The moment they do, a new password
              is generated and sent to them, and their current one stops working. Nothing
              changes until they reply, so this is safe to cancel.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={inviteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={inviteMutation.isPending}
              onClick={() => {
                if (resetTarget) inviteMutation.mutate(resetTarget);
                setResetTarget(null);
              }}
            >
              Send
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!removeTarget} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removeTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The account is deleted and {removeTarget?.email} becomes available again.
              They never replied to their invite, so they have never signed in and there
              is no work of theirs to lose. This cannot be undone — you would have to add
              them afresh.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              disabled={removeMutation.isPending}
              onClick={() => {
                if (removeTarget) removeMutation.mutate(removeTarget);
                setRemoveTarget(null);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Add a member. Only a name and a mobile: the login and the password are
          both generated, so there is nothing here for an operator to get wrong. */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a team member</DialogTitle>
            <DialogDescription>
              Their sign-in email is created from their first name. They get a WhatsApp
              asking them to reply; their password is sent the moment they do.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="member-role">Role</Label>
              <Select
                value={form.role}
                onValueChange={(v) => setForm((f) => ({ ...f, role: v as UserRole }))}
              >
                <SelectTrigger id="member-role"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ASSIGNABLE_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="member-name">Full name</Label>
              <Input
                id="member-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Anusha Reddy"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="member-phone">WhatsApp number</Label>
              <Input
                id="member-phone"
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                placeholder="9849000000"
                inputMode="tel"
              />
              <p className="text-muted-foreground text-xs">
                Their sign-in details are sent here once they reply, so this must be the
                WhatsApp they actually use.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button
              disabled={
                addMutation.isPending ||
                form.name.trim().length < 2 ||
                form.phone.replace(/\D/g, '').length < 10
              }
              onClick={() =>
                addMutation.mutate({ name: form.name.trim(), phone: form.phone.trim(), role: form.role })
              }
            >
              {addMutation.isPending ? 'Adding…' : 'Add member'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* What actually happened: an invite went out. No password is shown because
          none exists yet — it is generated when they reply, which is the only
          moment WhatsApp permits sending it. */}
      <Dialog open={!!issued} onOpenChange={(o) => !o && setIssued(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{issued?.name} has been added</DialogTitle>
            <DialogDescription>
              {issued?.delivered
                ? 'They have a WhatsApp asking them to reply. Their password is sent the moment they do.'
                : 'The invite did not go out — send them their sign-in email another way, then use Resend once their number works.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="text-muted-foreground text-xs">Their sign-in email</p>
              <p className="break-all font-mono text-sm">{issued?.email}</p>
            </div>
            {issued?.delivered ? (
              <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <MessageCircle className="h-3.5 w-3.5" /> Invite sent — waiting for their reply
              </p>
            ) : (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div>
                  <p className="font-medium">Invite not delivered</p>
                  <p className="text-muted-foreground text-xs">
                    {issued?.error || 'The message did not go out.'} They cannot sign in until
                    they have a password.
                  </p>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                navigator.clipboard.writeText(issued?.email ?? '');
                setCopied(true);
                toast.success('Copied');
              }}
            >
              {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
              Copy email
            </Button>
            <Button onClick={() => setIssued(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
