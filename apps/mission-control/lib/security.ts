import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const COOKIE_NAME = "avo_mission_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

export type AuthResult = { ok: true } | { ok: false; response: NextResponse };

export function authConfigured(): boolean {
  return Boolean(process.env.MISSION_CONTROL_TOKEN?.trim());
}

export function authorize(request: Request | NextRequest, { mutate = false } = {}): AuthResult {
  const secret = process.env.MISSION_CONTROL_TOKEN?.trim();
  if (!secret) {
    const explicitlyAllowed = process.env.MISSION_CONTROL_ALLOW_UNAUTHENTICATED === "1";
    if (process.env.NODE_ENV === "production" && !explicitlyAllowed) {
      return {
        ok: false,
        response: jsonError("Mission Control authentication is not configured", 503),
      };
    }
    if (mutate && !sameOrigin(request)) {
      return { ok: false, response: jsonError("Cross-origin mutation rejected", 403) };
    }
    return { ok: true };
  }

  if (mutate && !sameOrigin(request)) {
    return { ok: false, response: jsonError("Cross-origin mutation rejected", 403) };
  }

  const cookie = readCookie(request.headers.get("cookie") || "", COOKIE_NAME);
  if (!cookie || !verifySession(cookie, secret)) {
    return { ok: false, response: jsonError("Authentication required", 401) };
  }
  return { ok: true };
}

export function createSessionResponse(token: unknown): NextResponse {
  const secret = process.env.MISSION_CONTROL_TOKEN?.trim();
  if (!secret) return jsonError("Authentication is not configured", 503);
  if (typeof token !== "string" || !safeEqual(token, secret)) {
    return jsonError("Invalid credentials", 401);
  }
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const value = signSession(expires, secret);
  const response = NextResponse.json({ ok: true, expiresAt: new Date(expires * 1000).toISOString() });
  response.cookies.set(COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function clearSessionResponse(): NextResponse {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(COOKIE_NAME, "", { httpOnly: true, sameSite: "strict", path: "/", maxAge: 0 });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export function safeProviderStatus(): {
  configured: boolean;
  arcAutomaticAuth: true;
  providerFingerprint: string | null;
} {
  const endpoint = process.env.OPENAI_BASE_URL || "";
  const model = process.env.OPENAI_MODEL || "";
  const keyPresent = Boolean(process.env.OPENAI_API_KEY);
  const configured = Boolean(endpoint && model && keyPresent);
  const salt = process.env.MISSION_CONTROL_FINGERPRINT_SALT || process.env.GITHUB_REPOSITORY_ID || "local-only";
  return {
    configured,
    arcAutomaticAuth: true,
    providerFingerprint: configured
      ? crypto.createHash("sha256").update(`${salt}\0${endpoint}\0${model}`).digest("hex")
      : null,
  };
}

export function sanitizeText(value: unknown, max = 16_384): string {
  let text = String(value ?? "").slice(0, max);
  const exact = [
    process.env.OPENAI_API_KEY,
    process.env.OPENAI_BASE_URL,
    process.env.OPENAI_MODEL,
    process.env.ARC_API_KEY,
  ].filter((entry): entry is string => Boolean(entry));
  for (const secret of exact) text = text.split(secret).join("<redacted>");
  text = text
    .replace(/\b(?:sk|github_pat|ghp)_[A-Za-z0-9_-]{12,}\b/g, "<redacted>")
    .replace(/Authorization\s*[:=]\s*Bearer\s+[^\s,;]+/gi, "Authorization: Bearer <redacted>")
    .replace(/https?:\/\/(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?[^\s"']*/g, "<redacted-url>");
  return text;
}

function signSession(expires: number, secret: string): string {
  const payload = String(expires);
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifySession(value: string, secret: string): boolean {
  const [expiresText, signature] = value.split(".");
  const expires = Number(expiresText);
  if (!Number.isInteger(expires) || expires < Math.floor(Date.now() / 1000)) return false;
  const expected = signSession(expires, secret).split(".")[1];
  return Boolean(signature && safeEqual(signature, expected));
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readCookie(header: string, name: string): string | null {
  for (const item of header.split(";")) {
    const [key, ...parts] = item.trim().split("=");
    if (key === name) return decodeURIComponent(parts.join("="));
  }
  return null;
}

function sameOrigin(request: Request | NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}
