/**
 * The digital letterpad — 1:1 with what the patient receives.
 *
 * WHY A DIGITAL LETTERHEAD EXISTS AT ALL
 * The portal's existing Rx sheet renders NO header: it prints onto pre-printed
 * paper, so drawing one would double it. That is right for the printer and wrong
 * for everything else — the PDF sent over WhatsApp, the patient's link, the copy
 * a pharmacist is shown. Those have no paper behind them, and a prescription with
 * no clinic name and no registration number is not a valid prescription under
 * Telemedicine Practice Guidelines §3.2.5.
 *
 * So, like reports, prescriptions get profiles:
 *   digital  — full letterpad, drawn by us
 *   physical — body only; the paper carries the header and footer
 *
 * Renders from the frozen `snapshot` when signed, and from live data while a
 * draft is being written. That is the whole immutability story in one prop.
 */
import { cn } from '@/lib/utils';
import { itemSig, itemTitle, type PrescriptionSnapshot, type RxItem } from '@/lib/doctorApi';

export type RxProfile = 'digital' | 'physical';

export interface LetterpadProps {
  profile: RxProfile;
  items: RxItem[];
  diagnosis?: string | null;
  notes?: string | null;
  followUpDays?: number | null;
  /** Present once signed — everything renders from here, forever. */
  snapshot?: PrescriptionSnapshot | null;
  /** Live values used only while the prescription is still a draft. */
  live?: {
    doctor: { name: string; qualification: string; specialty: string; registrationNumber: string; letterheadNote?: string | null };
    branch?: { name: string; address?: string | null; phone?: string | null };
    patient: { name: string; ageLabel: string; gender: string; patientNumber: string };
    visit?: { visitType?: string | null; tokenNumber?: number | null; date?: string };
  };
  /** Draft preview: click a line to edit it in place. */
  selectedItemId?: string | null;
  onSelectItem?: (id: string | undefined) => void;
  className?: string;
}

const field = (label: string, value: string | null | undefined) => (
  <div className="flex gap-1.5">
    <span className="shrink-0 text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
    <span className="min-w-0 truncate text-[11px] font-semibold text-slate-900">{value || '—'}</span>
  </div>
);

