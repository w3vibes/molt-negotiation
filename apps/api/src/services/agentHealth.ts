import type { AgentHealthStatus } from '../types/domain.js';

export type AgentHealthProbeResult = {
  status: AgentHealthStatus;
  checkedUrl: string;
  httpStatus?: number;
  error?: string;
  latencyMs: number;
};

function resolveProbeUrl(endpoint: string): string {
  const base = endpoint.trim().replace(/\/$/, '');
  return base.endsWith('/health') ? base : `${base}/health`;
}

function timeoutMs(): number {
  const raw = process.env.NEG_AGENT_HEALTH_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 5000;
  return parsed;
}

export async function probeAgentEndpoint(endpoint: string): Promise<AgentHealthProbeResult> {
  const checkedUrl = resolveProbeUrl(endpoint);
  const startedAt = Date.now();

  try {
    const response = await fetch(checkedUrl, {
      method: 'GET',
      headers: {
        accept: 'application/json, text/plain;q=0.9, */*;q=0.8'
      },
      signal: AbortSignal.timeout(timeoutMs())
    });

    const latencyMs = Date.now() - startedAt;
    if (response.ok) {
      return {
        status: 'healthy',
        checkedUrl,
        httpStatus: response.status,
        latencyMs
      };
    }

    return {
      status: 'unhealthy',
      checkedUrl,
      httpStatus: response.status,
      error: `health_check_http_${response.status}`,
      latencyMs
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : 'health_probe_failed';

    return {
      status: 'unhealthy',
      checkedUrl,
      error: message,
      latencyMs
    };
  }
}
