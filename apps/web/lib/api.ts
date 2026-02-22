export type SessionStatus =
  | 'created'
  | 'accepted'
  | 'prepared'
  | 'active'
  | 'agreed'
  | 'no_agreement'
  | 'failed'
  | 'settled'
  | 'refunded'
  | 'cancelled';

export type Session = {
  id: string;
  topic: string;
  status: SessionStatus;
  proposerAgentId: string;
  counterpartyAgentId?: string;
  updatedAt?: string;
  createdAt?: string;
};

export type SessionsResponse = {
  ok: boolean;
  sessions: Session[];
};

export type HealthResponse = {
  ok: boolean;
  service: string;
  uptimeSec: number;
  counts: Record<string, number>;
  launchReady?: boolean;
  now?: string;
  [key: string]: unknown;
};

export type StrictModeSnapshot = {
  requireEndpointMode: boolean;
  requireEndpointNegotiation: boolean;
  requireTurnProof: boolean;
  turnProofMaxSkewMs: number;
  requireRuntimeAttestation: boolean;
  runtimeAttestationRemoteVerify: boolean;
  runtimeAttestationMaxAgeMs: number;
  runtimeAttestationVerifierUrlConfigured: boolean;
  allowEngineFallback: boolean;
  requireEigenCompute: boolean;
  requireSandboxParity: boolean;
  requireEigenComputeEnvironment: boolean;
  requireEigenComputeImageDigest: boolean;
  requireEigenComputeSigner: boolean;
  requireIndependentAgents: boolean;
  requireEigenAppBinding: boolean;
  requireSealingKey: boolean;
  requireAttestationSignerKey: boolean;
  allowInsecureDevKeys: boolean;
  allowSimpleMode: boolean;
  requireAttestation: boolean;
  requirePrivacyRedaction: boolean;
};

export type RuntimeProofSummary = {
  sessionsEvaluated: number;
  endpointExecutions: number;
  fallbackExecutions: number;
  localExecutions: number;
  sessionsWithProofSummary: number;
  proofVerifiedSessions: number;
  proofFailedSessions: number;
  verifiedDecisions: number;
  failedDecisions: number;
  runtimeVerifiedDecisions: number;
  runtimeFailedDecisions: number;
};

export type RuntimeAttestationSummary = {
  finalizedSessions: number;
  attestedSessions: number;
  validAttestations: number;
  invalidAttestations: number;
  attestationCoverage: number;
  invalidSamples: Array<{ sessionId: string; reasons: string[] }>;
};

export type LaunchReadinessReport = {
  ready: boolean;
  blockers: string[];
  checks: Array<{
    key: string;
    pass: boolean;
    expected: unknown;
    actual: unknown;
    message?: string;
  }>;
};

export type VerificationResponse = {
  ok: boolean;
  environment: string;
  appIds: string[];
  verifyUrl?: string;
  checks: {
    appBound: boolean;
    strictMode: StrictModeSnapshot;
    launchReadiness?: LaunchReadinessReport;
    runtime?: {
      proofRuntime?: RuntimeProofSummary;
      attestationRuntime?: RuntimeAttestationSummary;
    };
  };
};

export type VerificationSessionResponse = {
  ok: boolean;
  sessionId: string;
  status: SessionStatus | string;
  negotiation: {
    execution: JsonObject;
    proofSummary: JsonObject;
  };
  attestation: {
    record: JsonObject;
    verification: JsonObject;
  } | null;
};

export type TrustedLeaderboardEntry = {
  agentId: string;
  trustedSessions: number;
  agreements: number;
  noAgreements: number;
  failures: number;
  trustScore: number;
};

export type TrustedLeaderboardResponse = {
  ok: boolean;
  summary: {
    trustedSessions: number;
    excludedSessions: number;
    leaderboardAgents: number;
  };
  leaderboard: TrustedLeaderboardEntry[];
};

export type JsonObject = Record<string, unknown>;

export type ApiCatalogItem = {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'HEAD' | 'OPTIONS';
  backendPath: string;
  frontendPath: string;
  wrapper?: string;
  note?: string;
};

const paths = {
  sessions: '/api/sessions',
  agents: '/api/agents',
  registerAgent: '/api/agents/register',
  health: '/api/health',
  verification: '/api/verification/eigencompute',
  trustedLeaderboard: '/api/leaderboard/trusted',
  automationStatus: '/api/automation/status',
  docs: '/api/docs',
  skill: '/skill.md',
  guide: '/guide'
} as const;

function absoluteUrl(path: string): string {
  if (typeof window === 'undefined') return path;
  return `${window.location.origin}${path}`;
}

export function toFrontendPathFromBackendPath(backendPath: string): string {
  const normalized = backendPath.startsWith('/') ? backendPath : `/${backendPath}`;

  if (normalized === '/skill.md') return '/skill.md';

  if (normalized.startsWith('/api/')) {
    return `/api/${normalized.slice('/api/'.length)}`;
  }

  return `/api${normalized}`;
}

