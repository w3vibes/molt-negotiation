import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  AgentRecord,
  AttestationRecord,
  EscrowRecord,
  SealedInputRecord,
  SessionRecord,
  SessionStatus,
  SessionTurnRecord,
  SessionTurnStatus
} from '../types/domain.js';
import { nowIso } from '../utils/time.js';

export type Store = {
  file: string;
  close(): void;

  listAgents(includeDisabled?: boolean): AgentRecord[];
  getAgent(id: string): AgentRecord | undefined;
  findAgentByApiKey(apiKey: string): AgentRecord | undefined;
  upsertAgent(input: {
    id: string;
    name: string;
    endpoint: string;
    apiKey?: string;
    payoutAddress?: string;
    enabled?: boolean;
    metadata?: Record<string, unknown>;
  }): AgentRecord;
  updateAgentHealth(input: {
    id: string;
    status: AgentRecord['lastHealthStatus'];
    error?: string;
    checkedAt?: string;
  }): AgentRecord | undefined;

  listSessions(status?: SessionStatus): SessionRecord[];
  getSession(id: string): SessionRecord | undefined;
  createSession(input: {
    id?: string;
    topic: string;
    proposerAgentId: string;
    counterpartyAgentId?: string;
    status?: SessionStatus;
    terms?: Record<string, unknown>;
  }): SessionRecord;
  patchSession(id: string, patch: Partial<Omit<SessionRecord, 'id' | 'createdAt'>>): SessionRecord | undefined;

  saveAttestation(record: AttestationRecord): AttestationRecord;
  listAttestations(): AttestationRecord[];
  getAttestation(sessionId: string): AttestationRecord | undefined;

  upsertEscrow(input: EscrowRecord): EscrowRecord;
  getEscrow(sessionId: string): EscrowRecord | undefined;
  listEscrows(status?: EscrowRecord['status']): EscrowRecord[];
  patchEscrow(sessionId: string, patch: Partial<Omit<EscrowRecord, 'sessionId' | 'createdAt'>>): EscrowRecord | undefined;

  upsertSealedInput(input: {
    id?: string;
    sessionId: string;
    agentId: string;
    sealedRef: string;
    keyId: string;
    cipherText: string;
    iv: string;
    authTag: string;
  }): SealedInputRecord;
  getSealedInputForAgent(sessionId: string, agentId: string): SealedInputRecord | undefined;
  listSealedInputsForSession(sessionId: string): SealedInputRecord[];

  upsertSessionTurn(input: {
    id?: string;
    sessionId: string;
    turn: number;
    status: SessionTurnStatus;
    summary: Record<string, unknown>;
  }): SessionTurnRecord;
  listSessionTurns(sessionId: string): SessionTurnRecord[];

  counts(): { agents: number; sessions: number; attestations: number; escrows: number };
  stats(): { sessionsByStatus: Record<string, number>; escrowsByStatus: Record<string, number> };
  clearSessionTurns(sessionId: string): void;

  counts(): {
    agents: number;
    sessions: number;
    attestations: number;
    escrows: number;
  };
};

