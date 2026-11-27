import { WorkflowDesigner } from '@/components/workflow-designer';

export const metadata = { title: 'Thiết kế quy trình — TPA' };
export const dynamic = 'force-dynamic';

export default function WorkflowDesignerPage() {
  // Read at request time: Next inlines direct NODE_ENV accesses during its optimized build.
  const environment = process.env;
  return <WorkflowDesigner allowSyntheticSession={Reflect.get(environment, 'NODE_ENV') !== 'production' && environment.WORKBENCH_SYNTHETIC_AUTH === '1'} />;
}
