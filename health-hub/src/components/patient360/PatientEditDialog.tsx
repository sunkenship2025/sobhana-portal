import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { Pencil, MessageCircle } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { validatePatientForm, type ValidationErrors } from '@/lib/validation';
import { TITLE_TO_GENDER, titleOptions } from '@/lib/patientDisplay';
import { API_BASE } from '@/lib/api';

// Identity fields that require a reason
const IDENTITY_FIELDS = ['name', 'title', 'age', 'gender', 'phone', 'email'];

interface PatientEditDialogProps {
  patient: {
    id: string;
    name: string;
    title?: string | null;
    age: number;
    gender: string;
    address?: string | null;
    whatsappOptIn?: boolean;
    ageUnit?: string;
    identifiers: Array<{ type: string; value: string }>;
  };
  token: string | null;
  onSuccess: () => void;
}

export function PatientEditDialog({ patient, token, onSuccess }: PatientEditDialogProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  
  const primaryPhone = patient.identifiers.find((i) => i.type === 'PHONE')?.value || '';
  const primaryEmail = patient.identifiers.find((i) => i.type === 'EMAIL')?.value || '';

  const [formData, setFormData] = useState({
    name: patient.name,
    title: patient.title || '',
    age: patient.age.toString(),
    ageUnit: (patient.ageUnit || 'YEARS') as 'DAYS' | 'MONTHS' | 'YEARS',
    gender: patient.gender,
    phone: primaryPhone,
    email: primaryEmail,
    address: patient.address || '',
    whatsappOptIn: patient.whatsappOptIn ?? true,
    changeReason: '',
  });

  const [initialData] = useState({
    name: patient.name,
    title: patient.title || '',
    age: patient.age.toString(),
    ageUnit: (patient.ageUnit || 'YEARS') as string,
    gender: patient.gender,
    phone: primaryPhone,
    email: primaryEmail,
    address: patient.address || '',
  });
  
  // E2-10: Validation errors
  const [validationErrors, setValidationErrors] = useState<ValidationErrors>({});

  // Check if any identity fields changed
  const identityFieldsChanged = () => {
    return (
      formData.name !== initialData.name ||
      formData.title !== initialData.title ||
      formData.age !== initialData.age ||
      formData.gender !== initialData.gender ||
      formData.phone !== initialData.phone ||
      (formData.email !== initialData.email && (formData.email || initialData.email))
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // E2-10: Validate form data
    const errors = validatePatientForm({
      name: formData.name,
      title: formData.title,
      age: formData.age,
      gender: formData.gender,
      phone: formData.phone,
      email: formData.email,
      address: formData.address,
      ageUnit: formData.ageUnit,
    });

    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors);
      toast.error('Please fix validation errors', {
        description: Object.values(errors).join(', '),
      });
      return;
    }

    // Validate: if identity fields changed, reason is required
    if (identityFieldsChanged() && !formData.changeReason.trim()) {
      toast.error('Change reason required', {
        description: 'You must provide a reason when changing identity fields (name, age, gender, phone, email)',
      });
      return;
    }

    setLoading(true);

    try {
      const updatePayload: any = {};
      
      if (formData.name !== initialData.name) updatePayload.name = formData.name;
      if (formData.title !== initialData.title) updatePayload.title = formData.title || null;
      if (formData.age !== initialData.age) updatePayload.age = parseInt(formData.age);
      if (formData.ageUnit !== initialData.ageUnit) updatePayload.ageUnit = formData.ageUnit;
      if (formData.gender !== initialData.gender) updatePayload.gender = formData.gender;
      if (formData.address !== initialData.address) updatePayload.address = formData.address;
      
      // Handle phone change
      if (formData.phone !== initialData.phone) {
        updatePayload.phone = formData.phone;
      }

      // Handle email change
      if (formData.email !== initialData.email) {
        updatePayload.email = formData.email || null;
      }

      // Handle WhatsApp opt-in change
      if (formData.whatsappOptIn !== (patient.whatsappOptIn ?? true)) {
        updatePayload.whatsappOptIn = formData.whatsappOptIn;
      }

      // Add changeReason if provided
      if (formData.changeReason.trim()) {
        updatePayload.changeReason = formData.changeReason.trim();
      }

      const response = await fetch(`${API_BASE}/patients/${patient.id}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updatePayload),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to update patient');
      }

      toast.success('Patient updated successfully', {
        description: 'Patient details have been updated and logged.',
      });

      setOpen(false);
      onSuccess(); // Reload patient data
    } catch (error: any) {
      toast.error('Update failed', {
        description: error.message || 'Failed to update patient details',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (newOpen) {
      // Reset form when opening
      setFormData({
        name: patient.name,
        title: patient.title || '',
        age: patient.age.toString(),
        ageUnit: (patient.ageUnit || 'YEARS') as 'DAYS' | 'MONTHS' | 'YEARS',
        gender: patient.gender,
        phone: primaryPhone,
        email: primaryEmail,
        address: patient.address || '',
        whatsappOptIn: patient.whatsappOptIn ?? true,
        changeReason: '',
      });
    }
    setOpen(newOpen);
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Pencil className="h-4 w-4 mr-1" />
        Edit
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Patient Details</DialogTitle>
            <DialogDescription>
              Update patient information. Changes to identity fields (name, title, age, gender, phone, email) require a reason.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Title */}
            <div className="space-y-2">
              <Label>Title</Label>
              <Select
                value={formData.title}
                onValueChange={(v) => {
                  const autoGender = TITLE_TO_GENDER[v];
                  setFormData({
                    ...formData,
                    title: v,
                    ...(autoGender ? { gender: autoGender } : {}),
                  });
                  if (validationErrors.gender) {
                    setValidationErrors({ ...validationErrors, gender: undefined });
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select title" />
                </SelectTrigger>
                <SelectContent>
                  {titleOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Name */}
            <div className="space-y-2">
              <Label htmlFor="name">
                Full Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => {
                  setFormData({ ...formData, name: e.target.value });
                  if (validationErrors.name) {
                    setValidationErrors({ ...validationErrors, name: undefined });
                  }
                }}
                className={validationErrors.name ? 'border-red-500' : ''}
                required
              />
              {validationErrors.name && (
                <p className="text-sm text-destructive">{validationErrors.name}</p>
              )}
            </div>

            {/* Age and Gender */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="age">
                  Age <span className="text-destructive">*</span>
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="age"
                    type="number"
                    min="0"
                    max="150"
                    value={formData.age}
                    onChange={(e) => {
                      setFormData({ ...formData, age: e.target.value });
                      if (validationErrors.age) {
                        setValidationErrors({ ...validationErrors, age: undefined });
                      }
                    }}
                    className={`flex-1 ${validationErrors.age ? 'border-red-500' : ''}`}
                    required
                  />
                  <Select
                    value={formData.ageUnit}
                    onValueChange={(v) => setFormData({ ...formData, ageUnit: v as 'DAYS' | 'MONTHS' | 'YEARS' })}
                  >
                    <SelectTrigger className="w-[110px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="DAYS">Days</SelectItem>
                      <SelectItem value="MONTHS">Months</SelectItem>
                      <SelectItem value="YEARS">Years</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {validationErrors.age && (
                  <p className="text-sm text-destructive">{validationErrors.age}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="gender">
                  Gender <span className="text-destructive">*</span>
                </Label>
                <Select
                  value={formData.gender}
                  onValueChange={(value) => {
                    setFormData({ ...formData, gender: value });
                    if (validationErrors.gender) {
                      setValidationErrors({ ...validationErrors, gender: undefined });
                    }
                  }}
                >
                  <SelectTrigger id="gender" className={validationErrors.gender ? 'border-red-500' : ''}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="M">Male</SelectItem>
                    <SelectItem value="F">Female</SelectItem>
                    <SelectItem value="O">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Phone */}
            <div className="space-y-2">
              <Label htmlFor="phone">
                Phone Number <span className="text-destructive">*</span>
              </Label>
              <Input
                id="phone"
                type="tel"
                pattern="[0-9]{10}"
                maxLength={10}
                value={formData.phone}
                onChange={(e) => {
                  setFormData({ ...formData, phone: e.target.value.replace(/\D/g, '') });
                  if (validationErrors.phone) {
                    setValidationErrors({ ...validationErrors, phone: undefined });
                  }
                }}
                className={validationErrors.phone ? 'border-red-500' : ''}
                placeholder="10-digit mobile number"
                required
              />
              {validationErrors.phone && (
                <p className="text-sm text-destructive">{validationErrors.phone}</p>
              )}
            </div>

            {/* Email */}
            <div className="space-y-2">
              <Label htmlFor="email">Email (Optional)</Label>
              <Input
                id="email"
                type="email"
                value={formData.email}
                onChange={(e) => {
                  setFormData({ ...formData, email: e.target.value });
                  if (validationErrors.email) {
                    setValidationErrors({ ...validationErrors, email: undefined });
                  }
                }}
                className={validationErrors.email ? 'border-red-500' : ''}
                placeholder="patient@example.com"
              />
              {validationErrors.email && (
                <p className="text-sm text-destructive">{validationErrors.email}</p>
              )}
            </div>

            {/* Address */}
            <div className="space-y-2">
              <Label htmlFor="address">Address</Label>
              <Textarea
                id="address"
                value={formData.address}
                onChange={(e) => {
                  setFormData({ ...formData, address: e.target.value });
                  if (validationErrors.address) {
                    setValidationErrors({ ...validationErrors, address: undefined });
                  }
                }}
                className={validationErrors.address ? 'border-red-500' : ''}
                rows={2}
                placeholder="Patient address"
              />
              {validationErrors.address && (
                <p className="text-sm text-destructive">{validationErrors.address}</p>
              )}
            </div>

            {/* WhatsApp Preference */}
            <div className="flex items-center space-x-3 bg-green-50 border border-green-200 rounded-md p-3">
              <Checkbox
                id="editWhatsappOptIn"
                checked={formData.whatsappOptIn}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, whatsappOptIn: checked === true })
                }
              />
              <Label htmlFor="editWhatsappOptIn" className="flex items-center gap-2 text-sm cursor-pointer">
                <MessageCircle className="h-4 w-4 text-green-600" />
                Send reports & bill confirmations via WhatsApp
              </Label>
            </div>

            {/* Change Reason - shown if identity fields changed */}
            {identityFieldsChanged() && (
              <div className="space-y-2 border-t pt-4">
                <Label htmlFor="changeReason" className="text-orange-600">
                  Reason for Change <span className="text-destructive">*</span>
                </Label>
                <Textarea
                  id="changeReason"
                  value={formData.changeReason}
                  onChange={(e) => setFormData({ ...formData, changeReason: e.target.value })}
                  rows={3}
                  placeholder="Explain why identity fields are being changed (e.g., 'Correcting registration error', 'Patient provided updated information')"
                  className="border-orange-200 focus:border-orange-400"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  This reason will be logged for audit purposes.
                </p>
              </div>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={loading}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={loading}>
                {loading ? 'Saving...' : 'Save Changes'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