export function RxLetterpad({
  profile, items, diagnosis, notes, followUpDays, snapshot, live,
  selectedItemId, onSelectItem, className,
}: LetterpadProps) {
  const doctor = snapshot?.doctor ?? live?.doctor;
  const branch = snapshot?.branch ?? live?.branch;
  const patient = snapshot?.patient ?? live?.patient;
  const visit = snapshot?.visit ?? live?.visit;
  const signed = !!snapshot;
  const physical = profile === 'physical';

  const dateLabel = visit?.date
    ? new Date(visit.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <div
      className={cn(
        'mx-auto w-full max-w-[720px] bg-white px-6 py-5 text-slate-900 shadow-sm ring-1 ring-slate-200 print:shadow-none print:ring-0',
        className,
      )}
      // Tabular figures: a column of strengths and durations must be scannable
      // for magnitude, and proportional digits do not align.
      style={{ fontVariantNumeric: 'tabular-nums' }}
    >
      {/* Masthead. Same mark the reports and the waiting-room screen use, so the
          patient recognises the sheet — but named SOBHANA CLINIC, because this is
          the consulting side, not the lab.

          The logo sits on white and the name sits on the blue: the mark is red
          and navy artwork, and laying it directly on #1f3e6e would sink it into
          the band. Ghosted on the physical profile with the rest of the header —
          pre-printed paper already carries all of this. */}
      <div
        className={cn(
          'mb-2.5',
          physical && 'opacity-30 outline-dashed outline-1 outline-offset-4 outline-amber-500 print:hidden',
        )}
      >
        <div className="flex items-center justify-center pb-2">
          <img
            src="/sobhana-logo-cropped.png"
            alt="Sobhana"
            className="h-9 w-auto"
            // A letterhead that reflows when the logo 404s is worse than one
            // without it; the blue band below still names the clinic.
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
        </div>
        <div
          className="rounded-[2px] px-3 py-1.5 text-center text-[13px] font-bold uppercase tracking-[0.22em] text-white"
          style={{ backgroundColor: '#1f3e6e' }}
        >
          Sobhana Clinic
        </div>
      </div>

      {/* Header. Suppressed on the physical profile because the paper carries it —
          shown ghosted in preview so the doctor can see what the printer omits. */}
      <div
        className={cn(
          'flex items-start justify-between gap-4 border-b-2 pb-2.5',
          physical && 'opacity-30 outline-dashed outline-1 outline-offset-4 outline-amber-500 print:hidden',
        )}
        style={{ borderBottomColor: '#1f3e6e' }}
      >
        {/* The prescriber's name is the most important thing in this header, so
            it gets the width. The branch block used to be shrink-0, and a long
            address (Chintal's is one line of 90 characters) crushed the name onto
            three lines: "Dr. / SURENDER / SINGH". */}
        <div className="min-w-0 flex-1">
          <p className="text-[17px] font-bold leading-tight text-slate-900">{doctor?.name ?? 'Consulting doctor'}</p>
          <p className="text-[11px] text-slate-600">{doctor?.qualification}</p>
          <p className="text-[11px] text-slate-600">
            {doctor?.specialty}
            {doctor?.registrationNumber ? (
              <>
                {' · '}
                {/* Mandatory on the sheet AND on the message that carries it. */}
                <span className="font-semibold text-slate-800">Reg. No. {doctor.registrationNumber}</span>
              </>
            ) : null}
          </p>
        </div>
        <div className="max-w-[50%] text-right text-[11px] leading-snug text-slate-600">
          <p className="text-[13px] font-bold text-slate-900">{branch?.name ?? ''}</p>
          {branch?.address && <p>{branch.address}</p>}
          {branch?.phone && <p>{branch.phone}</p>}
          {(snapshot?.doctor.letterheadNote ?? live?.doctor.letterheadNote) && (
            <p>{snapshot?.doctor.letterheadNote ?? live?.doctor.letterheadNote}</p>
          )}
        </div>
      </div>

      {/* Patient box — rendered content in EVERY profile, because it is the only
          place that survives onto pre-printed paper. Reports learned this too. */}
      <div className="grid grid-cols-2 gap-x-8 gap-y-1 border-b border-dashed border-slate-300 py-2.5">
        {field('Patient', patient?.name)}
        {field('Date', dateLabel)}
        {field('Age / Sex', patient ? `${patient.ageLabel} / ${patient.gender}` : null)}
        {field('Visit', visit?.visitType ? `${visit.visitType}${visit.tokenNumber ? ` · Token ${visit.tokenNumber}` : ''}` : '—')}
        {field('Patient ID', patient?.patientNumber)}
        {field('Reg. No.', doctor?.registrationNumber)}
      </div>

      {diagnosis && (
        <p className="pt-2.5 text-[12px]">
          <span className="text-[10px] uppercase tracking-wide text-slate-500">Diagnosis </span>
          <span className="font-semibold">{diagnosis}</span>
        </p>
      )}

      <p className="mt-2 text-[22px] font-bold leading-none text-slate-800">℞</p>

      <ol className="mt-2 space-y-0.5">
        {items.length === 0 && (
          <li className="py-3 text-[12px] italic text-slate-400">No medicines yet.</li>
        )}
        {items.map((it, i) => {
          const selectable = !signed && !!onSelectItem;
          const selected = selectedItemId && it.id === selectedItemId;
          return (
            <li key={it.id ?? i}>
              <button
                type="button"
                disabled={!selectable}
                onClick={() => onSelectItem?.(selected ? undefined : it.id)}
                className={cn(
                  'w-full rounded-md border border-transparent px-2 py-1.5 text-left transition-colors',
                  selectable && 'hover:border-sky-200 hover:bg-sky-50/60',
                  selected && 'border-sky-400 bg-sky-50 ring-2 ring-sky-200',
                  !selectable && 'cursor-default',
                )}
              >
                <p className="text-[13px] font-semibold">
                  {i + 1}. {itemTitle(it)}
                  {it.dosageForm ? <span className="font-normal text-slate-600"> — {it.dosageForm}</span> : null}
                </p>
                <p className="text-[12px] text-slate-700">{itemSig(it) || <span className="italic text-slate-400">no instructions</span>}</p>
                {/* The doctor said a brand; the record carries the molecule AND the
                    words, so a later reader can tell normalisation from dictation. */}
                {it.spokenText && it.spokenText.toLowerCase() !== it.canonicalName.toLowerCase() && (
                  <p className="text-[10.5px] italic text-slate-400">spoken as “{it.spokenText}”</p>
                )}
                {it.instructions && <p className="text-[11px] text-slate-600">{it.instructions}</p>}
              </button>
            </li>
          );
        })}
      </ol>

      {(followUpDays != null || notes) && (
        <div className="mt-3 space-y-0.5 border-t border-slate-200 pt-2 text-[12px]">
          {followUpDays != null && <p><span className="font-semibold">Follow-up:</span> after {followUpDays} days</p>}
          {notes && <p className="text-slate-700">{notes}</p>}
        </div>
      )}

      {/* Signature. Empty until signed — a preview showing a signature the doctor
          has not yet given is the wrong thing to put on screen. */}
      <div className="mt-6 flex justify-end">
        <div className="text-center text-[11px] text-slate-600">
          {signed && snapshot?.doctor.signatureImageBase64 ? (
            <img
              src={snapshot.doctor.signatureImageBase64}
              alt={`Signature of ${snapshot.doctor.name}`}
              className="mx-auto mb-1 h-11 w-auto object-contain"
            />
          ) : (
            <div className="mx-auto mb-1 h-11 w-32 border-b border-slate-400" aria-hidden="true" />
          )}
          <p className="font-semibold text-slate-900">{doctor?.name}</p>
          <p>{doctor?.qualification}{doctor?.registrationNumber ? ` · Reg. ${doctor.registrationNumber}` : ''}</p>
          {signed && snapshot && (
            <p className="mt-0.5 text-[10px] text-slate-500">
              Digitally signed · {new Date(snapshot.signedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
            </p>
          )}
        </div>
      </div>

      <p
        className={cn(
          'mt-3 border-t border-slate-200 pt-1.5 text-center text-[9.5px] text-slate-500',
          // print:hidden with the rest of the ghosted header furniture. Without it
          // the words "Footer pre-printed on the letterhead" — a note to the doctor
          // about what the PAPER carries — print onto the paper that carries it.
          physical && 'opacity-30 outline-dashed outline-1 outline-offset-2 outline-amber-500 print:hidden',
        )}
      >
        {physical
          ? 'Footer pre-printed on the letterhead'
          : `Issued digitally by ${branch?.name ?? 'the clinic'}${branch?.address ? `, ${branch.address}` : ''}`}
      </p>
    </div>
  );
}
