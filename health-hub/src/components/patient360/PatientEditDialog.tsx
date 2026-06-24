/**
 * PatientEditDialog — Form → Review two-state edit dialog (06-frontend-plan.md
 * Group F / §3.4 / §5).
 *
 * Behaviour:
 *  - Form state collects edits. On submit we diff against the initial snapshot.
 *  - If any IDENTITY_FIELDS changed (name/title/age/gender/phone/email), a
 *    mandatory `changeReason` is required and the body switches to a REVIEW state
 *    showing each changed field old→new before a final "Confirm & Save".
 *  - Address-only / whatsapp-only changes skip review and save directly.
 *  - Persistence goes through `usePatientIdentityEdit`, whose `onSuccess`
 *    INVALIDATES the Patient360 summary (one scoped refetch, NOT a full page
 *    reload — §3.4). The PATCH response body is the raw Prisma row (no computed
 *    `ageDisplay`/`age`), so we never setQueryData-merge it into the summary.
 *  - `onSuccess(updated)` hands the updated Patient back to the caller.
 */
import { useMemo, useState } from 'react';
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
import { Pencil, MessageCircle, ArrowLeft, AlertTriangle } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { validatePatientForm, type ValidationErrors } from '@/lib/validation';
import { TITLE_TO_GENDER, titleOptions } from '@/lib/patientDisplay';
import { usePatientIdentityEdit } from '@/hooks/patient360/usePatient360';
import type { AgeUnit, Gender, Patient, PatientEditPayload, Title } from '@/types';

// Identity fields that require a reason + a review step.
const IDENTITY_FIELDS = ['name', 'title', 'age', 'gender', 'phone', 'email'] as const;

const GENDER_LABEL: Record<string, string> = { M: 'Male', F: 'Female', O: 'Other' };

interface PatientEditDialogProps {
  patient: Patient;
  /** Retained for back-compat with existing call sites; no longer used (the
   *  mutation reads the token from the api layer). */
  token?: string | null;
  onSuccess: (updated: Patient) => void;
}

type FieldKey = 'title' | 'name' | 'age' | 'ageUnit' | 'gender' | 'phone' | 'email' | 'address';

const FIELD_LABEL: Record<FieldKey, string> = {
  title: 'Title',
  name: 'Name',
  age: 'Age',
  ageUnit: 'Age unit',
  gender: 'Gender',
  phone: 'Phone',
  email: 'Email',
  address: 'Address',
};

