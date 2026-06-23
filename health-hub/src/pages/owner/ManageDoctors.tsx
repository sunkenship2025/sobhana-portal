import { useState, useRef } from 'react';
import { useApiQuery, useApiMutation, apiCall, qk } from '@/lib/query';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { EmptyState } from '@/components/ui/empty-state';
import { useAuthStore } from '@/store/authStore';
import { useDoctorLookup } from '@/hooks/use-doctor-lookup';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, X, Check, AlertTriangle, Link as LinkIcon } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

const ManageDoctors = () => {
  const { token } = useAuthStore();
  const { lookupDoctorByPhone, getClinicDoctors, invalidateDoctorLookups } =
    useDoctorLookup();

  // Referral doctors are global (not branch-scoped).
  const { data: referralDoctors = [] } = useApiQuery<any[]>({
    queryKey: qk.referralDoctors(),
    queryFn: () => apiCall<any[]>('/referral-doctors'),
  });

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [existingDoctor, setExistingDoctor] = useState<any>(null);
  const [linkedDoctorId, setLinkedDoctorId] = useState<string | null>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const [formData, setFormData] = useState({
    name: '',
    phone: '',
    commissionPercent: '',
  });

  const saveMutation = useApiMutation<
    unknown,
    { editingId: string | null; body: Record<string, unknown> }
  >({
    mutationFn: ({ editingId, body }) =>
      editingId
        ? apiCall(`/referral-doctors/${editingId}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          })
        : apiCall('/referral-doctors', {
            method: 'POST',
            body: JSON.stringify(body),
          }),
    invalidate: [qk.referralDoctors()],
    onSuccess: (_data, { editingId }) => {
      // The doctor-lookup dedupe cache must refresh too (used by the add forms).
      invalidateDoctorLookups();
      toast.success(editingId ? 'Doctor updated' : 'Doctor added');
      resetForm();
    },
    onError: (err) => toast.error(err.message || 'Failed to save doctor'),
  });

  const deleteMutation = useApiMutation<unknown, string>({
    mutationFn: (id) =>
      apiCall(`/referral-doctors/${id}`, { method: 'DELETE' }),
    invalidate: [qk.referralDoctors()],
    onSuccess: () => {
      invalidateDoctorLookups();
      toast.success('Doctor deleted');
    },
    onError: (err) => toast.error(err.message || 'Failed to delete doctor'),
    onSettled: () => setDeleteId(null),
  });

  const checkExistingDoctor = async (phone: string) => {
    if (phone.length >= 10 && token) {
      const data = await lookupDoctorByPhone(phone);
      if (data.clinicDoctor) {
        setExistingDoctor({ type: 'clinic', doctor: data.clinicDoctor });
      } else if (data.referralDoctor && !editingId) {
        toast.error('This phone number is already registered as a referral doctor');
        setExistingDoctor({ type: 'referral', doctor: data.referralDoctor });
      } else {
        setExistingDoctor(null);
      }
    } else {
      setExistingDoctor(null);
    }
  };

  const checkExistingDoctorByName = async (name: string) => {
    if (name.length >= 3 && token && !editingId) {
      // Cached clinic-doctor list (fetched once, not per keystroke), matched locally.
      const clinicDoctors = await getClinicDoctors();
      const match = clinicDoctors.find((doc: any) =>
        doc.name.toLowerCase().includes(name.toLowerCase())
      );
      setExistingDoctor(match ? { type: 'clinic', doctor: match } : null);
    } else {
      if (name.length < 3) {
        setExistingDoctor(null);
      }
    }
  };

  const handlePhoneChange = (phone: string) => {
    setFormData({ ...formData, phone });
    checkExistingDoctor(phone);
  };

  const handleNameChange = (name: string) => {
    setFormData({ ...formData, name });
    
    // Clear existing timeout
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }
    
    // Debounce the search
    searchTimeoutRef.current = setTimeout(() => {
      checkExistingDoctorByName(name);
    }, 500); // Wait 500ms after user stops typing
  };

  const linkToClinicDoctor = () => {
    if (existingDoctor?.doctor) {
      setFormData({
        ...formData,
        name: existingDoctor.doctor.name,
        phone: existingDoctor.doctor.phone
      });
      setLinkedDoctorId(existingDoctor.doctor.id);
      toast.success(`Linked to clinic doctor ${existingDoctor.doctor.doctorNumber}`);
    }
  };

  const resetForm = () => {
    setFormData({ name: '', phone: '', commissionPercent: '' });
    setShowForm(false);
    setEditingId(null);
    setExistingDoctor(null);
    setLinkedDoctorId(null);
  };

  const handleSubmit = () => {
    if (!formData.name || !formData.phone || !formData.commissionPercent) {
      toast.error('Please fill all fields');
      return;
    }

    const commission = parseFloat(formData.commissionPercent);
    if (isNaN(commission) || commission < 0 || commission > 100) {
      toast.error('Commission must be between 0 and 100');
      return;
    }

    saveMutation.mutate({
      editingId,
      body: {
        name: formData.name,
        phone: formData.phone,
        commissionPercent: commission,
        // clinicDoctorId is only sent on create.
        ...(editingId ? {} : { clinicDoctorId: linkedDoctorId }),
      },
    });
  };

  const handleEdit = (doctor: typeof referralDoctors[0]) => {
    setFormData({
      name: doctor.name,
      phone: doctor.phone,
      commissionPercent: doctor.commissionPercent.toString(),
    });
    setEditingId(doctor.id);
    setShowForm(true);
  };

  const handleDelete = () => {
    if (deleteId) deleteMutation.mutate(deleteId);
  };

  return (
    <AppLayout context="owner">
      <div className="max-w-4xl mx-auto space-y-6 animate-fade-in">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Manage Referral Doctors</h1>
            <p className="text-muted-foreground">Add doctors with commission percentages for referrals.</p>
          </div>
          {!showForm && (
            <Button onClick={() => setShowForm(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Doctor
            </Button>
          )}
        </div>

        {showForm && (
          <Card className="border-primary/30">
            <CardHeader>
              <CardTitle>{editingId ? 'Edit Doctor' : 'Add New Doctor'}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="name">Doctor Name *</Label>
                  <Input
                    id="name"
                    placeholder="Dr. Name (type to search)"
                    value={formData.name}
                    onChange={(e) => handleNameChange(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone">Phone *</Label>
                  <Input
                    id="phone"
                    placeholder="10-digit phone"
                    value={formData.phone}
                    onChange={(e) => handlePhoneChange(e.target.value)}
                    maxLength={10}
                  />
                </div>
                
                {existingDoctor?.type === 'clinic' && (
                  <div className="md:col-span-3">
                    <Alert className="border-yellow-500 bg-yellow-50">
                      <AlertTriangle className="h-4 w-4 text-yellow-600" />
                      <AlertDescription className="flex items-center justify-between">
                        <div>
                          <p className="font-medium text-yellow-800">Clinic Doctor Found</p>
                          <p className="text-sm text-yellow-700">
                            {existingDoctor.doctor.name} ({existingDoctor.doctor.doctorNumber}) - {existingDoctor.doctor.specialty}
                          </p>
                        </div>
                        {!linkedDoctorId && (
                          <Button 
                            size="sm" 
                            variant="outline"
                            className="ml-4"
                            onClick={linkToClinicDoctor}
                          >
                            <LinkIcon className="h-4 w-4 mr-2" />
                            Link to this doctor
                          </Button>
                        )}
                        {linkedDoctorId && (
                          <span className="text-green-700 text-sm flex items-center ml-4">
                            <Check className="h-4 w-4 mr-1" />
                            Linked
                          </span>
                        )}
                      </AlertDescription>
                    </Alert>
                  </div>
                )}
                
                <div className="space-y-2">
                  <Label htmlFor="commission">Commission % *</Label>
                  <Input
                    id="commission"
                    type="number"
                    placeholder="e.g. 10"
                    value={formData.commissionPercent}
                    onChange={(e) => setFormData({ ...formData, commissionPercent: e.target.value })}
                    min={0}
                    max={100}
                  />
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={resetForm}>
                  <X className="h-4 w-4 mr-2" />
                  Cancel
                </Button>
                <Button onClick={handleSubmit} disabled={saveMutation.isPending}>
                  <Check className="h-4 w-4 mr-2" />
                  {saveMutation.isPending ? 'Saving...' : `${editingId ? 'Update' : 'Add'} Doctor`}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Referral Doctors ({referralDoctors.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {referralDoctors.length === 0 ? (
              <EmptyState title="No doctors yet" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead className="text-right">Commission %</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {referralDoctors.map((doctor) => (
                    <TableRow key={doctor.id}>
                      <TableCell className="font-medium">{doctor.name}</TableCell>
                      <TableCell>{doctor.phone}</TableCell>
                      <TableCell className="text-right font-mono">{doctor.commissionPercent}%</TableCell>
                      <TableCell className="text-right">
                        <div className="flex gap-2 justify-end">
                          <Button variant="ghost" size="icon" onClick={() => handleEdit(doctor)} aria-label="Edit doctor">
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => setDeleteId(doctor.id)} aria-label="Delete doctor">
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Doctor?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The doctor will be removed from the list.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleteMutation.isPending} className="bg-destructive text-destructive-foreground">
              {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
};

export default ManageDoctors;
