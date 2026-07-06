import { useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  RichTextSurface,
  type RichTextSurfaceHandle,
  type ToolbarState,
  DEFAULT_TOOLBAR_STATE,
} from './RichTextSurface';
import { RichTextToolbar } from './RichTextToolbar';
import '@/styles/report-frame.css';
import { formatPatientName } from '@/lib/patientDisplay';

export interface FramedPatient {
  name: string;
  title?: string | null;
  ageDisplay?: string;
  gender?: string;
  patientNumber?: string;
}

export interface FramedVisit {
  billNumber: string;
  createdAt?: string;
  collectedAt?: string | null;
  reportedAt?: string | null;
  sampleType?: string | null;
}

interface ReportFramedNarrativeEditorProps {
  value: string;
  onChange: (value: string) => void;
  patient: FramedPatient;
  visit: FramedVisit;
  departmentName: string;
  panelDisplayName: string;
  testCode?: string;
  placeholder?: string;
  /** Per-report signer name override the radiologist types into the "Doctor's
   *  Name" input below the framed editor. When non-empty, the editor renders
   *  the name above the department designation inside the framed preview,
   *  matching how the final PDF prints it. */
  signerName?: string;
  onSignerNameChange?: (value: string) => void;
  /** When true, the input is disabled — used when a SigningRule is configured
   *  for the department (the rule is the source of truth, the per-report
   *  override is suppressed). */
  signerLocked?: boolean;
  /** Helper text shown beneath the locked input explaining why it's disabled
   *  and what to do to re-enable it. */
  signerLockedReason?: string;
  /** When true (the department has a SigningRule), show a checkbox to sign with
   *  the configured signing doctor instead of the typed name + consultant. */
  showSigningRuleToggle?: boolean;
  /** When true, sign with the department's SigningRule — the Doctor's Name box
   *  is hidden and the typed name is not used for this report. */
  useSigningRule?: boolean;
  onUseSigningRuleChange?: (value: boolean) => void;
  /** Fires the first time the editor gains focus. The parent uses this as a
   *  proxy for "the radiologist actually touched this report" so the partial-
   *  release dialog can default-uncheck untouched template-only narratives. */
  onFirstTouch?: () => void;
}

/**
 * Derives the placeholder designation for a department (mirrors the backend's
 * deriveConsultantTitle in reportSnapshotService.ts so the on-screen preview
 * matches what the final PDF will print).
 */
function deriveConsultantTitle(departmentName: string): string {
  const lower = (departmentName || '').toLowerCase().trim();
  if (!lower) return 'Consultant';
  if (lower.endsWith('ology')) {
    const stem = lower.slice(0, -5);
    return `Consultant ${stem.charAt(0).toUpperCase()}${stem.slice(1)}ologist`;
  }
  if (lower.endsWith('istry')) {
    const stem = lower.slice(0, -3);
    return `Consultant ${stem.charAt(0).toUpperCase()}${stem.slice(1)}ist`;
  }
  const titled = lower.replace(/\b\w/g, (c) => c.toUpperCase());
  return `Consultant ${titled}`;
}

const DASH = '—';

