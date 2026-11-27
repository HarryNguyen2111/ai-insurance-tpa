import { parseCoreApiOrigin } from '@/lib/core-api-config';
import { MAX_REQUEST_BYTES, boundedRequestBody, forwardWorkflowRequest } from '@/lib/workflow-proxy';

// Same-origin bridge to the #80/#21 APIs. Allowlisted paths/headers only (see workflow-proxy.ts);
// core-api remains the sole authority for identity, membership, role, MFA and maker-checker.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(request: Request, params: Promise<{ path: string[] }>): Promise<Response> {
  const { path } = await params;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(declared) || declared > MAX_REQUEST_BYTES) {
    return Response.json({ code: 'BFF_BODY_TOO_LARGE', messageVi: 'Yêu cầu quá lớn.' }, { status: 413, headers: { 'Cache-Control': 'no-store' } });
  }
  const url = new URL(request.url);
  let body: string | null;
  try { body = request.method === 'GET' ? '' : await boundedRequestBody(request); }
  catch { return Response.json({ code: 'BFF_BAD_BODY' }, { status: 400, headers: { 'Cache-Control': 'no-store' } }); }
  if (body === null) return Response.json({ code: 'BFF_BODY_TOO_LARGE' }, { status: 413, headers: { 'Cache-Control': 'no-store' } });
  return forwardWorkflowRequest(parseCoreApiOrigin(process.env.CORE_API_INTERNAL_URL), {
    method: request.method, segments: path, search: url.searchParams, headers: request.headers, body,
  });
}

type Context = { params: Promise<{ path: string[] }> };
export function GET(request: Request, context: Context) { return handle(request, context.params); }
export function POST(request: Request, context: Context) { return handle(request, context.params); }
export function PUT(request: Request, context: Context) { return handle(request, context.params); }
