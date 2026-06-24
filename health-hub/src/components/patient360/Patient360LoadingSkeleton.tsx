/**
 * Patient360LoadingSkeleton — structural skeleton for the detail page (§6).
 * Header bar + 3 glance cells + 3 timeline rows. No bare spinner.
 */
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function Patient360LoadingSkeleton() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Skeleton className="h-8 w-16" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-3 w-64" />
        </div>
        <Skeleton className="h-9 w-20" />
      </div>

      {/* Glance */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} className="space-y-2 p-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-7 w-24" />
          </Card>
        ))}
      </div>

      {/* Timeline rows */}
      <div className="space-y-3">
        <Skeleton className="h-5 w-32" />
        {[0, 1, 2].map((i) => (
          <Card key={i} className="space-y-3 p-4">
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-4 w-20" />
            </div>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
          </Card>
        ))}
      </div>
    </div>
  );
}
