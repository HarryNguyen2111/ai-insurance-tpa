import { parseCoreApiOrigin } from '@/lib/core-api-config';
import { checkCoreApiHealth } from '@/lib/core-api-health';

// Same-origin liveness probe. Deliberately takes no input from the request: the
// target is the fixed server-side origin + fixed /health path. Only GET is
// exported, so Next answers other methods with 405.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const report = await checkCoreApiHealth(parseCoreApiOrigin(process.env.CORE_API_INTERNAL_URL));
  return Response.json(report, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}
