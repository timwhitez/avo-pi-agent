import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { authorize, clearSessionResponse, createSessionResponse, jsonError } from "@/lib/security";
import { getMissionControl } from "@/lib/control-plane";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ slug?: string[] }> }) {
  const auth = authorize(request);
  if (!auth.ok) return auth.response;
  const { slug = [] } = await context.params;
  const action = slug.join("/") || "state";
  const control = getMissionControl();

  try {
    if (action === "state") return noStore(control.snapshot());
    if (action === "events") {
      const after = Number(request.nextUrl.searchParams.get("after") || 0);
      const limit = Number(request.nextUrl.searchParams.get("limit") || 500);
      return noStore({ events: control.listEvents(after, limit), state: control.snapshot() });
    }
    if (action === "stream") return streamEvents(request, control);
    if (action === "evolution") {
      return noStore({ evolution: control.readEvolution(request.nextUrl.searchParams.get("game") || undefined) });
    }
    if (action === "findings") {
      return noStore({ findings: control.readFindings(request.nextUrl.searchParams.get("run") || undefined) });
    }
    if (action === "replay") {
      const runId = request.nextUrl.searchParams.get("run");
      if (!runId) return jsonError("run is required", 400);
      return noStore({
        events: control.replay(
          runId,
          request.nextUrl.searchParams.get("game") || undefined,
          Number(request.nextUrl.searchParams.get("after") || 0),
          Number(request.nextUrl.searchParams.get("limit") || 2_000),
        ),
      });
    }
    if (action === "compare") {
      const baseline = request.nextUrl.searchParams.get("baseline");
      const candidate = request.nextUrl.searchParams.get("candidate");
      if (!baseline || !candidate) return jsonError("baseline and candidate are required", 400);
      return noStore({ comparison: control.compare(baseline, candidate) });
    }
    return jsonError("Unknown control endpoint", 404);
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ slug?: string[] }> }) {
  const { slug = [] } = await context.params;
  const action = slug.join("/");
  if (action === "session") {
    if (!sameOrigin(request)) return jsonError("Cross-origin authentication rejected", 403);
    const body = await readJson(request);
    return createSessionResponse(body?.token);
  }
  if (action === "session/logout") {
    const auth = authorize(request, { mutate: true });
    if (!auth.ok) return auth.response;
    return clearSessionResponse();
  }

  const auth = authorize(request, { mutate: true });
  if (!auth.ok) return auth.response;
  const control = getMissionControl();
  try {
    const body = await readJson(request);
    if (action === "start") return noStore({ state: await control.start(body) });
    if (action === "pause") return noStore({ state: control.pause() });
    if (action === "resume") return noStore({ state: control.resume() });
    if (action === "abort") return noStore({ state: control.abort(body?.confirmation) });
    return jsonError("Unknown control endpoint", 404);
  } catch (error) {
    return handleError(error);
  }
}

function streamEvents(request: NextRequest, control: ReturnType<typeof getMissionControl>): Response {
  let cursor = Number(request.nextUrl.searchParams.get("after") || 0);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = () => {
        if (closed) return;
        const events = control.listEvents(cursor, 500);
        for (const event of events) {
          cursor = event.cursor;
          controller.enqueue(encoder.encode(`id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        }
        controller.enqueue(encoder.encode(`event: heartbeat\ndata: ${JSON.stringify({ cursor, timestamp: new Date().toISOString() })}\n\n`));
      };
      send();
      const interval = setInterval(send, 1_000);
      const timeout = setTimeout(() => {
        closed = true;
        clearInterval(interval);
        controller.close();
      }, 25_000);
      request.signal.addEventListener("abort", () => {
        if (closed) return;
        closed = true;
        clearInterval(interval);
        clearTimeout(timeout);
        try { controller.close(); } catch {}
      }, { once: true });
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

async function readJson(request: Request): Promise<any> {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 1_048_576) throw new Error("Request body is too large");
  try { return await request.json(); } catch { return {}; }
}

function noStore(value: unknown, status = 200): NextResponse {
  return NextResponse.json({ ok: true, ...((value && typeof value === "object") ? value : { value }) }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function handleError(error: unknown): NextResponse {
  if (error instanceof ZodError) return jsonError(error.issues.map((issue) => issue.message).join("; "), 400);
  return jsonError(error instanceof Error ? error.message : "Unexpected control error", 409);
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
}
