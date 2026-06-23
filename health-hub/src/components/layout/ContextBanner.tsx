import { BranchSelector } from './BranchSelector';

export function ContextBanner() {
  // The BranchSelector trigger (with its Building2 icon) is the single source of
  // truth for the active branch — no static "Branch: <name>" label beside it, or
  // the name would render twice. The freed left side is reserved for breadcrumb
  // / page wayfinding (see the subContext prop wiring).
  return (
    <div className="context-banner flex flex-col items-start gap-3 py-3 sm:flex-row sm:items-center sm:justify-end">
      <div className="w-full sm:w-auto">
        <BranchSelector />
      </div>
    </div>
  );
}
