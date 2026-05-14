import { useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { API_BASE } from '@/lib/api';
import {
  RichTextSurface,
  type RichTextSurfaceHandle,
  type ToolbarState,
  DEFAULT_TOOLBAR_STATE,
} from './RichTextSurface';
import { RichTextToolbar } from './RichTextToolbar';
import '@/styles/report-frame.css';

export interface FramedPatient {
  name: string;
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

export interface FramedSignature {
  name: string;
  degrees: string;
  designation: string;
  registrationNumber?: string | null;
  signatureImageBase64?: string | null;
  signatureImagePath?: string | null;
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
  /** Signing rule for this department — drives the sign-off block at the
   *  bottom of the framed page. When omitted, a generic placeholder is shown
   *  so the layout still matches the printed report. */
  signature?: FramedSignature | null;
  /** Fires the first time the editor gains focus. The parent uses this as a
   *  proxy for "the radiologist actually touched this report" so the partial-
   *  release dialog can default-uncheck untouched template-only narratives. */
  onFirstTouch?: () => void;
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
  signature,
  onFirstTouch,
}: ReportFramedNarrativeEditorProps) {
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
                    <span className="value">{patient.name || DASH}</span>
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

            {(() => {
              // Sign-off block: image when we have one, doctor details when we
              // have a configured signing rule, or a generic placeholder so the
              // layout still matches the printed report's footer reservation.
              const sigImg =
                signature?.signatureImageBase64
                  ? signature.signatureImageBase64
                  : signature?.signatureImagePath
                  ? `${API_BASE.replace(/\/api$/, '')}${signature.signatureImagePath}`
                  : null;
              const designation = signature?.designation || 'Consultant';
              return (
                <div className="report-signature">
                  <div className="report-signature-block">
                    {sigImg ? (
                      <img
                        src={sigImg}
                        alt="Signature"
                        className="report-signature-image"
                      />
                    ) : (
                      <div className="report-signature-line" />
                    )}
                    {signature?.name && (
                      <div className="report-signature-name">{signature.name}</div>
                    )}
                    {signature?.degrees && (
                      <div className="report-signature-degrees">
                        {signature.degrees}
                      </div>
                    )}
                    <div className="report-signature-designation">
                      {designation}
                    </div>
                    {signature?.registrationNumber && (
                      <div className="report-signature-reg">
                        Reg. No: {signature.registrationNumber}
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}
