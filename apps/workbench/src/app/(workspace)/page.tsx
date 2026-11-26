import { Suspense } from 'react';
import { WorkspaceOverview } from '@/components/workspace-overview';

export default function OverviewPage() {
  return (
    <Suspense>
      <WorkspaceOverview />
    </Suspense>
  );
}