const BACKEND_ROUTE_DEFINITIONS: Array<Omit<ApiCatalogItem, 'frontendPath'>> = [
  // System + verification
  { method: 'GET', backendPath: '/skill.md', wrapper: 'getSkillMarkdown' },
  { method: 'GET', backendPath: '/health', wrapper: 'getHealth' },
  { method: 'GET', backendPath: '/metrics', wrapper: 'getMetrics' },
  { method: 'GET', backendPath: '/auth/status', wrapper: 'getAuthStatus' },
  { method: 'GET', backendPath: '/policy/strict', wrapper: 'getPolicyStrict' },
  { method: 'GET', backendPath: '/verification/eigencompute', wrapper: 'getVerification' },
  {
    method: 'GET',
    backendPath: '/verification/eigencompute/sessions/:id',
    wrapper: 'getVerificationSession'
  },

  // Agents
  { method: 'GET', backendPath: '/agents', wrapper: 'listAgents' },
  { method: 'POST', backendPath: '/api/agents/register', wrapper: 'registerAgent' },
  { method: 'POST', backendPath: '/api/agents/:id/probe', wrapper: 'probeAgent' },

  // Sessions
  { method: 'GET', backendPath: '/sessions', wrapper: 'listSessions' },
  { method: 'GET', backendPath: '/sessions/:id', wrapper: 'getSession' },
  { method: 'GET', backendPath: '/sessions/:id/transcript', wrapper: 'getSessionTranscript' },
  { method: 'GET', backendPath: '/sessions/:id/attestation', wrapper: 'getSessionAttestation' },
  { method: 'POST', backendPath: '/sessions/:id/attestation', wrapper: 'createSessionAttestation' },
  { method: 'POST', backendPath: '/sessions', wrapper: 'createSession' },
  { method: 'POST', backendPath: '/sessions/:id/accept', wrapper: 'acceptSession' },
  { method: 'POST', backendPath: '/sessions/:id/prepare', wrapper: 'prepareSession' },
  { method: 'POST', backendPath: '/sessions/:id/start', wrapper: 'startSession' },
  { method: 'POST', backendPath: '/sessions/:id/adjudicate', wrapper: 'adjudicateSession' },
  { method: 'POST', backendPath: '/sessions/:id/private-inputs', wrapper: 'uploadPrivateInputs' },
  { method: 'POST', backendPath: '/sessions/:id/negotiate', wrapper: 'negotiateSession' },
  { method: 'POST', backendPath: '/negotiate', wrapper: 'negotiateDirect' },

  // Escrow
  { method: 'POST', backendPath: '/sessions/:id/escrow/prepare', wrapper: 'prepareEscrow' },
  { method: 'GET', backendPath: '/sessions/:id/escrow/status', wrapper: 'getEscrowStatus' },
  { method: 'POST', backendPath: '/sessions/:id/escrow/deposit', wrapper: 'depositEscrow' },
  { method: 'POST', backendPath: '/sessions/:id/escrow/settle', wrapper: 'settleEscrow' },

  // Trust + automation
  { method: 'GET', backendPath: '/leaderboard/trusted', wrapper: 'getTrustedLeaderboard' },
  { method: 'GET', backendPath: '/automation/status', wrapper: 'getAutomationStatus' },
  { method: 'POST', backendPath: '/automation/tick', wrapper: 'tickAutomation' }
];

export const API_CATALOG: ApiCatalogItem[] = BACKEND_ROUTE_DEFINITIONS.map((item) => ({
  ...item,
  frontendPath: toFrontendPathFromBackendPath(item.backendPath)
}));

function withQuery(path: string, query?: Record<string, string | number | boolean | undefined>): string {
  if (!query) return path;

  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }

  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function requestText(path: string, init: RequestInit = {}): Promise<string> {
  const response = await fetch(path, {
    cache: 'no-store',
    ...init
  });

  const text = await response.text();

  if (!response.ok) {
    let errorMessage = `HTTP ${response.status}`;

    try {
      const json = text ? JSON.parse(text) : {};
      errorMessage = json?.error?.message || json?.error || json?.message || errorMessage;
    } catch {
      // keep fallback message
    }

    throw new Error(errorMessage);
  }

  return text;
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const text = await requestText(path, init);
  const json = text ? JSON.parse(text) : {};
  return json as T;
}