export function PatientEditDialog({ patient, onSuccess }: PatientEditDialogProps) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'form' | 'review'>('form');

  const mutation = usePatientIdentityEdit(patient.id);
  const loading = mutation.isPending;

  const primaryPhone = patient.identifiers?.find((i) => i.type === 'PHONE')?.value || '';
  const primaryEmail = patient.identifiers?.find((i) => i.type === 'EMAIL')?.value || '';

  const buildInitial = () => ({
    name: patient.name,
    title: (patient.title as string) || '',
    age: patient.age?.toString() ?? '',
    ageUnit: (patient.ageUnit || 'YEARS') as AgeUnit,
    gender: patient.gender as string,
    phone: primaryPhone,
    email: primaryEmail,
    address: patient.address || '',
    whatsappOptIn: patient.whatsappOptIn ?? true,
    changeReason: '',
  });

  const [formData, setFormData] = useState(buildInitial);
  const [initialData] = useState(buildInitial);
  const [validationErrors, setValidationErrors] = useState<ValidationErrors>({});

  // Field-level diff (excludes changeReason + whatsappOptIn from "identity").
  const changedFields = useMemo(() => {
    const out: Array<{ key: FieldKey; old: string; next: string }> = [];
    const push = (key: FieldKey, oldVal: string, nextVal: string) => {
      if (oldVal !== nextVal) out.push({ key, old: oldVal, next: nextVal });
    };
    push('title', initialData.title, formData.title);
    push('name', initialData.name, formData.name);
    push('age', initialData.age, formData.age);
    push('ageUnit', initialData.ageUnit, formData.ageUnit);
    push('gender', initialData.gender, formData.gender);
    push('phone', initialData.phone, formData.phone);
    push('email', initialData.email, formData.email);
    push('address', initialData.address, formData.address);
    return out;
  }, [formData, initialData]);

  const identityChanges = useMemo(
    () => changedFields.filter((c) => (IDENTITY_FIELDS as readonly string[]).includes(c.key)),
    [changedFields],
  );
  const hasIdentityChange = identityChanges.length > 0;
  const whatsappChanged = formData.whatsappOptIn !== initialData.whatsappOptIn;
  const hasAnyChange = changedFields.length > 0 || whatsappChanged;

  const displayValue = (key: FieldKey, raw: string): string => {
    if (raw === '' || raw == null) return '—';
    if (key === 'gender') return GENDER_LABEL[raw] ?? raw;
    if (key === 'title') return titleOptions.find((o) => o.value === raw)?.label ?? raw;
    if (key === 'age') return `${raw} ${formData.ageUnit.toLowerCase()}`;
    return raw;
  };

  /** Build the PATCH payload from the diff. */
  const buildPayload = (): PatientEditPayload => {
    const payload: PatientEditPayload = {};
    if (formData.name !== initialData.name) payload.name = formData.name;
    if (formData.title !== initialData.title) payload.title = (formData.title || undefined) as Title | undefined;
    if (formData.age !== initialData.age) payload.age = parseInt(formData.age, 10);
    if (formData.ageUnit !== initialData.ageUnit) payload.ageUnit = formData.ageUnit;
    if (formData.gender !== initialData.gender) payload.gender = formData.gender as Gender;
    if (formData.address !== initialData.address) payload.address = formData.address;
    if (formData.phone !== initialData.phone) payload.phone = formData.phone;
    if (formData.email !== initialData.email) payload.email = formData.email || undefined;
    if (whatsappChanged) payload.whatsappOptIn = formData.whatsappOptIn;
    if (formData.changeReason.trim()) payload.changeReason = formData.changeReason.trim();
    return payload;
  };

  const persist = async () => {
    try {
      const updated = await mutation.mutateAsync(buildPayload());
      toast.success('Patient updated successfully', {
        description: 'Patient details have been updated and logged.',
      });
      onSuccess(updated);
      handleOpenChange(false);
    } catch (error) {
      toast.error('Update failed', {
        description: error instanceof Error ? error.message : 'Failed to update patient details',
      });
    }
  };

  // Form submit: validate, then either go to review (identity change) or save.
  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();

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

    if (!hasAnyChange) {
      toast.message('No changes to save');
      return;
    }

    if (hasIdentityChange) {
      if (!formData.changeReason.trim()) {
        toast.error('Change reason required', {
          description:
            'You must provide a reason when changing identity fields (name, title, age, gender, phone, email).',
        });
        return;
      }
      setStep('review');
      return;
    }

    // Address-only / whatsapp-only → skip review.
    void persist();
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (newOpen) {
      const fresh = buildInitial();
      setFormData(fresh);
      setValidationErrors({});
      setStep('form');
    } else {
      setStep('form');
    }
    setOpen(newOpen);
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => handleOpenChange(true)}>
        <Pencil className="mr-1 h-4 w-4" />
        Edit
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          {step === 'form' ? (
            <>
              <DialogHeader>
                <DialogTitle>Edit Patient Details</DialogTitle>
                <DialogDescription>
                  Update patient information. Changes to identity fields (name, title, age, gender,
                  phone, email) require a reason and a confirmation step.
                </DialogDescription>
              </DialogHeader>

              <form onSubmit={handleFormSubmit} className="space-y-4">
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
                    className={validationErrors.name ? 'border-destructive' : ''}
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
                        className={`flex-1 ${validationErrors.age ? 'border-destructive' : ''}`}
                        required
                      />
                      <Select
                        value={formData.ageUnit}
                        onValueChange={(v) =>
                          setFormData({ ...formData, ageUnit: v as AgeUnit })
                        }
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
                      <SelectTrigger
                        id="gender"
                        className={validationErrors.gender ? 'border-destructive' : ''}
                      >
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
                    className={validationErrors.phone ? 'border-destructive' : ''}
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
                    className={validationErrors.email ? 'border-destructive' : ''}
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
                    className={validationErrors.address ? 'border-destructive' : ''}
                    rows={2}
                    placeholder="Patient address"
                  />
                  {validationErrors.address && (
                    <p className="text-sm text-destructive">{validationErrors.address}</p>
                  )}
                </div>

                {/* WhatsApp Preference */}
                <div className="flex items-center space-x-3 rounded-md border border-green-200 bg-green-50 p-3">
                  <Checkbox
                    id="editWhatsappOptIn"
                    checked={formData.whatsappOptIn}
                    onCheckedChange={(checked) =>
                      setFormData({ ...formData, whatsappOptIn: checked === true })
                    }
                  />
                  <Label
                    htmlFor="editWhatsappOptIn"
                    className="flex cursor-pointer items-center gap-2 text-sm"
                  >
                    <MessageCircle className="h-4 w-4 text-green-600" />
                    Send reports &amp; bill confirmations via WhatsApp
                  </Label>
                </div>

                {/* Change Reason — required when identity fields changed */}
                {hasIdentityChange && (
                  <div className="space-y-2 border-t pt-4">
                    <Label htmlFor="changeReason" className="text-orange-600">
                      Reason for Change <span className="text-destructive">*</span>
                    </Label>
                    <Textarea
                      id="changeReason"
                      value={formData.changeReason}
                      onChange={(e) =>
                        setFormData({ ...formData, changeReason: e.target.value })
                      }
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
                    onClick={() => handleOpenChange(false)}
                    disabled={loading}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={loading}>
                    {hasIdentityChange ? 'Review changes' : loading ? 'Saving…' : 'Save Changes'}
                  </Button>
                </DialogFooter>
              </form>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-orange-600" aria-hidden="true" />
                  Confirm identity changes
                </DialogTitle>
                <DialogDescription>
                  Review the changes below. Identity edits are logged for audit with the reason you
                  provided.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <ul className="divide-y rounded-md border">
                  {changedFields.map((c) => (
                    <li key={c.key} className="grid grid-cols-[7rem_1fr] gap-2 px-3 py-2.5 text-sm">
                      <span className="font-medium text-muted-foreground">
                        {FIELD_LABEL[c.key]}
                      </span>
                      <span className="min-w-0">
                        <span className="text-muted-foreground line-through">
                          {displayValue(c.key, c.old)}
                        </span>
                        <span className="mx-1.5 text-muted-foreground" aria-hidden="true">
                          →
                        </span>
                        <span className="font-medium text-foreground">
                          {displayValue(c.key, c.next)}
                        </span>
                      </span>
                    </li>
                  ))}
                  {whatsappChanged && (
                    <li className="grid grid-cols-[7rem_1fr] gap-2 px-3 py-2.5 text-sm">
                      <span className="font-medium text-muted-foreground">WhatsApp</span>
                      <span>
                        <span className="text-muted-foreground line-through">
                          {initialData.whatsappOptIn ? 'On' : 'Off'}
                        </span>
                        <span className="mx-1.5 text-muted-foreground" aria-hidden="true">
                          →
                        </span>
                        <span className="font-medium text-foreground">
                          {formData.whatsappOptIn ? 'On' : 'Off'}
                        </span>
                      </span>
                    </li>
                  )}
                </ul>

                <div className="rounded-md border border-orange-200 bg-orange-50 p-3">
                  <p className="text-xs font-medium text-orange-700">Reason for change</p>
                  <p className="mt-1 text-sm text-foreground">{formData.changeReason.trim()}</p>
                </div>
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setStep('form')}
                  disabled={loading}
                >
                  <ArrowLeft className="mr-1 h-4 w-4" />
                  Back
                </Button>
                <Button type="button" onClick={() => void persist()} disabled={loading}>
                  {loading ? 'Saving…' : 'Confirm & Save'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
