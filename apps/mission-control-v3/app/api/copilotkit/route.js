import {
  assertRateLimit,
  assertRequestBodySize,
  jsonError,
  requireSession,
} from '../../../lib/session.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const session = requireSession(request, { requireCsrf: false });
    assertRateLimit('copilotkit', session.subject, { limit: 60, windowMs: 60_000 });
    assertRequestBodySize(request, 1024 * 1024);
    const kit = await import('@copilotkit/runtime');
    const Runtime = kit.CopilotRuntime;
    const endpointFactory = kit.copilotRuntimeNextJSAppRouterEndpoint;
    if (typeof Runtime !== 'function' || typeof endpointFactory !== 'function') {
      const error = new Error('Installed CopilotKit runtime is incompatible');
      error.status = 503;
      throw error;
    }

    const runtime = new Runtime();
    let serviceAdapter = null;
    const configured = Boolean(process.env.OPENAI_BASE_URL && process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL);
    if (configured && typeof kit.OpenAIAdapter === 'function') {
      const { default: OpenAI } = await import('openai');
      const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        baseURL: process.env.OPENAI_BASE_URL,
      });
      serviceAdapter = new kit.OpenAIAdapter({
        openai,
        model: process.env.OPENAI_MODEL,
      });
    } else if (typeof kit.ExperimentalEmptyAdapter === 'function') {
      serviceAdapter = new kit.ExperimentalEmptyAdapter();
    }

    if (!serviceAdapter) {
      const error = new Error('CopilotKit service adapter is unavailable');
      error.status = 503;
      throw error;
    }

    const endpoint = endpointFactory({
      runtime,
      serviceAdapter,
      endpoint: '/api/copilotkit',
    });
    if (!endpoint || typeof endpoint.handleRequest !== 'function') {
      const error = new Error('CopilotKit endpoint could not be initialized');
      error.status = 503;
      throw error;
    }
    return endpoint.handleRequest(request);
  } catch (error) {
    if (!error?.status) error.status = 503;
    return jsonError(error);
  }
}