function jsonRequestInit(method: string, body?: JsonObject): RequestInit {
  return {
    method,
    headers: {
      'content-type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  };
}

function requestBackendText(backendPath: string, init: RequestInit = {}) {
  return requestText(toFrontendPathFromBackendPath(backendPath), init);
}

function requestBackendJson<T>(backendPath: string, init: RequestInit = {}) {
  return requestJson<T>(toFrontendPathFromBackendPath(backendPath), init);
}

export const frontendApi = {
  baseUrl: '',
  paths,
  catalog: API_CATALOG,

  toFrontendPath(backendPath: string) {
    return toFrontendPathFromBackendPath(backendPath);
  },

  getSkillUrl() {
    return absoluteUrl(paths.skill);
  },

  getGuideUrl() {
    return absoluteUrl(paths.guide);
  },

  getDocsUrl() {
    return absoluteUrl(paths.docs);
  },

  // Generic escape hatches (all backend APIs are reachable via these)
  requestText,
  requestJson,
  requestBackendText,
  requestBackendJson,

  // ---- System ----
  getHealth() {
    return requestJson<HealthResponse>(paths.health);
  },

  getMetrics() {
    return requestBackendJson<JsonObject>('/metrics');
  },

  getAuthStatus() {
    return requestBackendJson<JsonObject>('/auth/status');
  },

  getPolicyStrict() {
    return requestBackendJson<{ ok: boolean; policy: StrictModeSnapshot }>('/policy/strict');
  },

  getVerification() {
    return requestJson<VerificationResponse>(paths.verification);
  },

  getVerificationSession(id: string) {
    return requestBackendJson<VerificationSessionResponse>(`/verification/eigencompute/sessions/${encodeURIComponent(id)}`);
  },

  // ---- Skill installer ----
  getSkillMarkdown() {
    return requestText(paths.skill);
  },

  // ---- Agents ----
  listAgents(includeDisabled?: boolean) {
    return requestBackendJson<JsonObject>(withQuery('/agents', { includeDisabled }));
  },

  registerAgent(payload: JsonObject) {
    return requestBackendJson<JsonObject>('/api/agents/register', jsonRequestInit('POST', payload));
  },

  probeAgent(id: string) {
    return requestBackendJson<JsonObject>(`/api/agents/${encodeURIComponent(id)}/probe`, jsonRequestInit('POST'));
  },

  // ---- Sessions ----
  listSessions(status?: SessionStatus) {
    return requestJson<SessionsResponse>(withQuery(paths.sessions, { status }));
  },

  getSession(id: string) {
    return requestBackendJson<JsonObject>(`/sessions/${encodeURIComponent(id)}`);
  },

  createSession(payload: JsonObject) {
    return requestBackendJson<JsonObject>('/sessions', jsonRequestInit('POST', payload));
  },

  acceptSession(id: string, payload?: JsonObject) {
    return requestBackendJson<JsonObject>(`/sessions/${encodeURIComponent(id)}/accept`, jsonRequestInit('POST', payload));
  },

  prepareSession(id: string) {
    return requestBackendJson<JsonObject>(`/sessions/${encodeURIComponent(id)}/prepare`, jsonRequestInit('POST'));
  },

  startSession(id: string) {
    return requestBackendJson<JsonObject>(`/sessions/${encodeURIComponent(id)}/start`, jsonRequestInit('POST'));
  },

  adjudicateSession(id: string, payload: JsonObject) {
    return requestBackendJson<JsonObject>(`/sessions/${encodeURIComponent(id)}/adjudicate`, jsonRequestInit('POST', payload));
  },

  uploadPrivateInputs(id: string, payload: JsonObject) {
    return requestBackendJson<JsonObject>(`/sessions/${encodeURIComponent(id)}/private-inputs`, jsonRequestInit('POST', payload));
  },

  negotiateSession(id: string, payload?: JsonObject) {
    return requestBackendJson<JsonObject>(`/sessions/${encodeURIComponent(id)}/negotiate`, jsonRequestInit('POST', payload));
  },

  negotiateDirect(payload: JsonObject) {
    return requestBackendJson<JsonObject>('/negotiate', jsonRequestInit('POST', payload));
  },

  getSessionTranscript(id: string) {
    return requestBackendJson<JsonObject>(`/sessions/${encodeURIComponent(id)}/transcript`);
  },

  getSessionAttestation(id: string) {
    return requestBackendJson<JsonObject>(`/sessions/${encodeURIComponent(id)}/attestation`);
  },

  createSessionAttestation(id: string) {
    return requestBackendJson<JsonObject>(`/sessions/${encodeURIComponent(id)}/attestation`, jsonRequestInit('POST'));
  },

  // ---- Escrow ----
  prepareEscrow(id: string) {
    return requestBackendJson<JsonObject>(`/sessions/${encodeURIComponent(id)}/escrow/prepare`, jsonRequestInit('POST'));
  },

  getEscrowStatus(id: string) {
    return requestBackendJson<JsonObject>(`/sessions/${encodeURIComponent(id)}/escrow/status`);
  },

  depositEscrow(id: string, payload: JsonObject) {
    return requestBackendJson<JsonObject>(`/sessions/${encodeURIComponent(id)}/escrow/deposit`, jsonRequestInit('POST', payload));
  },

  settleEscrow(id: string) {
    return requestBackendJson<JsonObject>(`/sessions/${encodeURIComponent(id)}/escrow/settle`, jsonRequestInit('POST'));
  },

  // ---- Leaderboard ----
  getTrustedLeaderboard() {
    return requestJson<TrustedLeaderboardResponse>(paths.trustedLeaderboard);
  },

  // ---- Automation ----
  getAutomationStatus() {
    return requestBackendJson<JsonObject>('/automation/status');
  },

  tickAutomation() {
    return requestBackendJson<JsonObject>('/automation/tick', jsonRequestInit('POST'));
  }
};