type StoreOptions = {
  dbFile?: string;
};

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toAgent(row: Record<string, unknown>): AgentRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    endpoint: String(row.endpoint),
    apiKey: row.api_key ? String(row.api_key) : undefined,
    payoutAddress: row.payout_address ? String(row.payout_address) : undefined,
    enabled: Number(row.enabled) === 1,
    metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
    lastHealthStatus: (row.last_health_status as AgentRecord['lastHealthStatus']) || 'unknown',
    lastHealthError: row.last_health_error ? String(row.last_health_error) : undefined,
    lastHealthAt: row.last_health_at ? String(row.last_health_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function toSession(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id),
    topic: String(row.topic),
    status: row.status as SessionStatus,
    proposerAgentId: String(row.proposer_agent_id),
    counterpartyAgentId: row.counterparty_agent_id ? String(row.counterparty_agent_id) : undefined,
    terms: parseJson<Record<string, unknown> | undefined>(row.terms_json, undefined),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function toAttestation(row: Record<string, unknown>): AttestationRecord {
  return {
    sessionId: String(row.session_id),
    signerAddress: String(row.signer_address),
    payloadHash: String(row.payload_hash),
    signature: String(row.signature),
    payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    createdAt: String(row.created_at)
  };
}

function toEscrow(row: Record<string, unknown>): EscrowRecord {
  return {
    sessionId: String(row.session_id),
    contractAddress: String(row.contract_address),
    tokenAddress: row.token_address ? String(row.token_address) : undefined,
    stakeAmount: String(row.stake_amount),
    status: row.status as EscrowRecord['status'],
    txHash: row.tx_hash ? String(row.tx_hash) : undefined,
    playerAAgentId: row.player_a_agent_id ? String(row.player_a_agent_id) : undefined,
    playerBAgentId: row.player_b_agent_id ? String(row.player_b_agent_id) : undefined,
    playerADeposited: Number(row.player_a_deposited ?? 0) === 1,
    playerBDeposited: Number(row.player_b_deposited ?? 0) === 1,
    settlementAttempts: Number(row.settlement_attempts ?? 0),
    lastSettlementError: row.last_settlement_error ? String(row.last_settlement_error) : undefined,
    lastSettlementAt: row.last_settlement_at ? String(row.last_settlement_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function toSealedInput(row: Record<string, unknown>): SealedInputRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    agentId: String(row.agent_id),
    sealedRef: String(row.sealed_ref),
    keyId: String(row.key_id),
    cipherText: String(row.cipher_text_b64),
    iv: String(row.iv_b64),
    authTag: String(row.auth_tag_b64),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function toSessionTurn(row: Record<string, unknown>): SessionTurnRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    turn: Number(row.turn_number),
    status: row.status as SessionTurnStatus,
    summary: parseJson<Record<string, unknown>>(row.summary_json, {}),
    createdAt: String(row.created_at)
  };
}

function ensureColumn(db: Database.Database, table: string, column: string, definition: string) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const exists = rows.some((row) => row.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function ensureSchema(db: Database.Database) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      api_key TEXT UNIQUE,
      payout_address TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      metadata_json TEXT,
      last_health_status TEXT NOT NULL DEFAULT 'unknown',
      last_health_error TEXT,
      last_health_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      status TEXT NOT NULL,
      proposer_agent_id TEXT NOT NULL,
      counterparty_agent_id TEXT,
      terms_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (proposer_agent_id) REFERENCES agents(id),
      FOREIGN KEY (counterparty_agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS attestations (
      session_id TEXT PRIMARY KEY,
      signer_address TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      signature TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS escrow_records (
      session_id TEXT PRIMARY KEY,
      contract_address TEXT NOT NULL,
      token_address TEXT,
      stake_amount TEXT NOT NULL,
      status TEXT NOT NULL,
      tx_hash TEXT,
      player_a_agent_id TEXT,
      player_b_agent_id TEXT,
      player_a_deposited INTEGER NOT NULL DEFAULT 0,
      player_b_deposited INTEGER NOT NULL DEFAULT 0,
      settlement_attempts INTEGER NOT NULL DEFAULT 0,
      last_settlement_error TEXT,
      last_settlement_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS sealed_inputs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      sealed_ref TEXT NOT NULL UNIQUE,
      key_id TEXT NOT NULL,
      cipher_text_b64 TEXT NOT NULL,
      iv_b64 TEXT NOT NULL,
      auth_tag_b64 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (session_id, agent_id),
      FOREIGN KEY (session_id) REFERENCES sessions(id),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS session_turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (session_id, turn_number),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_agents_enabled ON agents(enabled);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sealed_inputs_session ON sealed_inputs(session_id);
    CREATE INDEX IF NOT EXISTS idx_sealed_inputs_agent ON sealed_inputs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_session_turns_session_turn ON session_turns(session_id, turn_number);
  `);

  ensureColumn(db, 'escrow_records', 'player_a_agent_id', 'TEXT');
  ensureColumn(db, 'escrow_records', 'player_b_agent_id', 'TEXT');
  ensureColumn(db, 'escrow_records', 'player_a_deposited', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'escrow_records', 'player_b_deposited', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'escrow_records', 'settlement_attempts', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'escrow_records', 'last_settlement_error', 'TEXT');
  ensureColumn(db, 'escrow_records', 'last_settlement_at', 'TEXT');
}

export function createStore(options: StoreOptions = {}): Store {
  const file = options.dbFile || process.env.NEG_DB_FILE || '.data/molt-negotiation.sqlite';
  mkdirSync(dirname(file), { recursive: true });

  const db = new Database(file);
  ensureSchema(db);

  const store: Store = {
    file,

    close() {
      db.close();
    },

    listAgents(includeDisabled = false) {
      const rows = (
        includeDisabled
          ? db.prepare('SELECT * FROM agents ORDER BY updated_at DESC').all()
          : db.prepare('SELECT * FROM agents WHERE enabled = 1 ORDER BY updated_at DESC').all()
      ) as Record<string, unknown>[];

      return rows.map(toAgent);
    },

    getAgent(id) {
      const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      return row ? toAgent(row) : undefined;
    },

    findAgentByApiKey(apiKey) {
      const normalized = apiKey.trim();
      if (!normalized) return undefined;
      const row = db
        .prepare('SELECT * FROM agents WHERE api_key = ? AND enabled = 1')
        .get(normalized) as Record<string, unknown> | undefined;

      return row ? toAgent(row) : undefined;
    },

    upsertAgent(input) {
      const now = nowIso();
      const existing = store.getAgent(input.id);

      db.prepare(`
        INSERT INTO agents (
          id, name, endpoint, api_key, payout_address, enabled, metadata_json,
          last_health_status, last_health_error, last_health_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          endpoint = excluded.endpoint,
          api_key = excluded.api_key,
          payout_address = excluded.payout_address,
          enabled = excluded.enabled,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `).run(
        input.id,
        input.name,
        input.endpoint,
        input.apiKey ?? null,
        input.payoutAddress ?? null,
        input.enabled === false ? 0 : 1,
        input.metadata ? JSON.stringify(input.metadata) : null,
        existing?.lastHealthStatus ?? 'unknown',
        existing?.lastHealthError ?? null,
        existing?.lastHealthAt ?? null,
        existing?.createdAt ?? now,
        now
      );

      return store.getAgent(input.id)!;
    },

    updateAgentHealth(input) {
      const existing = store.getAgent(input.id);
      if (!existing) return undefined;

      const checkedAt = input.checkedAt ?? nowIso();
      const updatedAt = nowIso();

      db.prepare(`
        UPDATE agents
        SET last_health_status = ?,
            last_health_error = ?,
            last_health_at = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        input.status,
        input.error ?? null,
        checkedAt,
        updatedAt,
        input.id
      );

      return store.getAgent(input.id);
    },

    listSessions(status) {
      const rows = (
        status
          ? db.prepare('SELECT * FROM sessions WHERE status = ? ORDER BY created_at DESC').all(status)
          : db.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all()
      ) as Record<string, unknown>[];

      return rows.map(toSession);
    },

    getSession(id) {
      const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      return row ? toSession(row) : undefined;
    },

    createSession(input) {
      const id = input.id || `session_${Date.now()}`;
      const now = nowIso();

      db.prepare(`
        INSERT INTO sessions (
          id, topic, status, proposer_agent_id, counterparty_agent_id, terms_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.topic,
        input.status || (input.counterpartyAgentId ? 'accepted' : 'created'),
        input.proposerAgentId,
        input.counterpartyAgentId ?? null,
        input.terms ? JSON.stringify(input.terms) : null,
        now,
        now
      );

      return store.getSession(id)!;
    },

    patchSession(id, patch) {
      const existing = store.getSession(id);
      if (!existing) return undefined;

      const next: SessionRecord = {
        ...existing,
        ...patch,
        id,
        createdAt: existing.createdAt,
        updatedAt: nowIso()
      };

      db.prepare(`
        UPDATE sessions SET
          topic = ?,
          status = ?,
          proposer_agent_id = ?,
          counterparty_agent_id = ?,
          terms_json = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        next.topic,
        next.status,
        next.proposerAgentId,
        next.counterpartyAgentId ?? null,
        next.terms ? JSON.stringify(next.terms) : null,
        next.updatedAt,
        id
      );

      return store.getSession(id);
    },

    saveAttestation(record) {
      db.prepare(`
        INSERT INTO attestations (
          session_id, signer_address, payload_hash, signature, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          signer_address = excluded.signer_address,
          payload_hash = excluded.payload_hash,
          signature = excluded.signature,
          payload_json = excluded.payload_json,
          created_at = excluded.created_at
      `).run(
        record.sessionId,
        record.signerAddress,
        record.payloadHash,
        record.signature,
        JSON.stringify(record.payload),
        record.createdAt
      );

      return store.getAttestation(record.sessionId)!;
    },

    listAttestations() {
      const rows = db.prepare('SELECT * FROM attestations ORDER BY created_at DESC').all() as Record<string, unknown>[];
      return rows.map(toAttestation);
    },

    getAttestation(sessionId) {
      const row = db.prepare('SELECT * FROM attestations WHERE session_id = ?').get(sessionId) as Record<string, unknown> | undefined;
      return row ? toAttestation(row) : undefined;
    },

    upsertEscrow(input) {
      const now = nowIso();
      const existing = store.getEscrow(input.sessionId);

      db.prepare(`
        INSERT INTO escrow_records (
          session_id,
          contract_address,
          token_address,
          stake_amount,
          status,
          tx_hash,
          player_a_agent_id,
          player_b_agent_id,
          player_a_deposited,
          player_b_deposited,
          settlement_attempts,
          last_settlement_error,
          last_settlement_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          contract_address = excluded.contract_address,
          token_address = excluded.token_address,
          stake_amount = excluded.stake_amount,
          status = excluded.status,
          tx_hash = excluded.tx_hash,
          player_a_agent_id = excluded.player_a_agent_id,
          player_b_agent_id = excluded.player_b_agent_id,
          player_a_deposited = excluded.player_a_deposited,
          player_b_deposited = excluded.player_b_deposited,
          settlement_attempts = excluded.settlement_attempts,
          last_settlement_error = excluded.last_settlement_error,
          last_settlement_at = excluded.last_settlement_at,
          updated_at = excluded.updated_at
      `).run(
        input.sessionId,
        input.contractAddress,
        input.tokenAddress ?? null,
        input.stakeAmount,
        input.status,
        input.txHash ?? null,
        input.playerAAgentId ?? null,
        input.playerBAgentId ?? null,
        input.playerADeposited ? 1 : 0,
        input.playerBDeposited ? 1 : 0,
        input.settlementAttempts,
        input.lastSettlementError ?? null,
        input.lastSettlementAt ?? null,
        existing?.createdAt ?? now,
        now
      );

      return store.getEscrow(input.sessionId)!;
    },

    getEscrow(sessionId) {
      const row = db.prepare('SELECT * FROM escrow_records WHERE session_id = ?').get(sessionId) as Record<string, unknown> | undefined;
      return row ? toEscrow(row) : undefined;
    },

    listEscrows(status) {
      const rows = (
        status
          ? db.prepare('SELECT * FROM escrow_records WHERE status = ? ORDER BY updated_at DESC').all(status)
          : db.prepare('SELECT * FROM escrow_records ORDER BY updated_at DESC').all()
      ) as Record<string, unknown>[];

      return rows.map(toEscrow);
    },

    patchEscrow(sessionId, patch) {
      const existing = store.getEscrow(sessionId);
      if (!existing) return undefined;

      const next: EscrowRecord = {
        ...existing,
        ...patch,
        sessionId,
        createdAt: existing.createdAt,
        updatedAt: nowIso()
      };

      db.prepare(`
        UPDATE escrow_records
        SET contract_address = ?,
            token_address = ?,
            stake_amount = ?,
            status = ?,
            tx_hash = ?,
            player_a_agent_id = ?,
            player_b_agent_id = ?,
            player_a_deposited = ?,
            player_b_deposited = ?,
            settlement_attempts = ?,
            last_settlement_error = ?,
            last_settlement_at = ?,
            updated_at = ?
        WHERE session_id = ?
      `).run(
        next.contractAddress,
        next.tokenAddress ?? null,
        next.stakeAmount,
        next.status,
        next.txHash ?? null,
        next.playerAAgentId ?? null,
        next.playerBAgentId ?? null,
        next.playerADeposited ? 1 : 0,
        next.playerBDeposited ? 1 : 0,
        next.settlementAttempts,
        next.lastSettlementError ?? null,
        next.lastSettlementAt ?? null,
        next.updatedAt,
        sessionId
      );

      return store.getEscrow(sessionId);
    },

    upsertSealedInput(input) {
      const now = nowIso();
      const id = input.id ?? `${input.sessionId}:${input.agentId}`;
      const existing = store.getSealedInputForAgent(input.sessionId, input.agentId);

      db.prepare(`
        INSERT INTO sealed_inputs (
          id, session_id, agent_id, sealed_ref, key_id, cipher_text_b64, iv_b64, auth_tag_b64, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, agent_id) DO UPDATE SET
          sealed_ref = excluded.sealed_ref,
          key_id = excluded.key_id,
          cipher_text_b64 = excluded.cipher_text_b64,
          iv_b64 = excluded.iv_b64,
          auth_tag_b64 = excluded.auth_tag_b64,
          updated_at = excluded.updated_at
      `).run(
        id,
        input.sessionId,
        input.agentId,
        input.sealedRef,
        input.keyId,
        input.cipherText,
        input.iv,
        input.authTag,
        existing?.createdAt ?? now,
        now
      );

      return store.getSealedInputForAgent(input.sessionId, input.agentId)!;
    },

    getSealedInputForAgent(sessionId, agentId) {
      const row = db
        .prepare('SELECT * FROM sealed_inputs WHERE session_id = ? AND agent_id = ?')
        .get(sessionId, agentId) as Record<string, unknown> | undefined;

      return row ? toSealedInput(row) : undefined;
    },

    listSealedInputsForSession(sessionId) {
      const rows = db
        .prepare('SELECT * FROM sealed_inputs WHERE session_id = ? ORDER BY created_at ASC')
        .all(sessionId) as Record<string, unknown>[];

      return rows.map(toSealedInput);
    },

    upsertSessionTurn(input) {
      const id = input.id ?? `${input.sessionId}:${input.turn}`;
      const now = nowIso();

      db.prepare(`
        INSERT INTO session_turns (
          id, session_id, turn_number, status, summary_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, turn_number) DO UPDATE SET
          status = excluded.status,
          summary_json = excluded.summary_json
      `).run(
        id,
        input.sessionId,
        input.turn,
        input.status,
        JSON.stringify(input.summary),
        now
      );

      const row = db
        .prepare('SELECT * FROM session_turns WHERE session_id = ? AND turn_number = ?')
        .get(input.sessionId, input.turn) as Record<string, unknown>;

      return toSessionTurn(row);
    },

    listSessionTurns(sessionId) {
      const rows = db
        .prepare('SELECT * FROM session_turns WHERE session_id = ? ORDER BY turn_number ASC')
        .all(sessionId) as Record<string, unknown>[];

      return rows.map(toSessionTurn);
    },

    clearSessionTurns(sessionId) {
      db.prepare('DELETE FROM session_turns WHERE session_id = ?').run(sessionId);
    },

    counts() {
      const agents = Number((db.prepare('SELECT COUNT(*) as c FROM agents').get() as { c: number }).c);
      const sessions = Number((db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }).c);
      const attestations = Number((db.prepare('SELECT COUNT(*) as c FROM attestations').get() as { c: number }).c);
      const escrows = Number((db.prepare('SELECT COUNT(*) as c FROM escrow_records').get() as { c: number }).c);
      return { agents, sessions, attestations, escrows };
    },

    stats() {
      const sessionsByStatus = db.prepare(`
        SELECT status, COUNT(*) as c FROM sessions GROUP BY status
      `).all() as { status: string; c: number }[];
      
      const escrowsByStatus = db.prepare(`
        SELECT status, COUNT(*) as c FROM escrow_records GROUP BY status
      `).all() as { status: string; c: number }[];

      const sessionsByStatusObj: Record<string, number> = {};
      for (const row of sessionsByStatus) {
        sessionsByStatusObj[row.status] = row.c;
      }

      const escrowsByStatusObj: Record<string, number> = {};
      for (const row of escrowsByStatus) {
        escrowsByStatusObj[row.status] = row.c;
      }

      return {
        sessionsByStatus: sessionsByStatusObj,
        escrowsByStatus: escrowsByStatusObj
      };
    }
  };

  return store;
}
