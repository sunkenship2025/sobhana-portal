import { useRef } from 'react';
import { cn } from '@/lib/utils';
import {
  RichTextSurface,
  type RichTextSurfaceHandle,
  type ToolbarState,
} from './RichTextSurface';
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

interface ReportFramedNarrativeEditorProps {
  value: string;
  onChange: (value: string) => void;
  patient: FramedPatient;
  visit: FramedVisit;
  departmentName: string;
  panelDisplayName: string;
  testCode?: string;
  placeholder?: string;
  /** Called whenever this editor's selection state changes. The parent uses it to drive the shared toolbar when this editor is active. */
  onSurfaceStateChange?: (state: ToolbarState) => void;
  /** Called when the editor becomes the focused/active surface so the parent can route toolbar commands here. */
  onActivate?: (handle: RichTextSurfaceHandle) => void;
  /** Called on blur. */
  onDeactivate?: () => void;
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
  onSurfaceStateChange,
  onActivate,
  onDeactivate,
}: ReportFramedNarrativeEditorProps) {
  const surfaceRef = useRef<RichTextSurfaceHandle>(null);

  const handleActiveChange = (active: boolean) => {
    if (active) {
      if (surfaceRef.current) onActivate?.(surfaceRef.current);
    } else {
      onDeactivate?.();
    }
  };

  return (
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
            onToolbarStateChange={onSurfaceStateChange}
            onActiveChange={handleActiveChange}
          />

          <div className="report-note">
            Note: Please correlate clinically if necessary.
          </div>
        </div>
      </div>
    </div>
  );
}
