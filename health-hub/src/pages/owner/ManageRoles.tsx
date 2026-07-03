import { useApiQuery, useApiMutation, apiCall } from '@/lib/query';
import { toast } from 'sonner';
import { ShieldCheck, Lock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ROLE_LABELS, UserRole } from '@/store/authStore';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

/* ───────── Types ───────── */

interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  activeBranch?: { id: string; name: string } | null;
}

/** Roles an owner can assign here. `owner` is intentionally excluded (locked). */
const ASSIGNABLE_ROLES: UserRole[] = ['lab_incharge', 'staff', 'sales'];

/** One-line description of what each role can do, shown as reference. */
const ROLE_ACCESS: Record<UserRole, string> = {
  owner: 'Full access to everything, including finalizing reports.',
  lab_incharge: 'Full lab workflow and the only non-owner who can finalize reports.',
  staff: 'Day-to-day operations and billing. Cannot finalize reports.',
  sales: 'Referrals and payouts only. Cannot send WhatsApp.',
};

/* ───────── Component ───────── */

export default function ManageRoles() {
  const { data: members = [], isLoading } = useApiQuery<TeamMember[]>({
    queryKey: ['users'],
    queryFn: () => apiCall<{ data: TeamMember[] }>('/users').then((r) => r.data),
  });

  const roleMutation = useApiMutation<TeamMember, { id: string; role: UserRole }>({
    mutationFn: ({ id, role }) =>
      apiCall<{ data: TeamMember }>(`/users/${id}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      }).then((r) => r.data),
    invalidate: [['users']],
    onSuccess: (updated) =>
      toast.success(`${updated.name} is now ${ROLE_LABELS[updated.role]}`),
    onError: (err) => toast.error(err.message || 'Failed to change role'),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-primary/10 p-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">Roles</h2>
          <p className="text-muted-foreground text-sm">
            Assign each team member a role. Only the owner can manage roles, and the owner
            role itself cannot be changed.
          </p>
        </div>
      </div>

      {/* Reference: what each role can do */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {(['owner', 'lab_incharge', 'staff', 'sales'] as UserRole[]).map((role) => (
          <div key={role} className="rounded-lg border p-3">
            <p className="text-sm font-medium">{ROLE_LABELS[role]}</p>
            <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
              {ROLE_ACCESS[role]}
            </p>
          </div>
        ))}
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Branch</TableHead>
              <TableHead className="w-[200px]">Role</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground py-8 text-center text-sm">
                  Loading team…
                </TableCell>
              </TableRow>
            ) : members.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground py-8 text-center text-sm">
                  No team members found.
                </TableCell>
              </TableRow>
            ) : (
              members.map((m) => {
                const isOwner = m.role === 'owner';
                const pending =
                  roleMutation.isPending && roleMutation.variables?.id === m.id;
                return (
                  <TableRow key={m.id}>
                    <TableCell className="font-medium">{m.name}</TableCell>
                    <TableCell className="text-muted-foreground">{m.email}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {m.activeBranch?.name ?? '—'}
                    </TableCell>
                    <TableCell>
                      {isOwner ? (
                        <Badge variant="secondary" className="gap-1">
                          <Lock className="h-3 w-3" />
                          Owner · locked
                        </Badge>
                      ) : (
                        <Select
                          value={m.role}
                          disabled={pending}
                          onValueChange={(role) =>
                            roleMutation.mutate({ id: m.id, role: role as UserRole })
                          }
                        >
                          <SelectTrigger className="w-[180px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ASSIGNABLE_ROLES.map((role) => (
                              <SelectItem key={role} value={role}>
                                {ROLE_LABELS[role]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
