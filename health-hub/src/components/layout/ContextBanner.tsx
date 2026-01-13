import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import type { AppContext } from '@/types';
import { useBranchStore } from '@/store/branchStore';
import { BranchSelector } from './BranchSelector';
import { GlobalPatientSearch, PatientSearchTrigger } from '@/components/patient360';

interface ContextBannerProps {
  context: AppContext;
  subContext?: string;
}

const contextConfig: Record<AppContext, { label: string; className: string }> = {
  dashboard: { label: 'Dashboard', className: 'context-banner-diagnostics' },
  diagnostics: { label: 'Diagnostics', className: 'context-banner-diagnostics' },
  clinic: { label: 'Clinic', className: 'context-banner-clinic' },
  doctor: { label: 'Doctor', className: 'context-banner-doctor' },
  owner: { label: 'Owner', className: 'context-banner-owner' },
};

export function ContextBanner({ context, subContext }: ContextBannerProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const config = contextConfig[context];
  const { getActiveBranch } = useBranchStore();
  const activeBranch = getActiveBranch();

  // Keyboard shortcut for search (Cmd+K / Ctrl+K)
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, []);
  
  return (
    <>
      <div className={cn('context-banner', config.className, 'flex items-center justify-between')}>
        <div className="flex items-center gap-4">
          <div>
            <span className="font-semibold">Branch:</span>{' '}
            <span className="opacity-90">{activeBranch?.name || 'Not Selected'}</span>
          </div>
          <span className="opacity-50">|</span>
          <div>
            <span className="font-semibold">Context:</span>{' '}
            {config.label}
            {subContext && <span className="opacity-90"> — {subContext}</span>}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Global Patient Search */}
          <PatientSearchTrigger onClick={() => setSearchOpen(true)} />
          <BranchSelector />
        </div>
      </div>
      
      {/* Global Patient Search Dialog */}
      <GlobalPatientSearch open={searchOpen} onOpenChange={setSearchOpen} />
    </>
  );
}
