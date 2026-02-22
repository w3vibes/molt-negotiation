import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { proxyRequest } from '../api/_lib/proxy';

export const dynamic = 'force-dynamic';

function backendBaseUrl(): string {
  return (
    process.env.BACKEND_API_URL?.trim() ||
    process.env.NEXT_PUBLIC_API_URL?.trim() ||
    'http://localhost:3000'
  ).replace(/\/$/, '');
}

function frontendOrigin(req: NextRequest): string {
  const forwardedProto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const forwardedHost = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim();

  const proto = forwardedProto || req.nextUrl.protocol.replace(/:$/, '') || 'http';
  const host = forwardedHost || req.headers.get('host') || req.nextUrl.host || 'localhost:3001';

  return `${proto}://${host}`.replace(/\/$/, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteSkillMarkdown(markdown: string, fromBase: string, frontendOriginBase: string): string {
  if (!fromBase || !frontendOriginBase) return markdown;

  const frontendApiBase = `${frontendOriginBase}/api`;

  // Keep human-facing skill install endpoint canonical on the web origin.
  let rewritten = markdown.replace(
    new RegExp(escapeRegExp(`${fromBase}/skill.md`), 'g'),
    `${frontendOriginBase}/skill.md`
  );

  // Route backend API examples through frontend /api proxy.
  rewritten = rewritten.replace(new RegExp(escapeRegExp(fromBase), 'g'), frontendApiBase);

  // Collapse legacy backend routes that already include /api prefix.
  rewritten = rewritten.replace(
    new RegExp(escapeRegExp(`${frontendApiBase}/api/`), 'g'),
    `${frontendApiBase}/`
  );

  // Keep homepage metadata pointed at frontend origin (not /api).
  rewritten = rewritten.replace(
    /^([ \t]*homepage:\s*).+$/m,
    `$1${frontendOriginBase}`
  );

  return rewritten;
}

async function serveSkill(req: NextRequest, method: 'GET' | 'HEAD') {
  const proxied = await proxyRequest(req, '/skill.md', 'text');
  if (!proxied.ok) return proxied;

  const original = method === 'HEAD' ? '' : await proxied.text();
  const rewritten = method === 'HEAD'
    ? ''
    : rewriteSkillMarkdown(original, backendBaseUrl(), frontendOrigin(req));

  return new NextResponse(rewritten, {
    status: proxied.status,
    headers: {
      'content-type': proxied.headers.get('content-type') || 'text/markdown; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

export async function GET(req: NextRequest) {
  return serveSkill(req, 'GET');
}

export async function HEAD(req: NextRequest) {
  return serveSkill(req, 'HEAD');
}
