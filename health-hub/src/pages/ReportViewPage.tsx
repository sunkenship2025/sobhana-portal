import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Loader2, AlertTriangle, CheckCircle2, Lock, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const API_BASE = 'http://localhost:3000/api';

interface ReportData {
  reportVersion: {
    id: string;
    versionNum: number;
    status: string;
    finalizedAt: string | null;
    testResults: Array<{
      id: string;
      testOrderId: string;
      value: number | null;
      flag: string | null;
      notes: string | null;
    }>;
  };
  visit: {
    id: string;
    billNumber: string;
    status: string;
    createdAt: string;
    totalAmount: number;
    domain: string;
  };
  patient: {
    name: string;
    age: number;
    gender: string;
    phone: string;
  };
  testOrders: Array<{
    id: string;
    testId: string;
    testName: string;
    testCode: string;
    referenceRange: {
      min: number;
      max: number;
      unit: string;
    };
  }>;
  referralDoctor: {
    name: string;
  } | null;
  branch: {
    name: string;
    code: string;
  };
}

export default function ReportViewPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  
  const [reportData, setReportData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (token) {
      fetchReportData();
    } else {
      setError('No access token provided');
      setLoading(false);
    }
  }, [token]);

  const fetchReportData = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_BASE}/reports/view?token=${token}`);

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('Invalid or expired access link. Please request a new link.');
        }
        if (response.status === 404) {
          throw new Error('Report not found');
        }
        throw new Error('Failed to load report');
      }

      const data = await response.json();
      setReportData(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Loading secure report...</p>
      </div>
    );
  }

  if (error || !reportData) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4">
        <AlertTriangle className="h-12 w-12 text-destructive" />
        <p className="text-lg font-medium">Unable to load report</p>
        <p className="text-sm text-muted-foreground max-w-md text-center">{error}</p>
        <Button variant="outline" onClick={() => window.close()}>
          Close Window
        </Button>
      </div>
    );
  }

  const { reportVersion, visit, patient, testOrders, referralDoctor, branch } = reportData;

  return (
    <>
      {/* Action Bar (hidden on print) */}
      <div className="no-print sticky top-0 bg-background border-b p-4 z-50">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Lock className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Secure Time-Limited Access</span>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="gap-1">
              <CheckCircle2 className="h-3 w-3" />
              Finalized
            </Badge>
            <Button onClick={() => window.print()}>
              <Printer className="h-4 w-4 mr-2" />
              Print
            </Button>
          </div>
        </div>
      </div>

      {/* Report Content */}
      <div className="print-content max-w-4xl mx-auto p-8 bg-white text-black">
        {/* Header */}
        <div className="text-center border-b-2 border-black pb-4 mb-6">
          <h1 className="text-2xl font-bold">DIAGNOSTIC LAB REPORT</h1>
          <p className="text-sm mt-1">{branch.name}</p>
        </div>

        {/* Report Info */}
        <div className="grid grid-cols-2 gap-4 mb-6 text-sm">
          <div>
            <p><strong>Bill Number:</strong> {visit.billNumber}</p>
            <p><strong>Report Date:</strong> {new Date(reportVersion.finalizedAt!).toLocaleDateString('en-IN', {
              day: '2-digit',
              month: 'short',
              year: 'numeric',
            })}</p>
          </div>
          <div className="text-right">
            <p><strong>Version:</strong> v{reportVersion.versionNum}</p>
            <p><strong>Status:</strong> {reportVersion.status}</p>
          </div>
        </div>

        {/* Patient Information */}
        <div className="border border-black p-4 mb-6">
          <h2 className="font-bold mb-3">Patient Information</h2>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p><strong>Name:</strong> {patient.name}</p>
              <p><strong>Age/Gender:</strong> {patient.age} years / {patient.gender === 'M' ? 'Male' : patient.gender === 'F' ? 'Female' : 'Other'}</p>
            </div>
            <div>
              <p><strong>Phone:</strong> {patient.phone}</p>
              {referralDoctor && <p><strong>Referred By:</strong> {referralDoctor.name}</p>}
            </div>
          </div>
        </div>

        {/* Test Results Table */}
        <div className="mb-6">
          <h2 className="font-bold mb-3">Test Results</h2>
          <table className="w-full border-collapse border border-black">
            <thead>
              <tr className="bg-gray-100">
                <th className="border border-black p-2 text-left">Test Name</th>
                <th className="border border-black p-2 text-center">Result</th>
                <th className="border border-black p-2 text-center">Reference Range</th>
                <th className="border border-black p-2 text-center">Flag</th>
              </tr>
            </thead>
            <tbody>
              {testOrders.map((test) => {
                const result = reportVersion.testResults.find((r) => r.testOrderId === test.id);
                const hasFlag = result?.flag && result.flag !== 'NORMAL';

                return (
                  <tr key={test.id} className={hasFlag ? 'bg-yellow-50' : ''}>
                    <td className="border border-black p-2">
                      <div>
                        <div className="font-medium">{test.testName}</div>
                        <div className="text-xs text-gray-600">{test.testCode}</div>
                      </div>
                    </td>
                    <td className="border border-black p-2 text-center font-medium">
                      {result?.value !== null ? result.value : '—'}
                    </td>
                    <td className="border border-black p-2 text-center text-sm">
                      {test.referenceRange.min} - {test.referenceRange.max} {test.referenceRange.unit}
                    </td>
                    <td className="border border-black p-2 text-center">
                      {hasFlag && result.flag ? (
                        <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">
                          {result.flag}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Notes */}
        {reportVersion.testResults.some((r) => r.notes) && (
          <div className="mb-6">
            <h2 className="font-bold mb-2">Notes</h2>
            <div className="border border-gray-300 rounded p-3 bg-gray-50 text-sm space-y-2">
              {reportVersion.testResults
                .filter((r) => r.notes)
                .map((r) => {
                  const test = testOrders.find((t) => t.testId === r.testId);
                  return (
                    <p key={r.id}>
                      <strong>{test?.testName}:</strong> {r.notes}
                    </p>
                  );
                })}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="text-center text-xs mt-8 pt-4 border-t border-black text-gray-600">
          <p>* This is a finalized lab report *</p>
          <p className="mt-1">Report generated on {new Date(reportVersion.finalizedAt!).toLocaleString('en-IN')}</p>
        </div>
      </div>

      <style>{`
        @media print {
          .no-print {
            display: none !important;
          }
          body {
            margin: 0;
            padding: 0;
          }
          .print-content {
            max-width: 100%;
            padding: 20mm;
          }
        }
      `}</style>
    </>
  );
}
