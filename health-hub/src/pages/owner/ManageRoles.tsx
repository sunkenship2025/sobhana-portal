import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiQuery, apiCall } from '@/lib/query';
import { toast } from 'sonner';
import {
  ShieldCheck, Lock, Crown, FlaskConical, Users, Megaphone, GripVertical,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { ROLE_LABELS, UserRole } from '@/store/authStore';

/* ───────── Types ───────── */

interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  activeBranch?: { id: string; name: string } | null;
}

/** Roles an owner can assign here, in display order. `owner` is locked. */
const ASSIGNABLE_ROLES: UserRole[] = ['lab_incharge', 'staff', 'sales'];

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

  const { data: members = [], isLoading } = useApiQuery<TeamMember[]>({
    queryKey: ['users'],
    queryFn: () => apiCall<{ data: TeamMember[] }>('/users').then((r) => r.data),
  });

  // Optimistic role change — the card jumps to its new lane immediately and
  // rolls back if the request fails.
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
    if (m.role === 'owner' || role === 'owner' || role === m.role) return;
    roleMutation.mutate({ id: m.id, role, name: m.name });
  };

  const handleDrop = (role: UserRole) => {
    setOverRole(null);
    const m = members.find((x) => x.id === dragId);
    setDragId(null);
    if (m) changeRole(m, role);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-primary/10 p-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">Roles</h2>
          <p className="text-muted-foreground text-sm">
            Drag a member into a role, or use the selector on their card. The owner role
            is locked and cannot be changed.
          </p>
        </div>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground py-8 text-center text-sm">Loading team…</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {LANES.map((lane) => {
            const Icon = lane.icon;
            const laneMembers = members.filter((m) => m.role === lane.role);
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
                              {m.activeBranch?.name && (
                                <p className="text-muted-foreground/80 truncate text-xs">
                                  {m.activeBranch.name}
                                </p>
                              )}
                            </div>
                          </div>

                          {/* Fallback toggle — same action as dragging */}
                          {locked ? (
                            <p className="text-muted-foreground/70 mt-2 text-[11px] italic">
                              Owner · locked
                            </p>
                          ) : (
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
                          )}
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
    </div>
  );
}