function formatDateTime(value?: string | null): string {
  if (!value) return DASH;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return DASH;
  // Match the report PDF format: "05 May 2026 22:37"
  const day = String(date.getDate()).padStart(2, '0');
  const month = date.toLocaleString('en-US', { month: 'short' });
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${day} ${month} ${year} ${hours}:${minutes}`;
}

function formatGender(gender?: string): string {
  if (!gender) return DASH;
  if (gender === 'M') return 'Male';
  if (gender === 'F') return 'Female';
  if (gender === 'O') return 'Other';
  return gender;
}

export function ReportFramedNarrativeEditor({
  value,
  onChange,
  patient,
  visit,
  departmentName,
  panelDisplayName,
  testCode,
  placeholder = 'Start writing the narrative report...',
  signerName,
  onSignerNameChange,
  showSigningRuleToggle = false,
  useSigningRule = false,
  onUseSigningRuleChange,
  onFirstTouch,
}: ReportFramedNarrativeEditorProps) {
  const designation = deriveConsultantTitle(departmentName);
  const trimmedSigner = (signerName ?? '').trim();
  const surfaceRef = useRef<RichTextSurfaceHandle>(null);
  const [toolbarState, setToolbarState] = useState<ToolbarState>(DEFAULT_TOOLBAR_STATE);
  // Toolbar is muted (semi-transparent) until the editor underneath it has
  // focus — small visual hint that buttons only do something when the
  // cursor is in this report's narrative area.
  const [isActive, setIsActive] = useState(false);
  // Fire `onFirstTouch` exactly once per editor lifetime when the user first
  // focuses the narrative area. A ref guards re-firing — focus/blur cycle
  // many times during normal use.
  const firstTouchFiredRef = useRef(false);

  return (
    <div className="space-y-2">
      <RichTextToolbar
        state={toolbarState}
        active={isActive}
        onCommand={(command, valueArg) => surfaceRef.current?.runCommand(command, valueArg)}
      />

      <div className="report-frame-scope">
        <div className="report-frame-page">
          <header className="header">
            <div className="header-logo-row">
              <img
                src="/sobhana-logo-cropped.png"
                alt="Sobhana Diagnostic Centre"
                className="header-logo"
              />
            </div>
            <div className="header-stripe-band">
              <div></div>
              <div></div>
              <div></div>
            </div>
            <div className="report-badge-row">
              <span className="report-badge">REPORT</span>
            </div>
          </header>

          <div className="report-frame-content">
            <section className="patient-info">
              <div className="info-grid">
                <div className="info-row">
                  <div className="info-item">
                    <span className="label">Patient Name</span>
                    <span className="value">{formatPatientName(patient.name || DASH, patient.title)}</span>
                  </div>
                  <div className="info-item">
                    <span className="label">Bill No</span>
                    <span className="value">{visit.billNumber || DASH}</span>
                  </div>
                </div>
                <div className="info-row">
                  <div className="info-item">
                    <span className="label">Age / Gender</span>
                    <span className="value">
                      {patient.ageDisplay || DASH} / {formatGender(patient.gender)}
                    </span>
                  </div>
                  <div className="info-item">
                    <span className="label">Patient ID</span>
                    <span className="value">{patient.patientNumber || DASH}</span>
                  </div>
                </div>
                <div className="info-row">
                  <div className="info-item">
                    <span className="label">Sample Type</span>
                    <span className="value">{visit.sampleType || DASH}</span>
                  </div>
                  <div className="info-item">
                    <span className="label">Registered On</span>
                    <span className="value">{formatDateTime(visit.createdAt)}</span>
                  </div>
                </div>
                <div className="info-row">
                  <div className="info-item">
                    <span className="label">Collected On</span>
                    <span className="value">
                      {formatDateTime(visit.collectedAt || visit.createdAt)}
                    </span>
                  </div>
                  <div className="info-item">
                    <span className="label">Reported On</span>
                    <span className="value">{formatDateTime(visit.reportedAt)}</span>
                  </div>
                </div>
              </div>
            </section>

            <div className="department-header">
              DEPARTMENT OF {departmentName.toUpperCase()}
            </div>

            <div className="panel-title">
              {panelDisplayName}
              {testCode && testCode !== panelDisplayName ? (
                <span className="ml-2 text-[8pt] font-normal opacity-70">({testCode})</span>
              ) : null}
            </div>

            <RichTextSurface
              ref={surfaceRef}
              value={value}
              onChange={onChange}
              placeholder={placeholder}
              contentClassName={cn('imaging-narrative')}
              onToolbarStateChange={setToolbarState}
              onActiveChange={(active) => {
                setIsActive(active);
                if (active && !firstTouchFiredRef.current) {
                  firstTouchFiredRef.current = true;
                  onFirstTouch?.();
                }
              }}
            />

            <div className="report-note">
              Note: Please correlate clinically if necessary.
            </div>

            <div className="report-sign-block">
              {!useSigningRule && trimmedSigner && (
                <div className="report-sign-name">{trimmedSigner}</div>
              )}
              <div className="report-sign-designation">{designation}</div>
            </div>
          </div>
        </div>
      </div>

      {onSignerNameChange && (
        <div className="report-sign-input-wrapper">
          {showSigningRuleToggle && (
            <label className="report-sign-toggle-row">
              <input
                type="checkbox"
                checked={useSigningRule}
                onChange={(e) => onUseSigningRuleChange?.(e.target.checked)}
              />
              <span className="report-sign-input-label">
                Sign with the department&apos;s signing doctor
              </span>
            </label>
          )}
          {!useSigningRule && (
            <label className="report-sign-input-row">
              <span className="report-sign-input-label">Doctor&apos;s Name</span>
              <input
                type="text"
                value={signerName ?? ''}
                onChange={(e) => onSignerNameChange(e.target.value)}
                placeholder={`e.g. Dr. ABC ${designation.replace(/^Consultant\s+/i, '')}`}
                className="report-sign-input"
              />
            </label>
          )}
        </div>
      )}
    </div>
  );
}
