import { useState, useEffect, useRef } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useAuthStore } from '@/store/authStore';
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
  
  const [referralDoctors, setReferralDoctors] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
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

  // Fetch referral doctors from API
  const fetchReferralDoctors = async () => {
    if (!token) return;
    try {
      const res = await fetch('http://localhost:3000/api/referral-doctors', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const doctors = await res.json();
        setReferralDoctors(doctors);
      }
    } catch (err) {
      console.error('Error fetching referral doctors:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReferralDoctors();
  }, [token]);

  const checkExistingDoctor = async (phone: string) => {
    if (phone.length >= 10 && token) {
      try {
        const res = await fetch(`http://localhost:3000/api/doctors/search-by-contact?phone=${phone}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        
        if (data.clinicDoctor) {
          setExistingDoctor({ type: 'clinic', doctor: data.clinicDoctor });
        } else if (data.referralDoctor && !editingId) {
          toast.error('This phone number is already registered as a referral doctor');
          setExistingDoctor({ type: 'referral', doctor: data.referralDoctor });
        } else {
          setExistingDoctor(null);
        }
      } catch (err) {
        console.error('Error checking doctor:', err);
      }
    } else {
      setExistingDoctor(null);
    }
  };

  const checkExistingDoctorByName = async (name: string) => {
    if (name.length >= 3 && token && !editingId) {
      try {
        console.log('Searching for clinic doctor by name:', name);
        // Search clinic doctors by name
        const res = await fetch(`http://localhost:3000/api/clinic-doctors`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        
        if (!res.ok) {
          console.error('Failed to fetch clinic doctors:', res.status);
          return;
        }
        
        const clinicDoctors = await res.json();
        console.log('Clinic doctors found:', clinicDoctors.length);
        
        const match = clinicDoctors.find((doc: any) => 
          doc.name.toLowerCase().includes(name.toLowerCase())
        );
        
        if (match) {
          console.log('Match found:', match);
          setExistingDoctor({ type: 'clinic', doctor: match });
        } else {
          console.log('No match found');
          setExistingDoctor(null);
        }
      } catch (err) {
        console.error('Error searching doctor by name:', err);
        setExistingDoctor(null);
      }
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

  const handleSubmit = async () => {
    if (!formData.name || !formData.phone || !formData.commissionPercent) {
      toast.error('Please fill all fields');
      return;
    }

    const commission = parseFloat(formData.commissionPercent);
    if (isNaN(commission) || commission < 0 || commission > 100) {
      toast.error('Commission must be between 0 and 100');
      return;
    }

    try {
      if (editingId) {
        // Update existing doctor via API
        const res = await fetch(`http://localhost:3000/api/referral-doctors/${editingId}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({
            name: formData.name,
            phone: formData.phone,
            commissionPercent: commission,
          })
        });
        
        if (!res.ok) {
          const err = await res.json();
          toast.error(err.message || 'Failed to update doctor');
          return;
        }
        
        toast.success('Doctor updated');
      } else {
        // Create new doctor via API
        const res = await fetch('http://localhost:3000/api/referral-doctors', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({
            name: formData.name,
            phone: formData.phone,
            commissionPercent: commission,
            clinicDoctorId: linkedDoctorId,
          })
        });
        
        if (!res.ok) {
          const err = await res.json();
          toast.error(err.message || 'Failed to add doctor');
          return;
        }
        
        toast.success('Doctor added');
      }
      
      // Refresh the list
      await fetchReferralDoctors();
      resetForm();
    } catch (err) {
      console.error('Error saving doctor:', err);
      toast.error('Failed to save doctor');
    }
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

  const handleDelete = async () => {
    if (deleteId) {
      try {
        const res = await fetch(`http://localhost:3000/api/referral-doctors/${deleteId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` }
        });
        
        if (!res.ok) {
          const err = await res.json();
          toast.error(err.message || 'Failed to delete doctor');
          return;
        }
        
        toast.success('Doctor deleted');
        await fetchReferralDoctors();
      } catch (err) {
        console.error('Error deleting doctor:', err);
        toast.error('Failed to delete doctor');
      }
      setDeleteId(null);
    }
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
                <Button onClick={handleSubmit}>
                  <Check className="h-4 w-4 mr-2" />
                  {editingId ? 'Update' : 'Add'} Doctor
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
              <p className="text-center text-muted-foreground py-8">No doctors added yet.</p>
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
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
};

export default ManageDoctors;
