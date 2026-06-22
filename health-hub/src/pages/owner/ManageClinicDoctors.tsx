import { useState } from 'react';
import { useApiQuery, useApiMutation, apiCall, qk } from '@/lib/query';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useAuthStore } from '@/store/authStore';
import { useDoctorLookup } from '@/hooks/use-doctor-lookup';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, X, Check, AlertTriangle, Link as LinkIcon } from 'lucide-react';
import { formatReferralPayout } from '@/lib/referralPayouts';
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

const ManageClinicDoctors = () => {
  const { token } = useAuthStore();
  const { lookupDoctorByPhone, getReferralDoctors, invalidateDoctorLookups } =
    useDoctorLookup();

  // Clinic doctors are global (not branch-scoped).
  const { data: clinicDoctors = [] } = useApiQuery<any[]>({
    queryKey: qk.clinicDoctors(),
    queryFn: () => apiCall<any[]>('/clinic-doctors'),
  });

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [existingDoctor, setExistingDoctor] = useState<any>(null);
  const [linkedDoctorId, setLinkedDoctorId] = useState<string | null>(null);

  const saveMutation = useApiMutation<
    unknown,
    { editingId: string | null; payload: Record<string, unknown> }
  >({
    mutationFn: ({ editingId, payload }) =>
      editingId
        ? apiCall(`/clinic-doctors/${editingId}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
          })
        : apiCall('/clinic-doctors', {
            method: 'POST',
            body: JSON.stringify(payload),
          }),
    invalidate: [qk.clinicDoctors()],
    onSuccess: (_data, { editingId }) => {
      invalidateDoctorLookups();
      toast.success(editingId ? 'Doctor updated' : 'Doctor added');
      resetForm();
    },
    onError: (err) => toast.error(err.message || 'Failed to save doctor'),
  });

  const deleteMutation = useApiMutation<unknown, string>({
    mutationFn: (id) => apiCall(`/clinic-doctors/${id}`, { method: 'DELETE' }),
    invalidate: [qk.clinicDoctors()],
    onSuccess: () => {
      invalidateDoctorLookups();
      toast.success('Doctor deleted');
    },
    onError: (err) => toast.error(err.message || 'Failed to delete doctor'),
    onSettled: () => setDeleteId(null),
  });

  const [formData, setFormData] = useState({
    name: '',
    qualification: '',
    specialty: '',
    registrationNumber: '',
    phone: '',
    letterheadNote: '',
  });

  const checkExistingDoctor = async (phone: string) => {
    if (phone.length >= 10 && token) {
      const data = await lookupDoctorByPhone(phone);
      if (data.referralDoctor) {
        setExistingDoctor({ type: 'referral', doctor: data.referralDoctor });
      } else if (data.clinicDoctor && !editingId) {
        toast.error('This phone number is already registered as a clinic doctor');
        setExistingDoctor({ type: 'clinic', doctor: data.clinicDoctor });
      } else {
        setExistingDoctor(null);
      }
    } else {
      setExistingDoctor(null);
    }
  };

  const checkExistingDoctorByName = async (name: string) => {
    if (name.length >= 3 && token) {
      // Cached referral-doctor list (fetched once, not per keystroke), matched locally.
      const referralDoctors = await getReferralDoctors();
      const match = referralDoctors.find((doc: any) =>
        doc.name.toLowerCase().includes(name.toLowerCase())
      );
      setExistingDoctor(match ? { type: 'referral', doctor: match } : null);
    } else {
      setExistingDoctor(null);
    }
  };

  const handlePhoneChange = (phone: string) => {
    setFormData({ ...formData, phone });
    checkExistingDoctor(phone);
  };

  const handleNameChange = (name: string) => {
    setFormData({ ...formData, name });
    checkExistingDoctorByName(name);
  };

  const linkToReferralDoctor = () => {
    if (existingDoctor?.doctor) {
      setFormData({
        ...formData,
        name: existingDoctor.doctor.name,
        phone: existingDoctor.doctor.phone
      });
      setLinkedDoctorId(existingDoctor.doctor.id);
      toast.success(`Linked to referral doctor ${existingDoctor.doctor.doctorNumber}`);
    }
  };

  const resetForm = () => {
    setFormData({
      name: '',
      qualification: '',
      specialty: '',
      registrationNumber: '',
      phone: '',
      letterheadNote: '',
    });
    setShowForm(false);
    setEditingId(null);
    setExistingDoctor(null);
    setLinkedDoctorId(null);
  };

  const handleSubmit = async () => {
    if (!formData.name || !formData.qualification || !formData.specialty || !formData.registrationNumber) {
      toast.error('Name, qualification, specialty, and registration number are required');
      return;
    }

    if (formData.phone && formData.phone.length !== 10) {
      toast.error('Phone must be 10 digits');
      return;
    }

    const payload = {
      name: formData.name,
      qualification: formData.qualification,
      specialty: formData.specialty,
      registrationNumber: formData.registrationNumber,
      phone: formData.phone,
      letterheadNote: formData.letterheadNote,
      referralDoctorId: linkedDoctorId,
    };

    saveMutation.mutate({ editingId, payload });
  };

  const handleEdit = (doctor: typeof clinicDoctors[0]) => {
    setFormData({
      name: doctor.name,
      qualification: doctor.qualification,
      specialty: doctor.specialty,
      registrationNumber: doctor.registrationNumber,
      phone: doctor.phone || '',
      letterheadNote: doctor.letterheadNote || '',
    });
    setEditingId(doctor.id);
    setShowForm(true);
  };

  const handleDelete = () => {
    if (deleteId) deleteMutation.mutate(deleteId);
  };

  return (
    <AppLayout context="owner">
      <div className="max-w-5xl mx-auto space-y-6 animate-fade-in">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Clinic Doctors</h1>
            <p className="text-muted-foreground">Add consulting doctors with letterhead details for clinic prescriptions.</p>
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
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="name">Doctor Name *</Label>
                  <Input
                    id="name"
                    placeholder="Dr. Full Name (type to search)"
                    value={formData.name}
                    onChange={(e) => handleNameChange(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="qualification">Qualification *</Label>
                  <Input
                    id="qualification"
                    placeholder="e.g., MBBS, MD (Gen Med)"
                    value={formData.qualification}
                    onChange={(e) => setFormData({ ...formData, qualification: e.target.value })}
                  />
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="specialty">Specialty *</Label>
                  <Input
                    id="specialty"
                    placeholder="e.g., General Medicine"
                    value={formData.specialty}
                    onChange={(e) => setFormData({ ...formData, specialty: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="registration">Registration No. *</Label>
                  <Input
                    id="registration"
                    placeholder="e.g., TSMC/GM/2020/1234"
                    value={formData.registrationNumber}
                    onChange={(e) => setFormData({ ...formData, registrationNumber: e.target.value })}
                  />
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="phone">Phone</Label>
                  <Input
                    id="phone"
                    placeholder="10-digit phone"
                    value={formData.phone}
                    onChange={(e) => handlePhoneChange(e.target.value.replace(/\D/g, '').slice(0, 10))}
                    maxLength={10}
                  />
                </div>
                
                {existingDoctor?.type === 'referral' && (
                  <div className="md:col-span-2">
                    <Alert className="border-yellow-500 bg-yellow-50">
                      <AlertTriangle className="h-4 w-4 text-yellow-600" />
                      <AlertDescription className="flex items-center justify-between">
                        <div>
                          <p className="font-medium text-yellow-800">Referral Doctor Found</p>
                          <p className="text-sm text-yellow-700">
                            {existingDoctor.doctor.name} ({existingDoctor.doctor.doctorNumber}) - {formatReferralPayout(existingDoctor.doctor)} payout
                          </p>
                        </div>
                        {!linkedDoctorId && (
                          <Button 
                            size="sm" 
                            variant="outline"
                            className="ml-4"
                            onClick={linkToReferralDoctor}
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
                  <Label htmlFor="note">Letterhead Note</Label>
                  <Input
                    id="note"
                    placeholder="e.g., Compassionate primary care"
                    value={formData.letterheadNote}
                    onChange={(e) => setFormData({ ...formData, letterheadNote: e.target.value })}
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
            <CardTitle>Clinic Doctors ({clinicDoctors.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {clinicDoctors.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No doctors added yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Qualification</TableHead>
                    <TableHead>Specialty</TableHead>
                    <TableHead>Reg. No.</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {clinicDoctors.map((doctor) => (
                    <TableRow key={doctor.id}>
                      <TableCell className="font-medium">{doctor.name}</TableCell>
                      <TableCell>{doctor.qualification}</TableCell>
                      <TableCell>{doctor.specialty}</TableCell>
                      <TableCell className="font-mono text-sm">{doctor.registrationNumber}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex gap-2 justify-end">
                          <Button variant="ghost" size="icon" onClick={() => handleEdit(doctor)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => setDeleteId(doctor.id)}>
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

export default ManageClinicDoctors;
