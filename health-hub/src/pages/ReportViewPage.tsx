import { useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { API_BASE_URL } from '@/lib/api';

export default function ReportViewPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const redirectUrl = useMemo(() => {
    if (!token) {
      return null;
    }

    return `${API_BASE_URL}/reports/${encodeURIComponent(token)}`;
  }, [token]);

  useEffect(() => {
    if (redirectUrl) {
      window.location.replace(redirectUrl);
    }
  }, [redirectUrl]);

  if (!redirectUrl) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
        <AlertTriangle className="h-12 w-12 text-destructive" />
        <p className="text-lg font-medium">Unable to open report</p>
        <p className="max-w-md text-sm text-muted-foreground">
          The report link is missing its access token. Please request a new report link.
        </p>
        <Button variant="outline" onClick={() => window.close()}>
          Close Window
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
      <p className="text-sm text-muted-foreground">Opening your report...</p>
    </div>
  );
}
