import { lazy, Suspense } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { api, ApiError } from './lib/api';
import Login from './routes/Login';
import Home from './routes/Home';
import Help from './routes/Help';

// pdf.js is heavy — load the document viewer only when a patient opens one.
const DocView = lazy(() => import('./routes/DocView'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
      refetchOnWindowFocus: true,
      staleTime: 30_000,
    },
  },
});

/** Gate protected routes on a live session. 401 → back to the number step. */
function RequireSession() {
  const { isLoading, isError } = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false });
  if (isLoading) {
    return (
      <div className="screen narrow">
        <div className="centerbody" style={{ alignItems: 'center' }}>
          <div className="skel" style={{ width: 160, height: 20, margin: '0 auto' }} />
        </div>
      </div>
    );
  }
  if (isError) return <Navigate to="/" replace />;
  return <Outlet />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Login />} />
          <Route element={<RequireSession />}>
            <Route path="/home" element={<Home />} />
            <Route
              path="/view/:kind/:id"
              element={
                <Suspense fallback={<div className="screen"><div className="pdfstage"><div className="skel" style={{ width: '100%', maxWidth: 820, height: '60vh' }} /></div></div>}>
                  <DocView />
                </Suspense>
              }
            />
            <Route path="/help" element={<Help />} />
          </Route>
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
