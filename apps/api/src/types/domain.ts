export type AgentHealthStatus = 'unknown' | 'healthy' | 'unhealthy';

export type AgentRecord = {
  id: string;
  name: string;
  endpoint: string;
  apiKey?: string;
  payoutAddress?: string;
  enabled: boolean;
  metadata?: Record<string, unknown>;
  lastHealthStatus: AgentHealthStatus;
  lastHealthError?: string;
  lastHealthAt?: string;
  createdAt: string;
  updatedAt: string;
};

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

export type SessionRecord = {
  id: string;
  topic: string;
  status: SessionStatus;
  proposerAgentId: string;
  counterpartyAgentId?: string;
  terms?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type AttestationRecord = {
  sessionId: string;
  signerAddress: string;
  payloadHash: string;
  signature: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type EscrowRecordStatus =
  | 'prepared'
  | 'funding_pending'
  | 'funded'
  | 'settlement_pending'
  | 'refund_pending'
  | 'settled'
  | 'refunded'
  | 'failed';

export type EscrowRecord = {
  sessionId: string;
  contractAddress: string;
  tokenAddress?: string;
  stakeAmount: string;
  status: EscrowRecordStatus;
  txHash?: string;
  playerAAgentId?: string;
  playerBAgentId?: string;
  playerADeposited: boolean;
  playerBDeposited: boolean;
  settlementAttempts: number;
  lastSettlementError?: string;
  lastSettlementAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type SealedInputRecord = {
  id: string;
  sessionId: string;
  agentId: string;
  sealedRef: string;
  keyId: string;
  cipherText: string;
  iv: string;
  authTag: string;
  createdAt: string;
  updatedAt: string;
};

export type SessionTurnStatus = 'continue' | 'agreed' | 'no_agreement' | 'failed';

export type SessionTurnRecord = {
  id: string;
  sessionId: string;
  turn: number;
  status: SessionTurnStatus;
  summary: Record<string, unknown>;
  createdAt: string;
};

export type StrictPolicySnapshot = {
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
