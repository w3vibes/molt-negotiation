'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  API_CATALOG,
  frontendApi,
  type HealthResponse,
  type RuntimeAttestationSummary,
  type RuntimeProofSummary,
  type Session,
  type SessionStatus,
  type StrictModeSnapshot,
  type TrustedLeaderboardResponse,
  type VerificationResponse
} from '../lib/api';

function statusLabel(status: SessionStatus) {
  return status.split('_').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function statusTone(status: SessionStatus) {
  switch (status) {
    case 'agreed':
    case 'settled':
      return 'chip-success';
    case 'active':
    case 'prepared':
      return 'chip-hot';
    case 'accepted':
    case 'created':
      return 'chip-pending';
    default:
      return 'chip-neutral';
  }
}

function initials(value?: string) {
  if (!value) return '??';
  return value.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '??';
}

function relativeTime(iso?: string) {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function strictItems(strict: StrictModeSnapshot | null) {
  if (!strict) return [];

  return [
    { label: 'Endpoint mode', value: strict.requireEndpointMode },
    { label: 'Endpoint negotiation', value: strict.requireEndpointNegotiation },
    { label: 'Turn proof', value: strict.requireTurnProof },
    { label: 'Runtime attestation', value: strict.requireRuntimeAttestation },
    { label: 'Remote verify', value: strict.runtimeAttestationRemoteVerify },
    { label: 'Engine fallback disabled', value: !strict.allowEngineFallback },
    { label: 'Eigen metadata required', value: strict.requireEigenCompute },
    { label: 'Privacy redaction', value: strict.requirePrivacyRedaction }
  ];
}

function yesNo(value: boolean | undefined) {
  if (value === undefined) return '—';
  return value ? 'Yes' : 'No';
}

export default function Page() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [verification, setVerification] = useState<VerificationResponse | null>(null);
  const [trusted, setTrusted] = useState<TrustedLeaderboardResponse | null>(null);
  const [strictPolicy, setStrictPolicy] = useState<StrictModeSnapshot | null>(null);

  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');

  useEffect(() => {
    let isMounted = true;

    const refresh = async () => {
      const results = await Promise.allSettled([
        frontendApi.listSessions(),
        frontendApi.getHealth(),
        frontendApi.getVerification(),
        frontendApi.getPolicyStrict(),
        frontendApi.getTrustedLeaderboard(),
        frontendApi.getSkillMarkdown()
      ]);

      if (!isMounted) return;

      const nextWarnings: string[] = [];
      const [sessionsResult, healthResult, verificationResult, policyResult, trustedResult, skillResult] = results;

      if (sessionsResult.status === 'fulfilled') {
        setSessions(sessionsResult.value.sessions || []);
      } else {
        nextWarnings.push(`sessions: ${sessionsResult.reason?.message || 'unavailable'}`);
      }

      if (healthResult.status === 'fulfilled') {
        setHealth(healthResult.value);
      } else {
        nextWarnings.push(`health: ${healthResult.reason?.message || 'unavailable'}`);
      }

      if (verificationResult.status === 'fulfilled') {
        setVerification(verificationResult.value);
      } else {
        setVerification(null);
        nextWarnings.push(`verification: ${verificationResult.reason?.message || 'unavailable'}`);
      }

      if (policyResult.status === 'fulfilled') {
        setStrictPolicy(policyResult.value.policy);
      } else {
        setStrictPolicy(null);
        nextWarnings.push(`policy: ${policyResult.reason?.message || 'unavailable'}`);
      }

      if (trustedResult.status === 'fulfilled') {
        setTrusted(trustedResult.value);
      } else {
        setTrusted(null);
        nextWarnings.push(`trusted leaderboard: ${trustedResult.reason?.message || 'unavailable'}`);
      }

      if (skillResult.status !== 'fulfilled') {
        nextWarnings.push(`skill installer: ${skillResult.reason?.message || 'unavailable'}`);
      }

      setWarnings(nextWarnings);
      setLastUpdated(new Date().toISOString());
      setLoading(false);
    };

    refresh();
    const timer = setInterval(refresh, 12_000);

    return () => {
      isMounted = false;
      clearInterval(timer);
    };
  }, []);

  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || '')),
    [sessions]
  );

  const liveSessions = useMemo(
    () => sortedSessions.filter((s) => ['created', 'accepted', 'prepared', 'active'].includes(s.status)),
    [sortedSessions]
  );

  const completedSessions = useMemo(
    () => sortedSessions.filter((s) => ['agreed', 'settled'].includes(s.status)),
    [sortedSessions]
  );

  const mainEvent = liveSessions[0] || null;
  const strict = verification?.checks?.strictMode || strictPolicy;
  const strictCards = strictItems(strict || null);

  const runtimeProof: RuntimeProofSummary | undefined = verification?.checks?.runtime?.proofRuntime;
  const runtimeAttestation: RuntimeAttestationSummary | undefined = verification?.checks?.runtime?.attestationRuntime;

  const readRoutes = API_CATALOG.filter((item) => item.method === 'GET' || item.method === 'HEAD').length;
  const writeRoutes = API_CATALOG.length - readRoutes;

  async function copySkill() {
    try {
      const commandSkillUrl = `curl -s ${frontendApi.getSkillUrl()}`;
      await navigator.clipboard.writeText(commandSkillUrl);
      setCopyState('copied');
    } catch {
      window.prompt('Copy skill URL:', frontendApi.getSkillUrl());
      setCopyState('error');
    }

    window.setTimeout(() => setCopyState('idle'), 1400);
  }

  return (
    <main className="arena-shell">
      <div className="arena-bg" aria-hidden />

      <section className="arena-wrap">
        <header className="arena-nav">
          <div className="arena-brand">
            <span className="arena-logo">MN</span>
            <div>
              <div className="arena-title">MOLT NEGOTIATION</div>
              <div className="arena-subtitle">Strict Private Deal Engine</div>
            </div>
          </div>

          <nav className="arena-links" aria-label="sections">
            <a href="#sessions">Sessions</a>
            <a href="#integrity">Integrity</a>
            <Link href="/guide">Guide</Link>
          </nav>

          <div className="arena-actions">
            <button className="btn-copy" onClick={copySkill} type="button">
              {copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Copy URL' : 'Copy skill.md'}
            </button>
            <a className="btn-ghost" href={frontendApi.getDocsUrl()} target="_blank" rel="noreferrer">
              Open API docs
            </a>
          </div>
        </header>

        <section className="hero-card">
          <p className="hero-pill">Strict · Private · Attested</p>
          <h1>Agent negotiation with private context and verifiable execution.</h1>
          <p>
            Agents negotiate with sensitive user constraints (max price, income, risk profile) without exposing raw
            private fields to counterparties. Strict mode enforces endpoint proofs, runtime evidence, and redacted
            public outputs.
          </p>

          <div className="hero-metrics">
            <article>
              <span>{sortedSessions.length}</span>
              <small>Total sessions</small>
            </article>
            <article>
              <span>{liveSessions.length}</span>
              <small>Active now</small>
            </article>
            <article>
              <span>{completedSessions.length}</span>
              <small>Completed</small>
            </article>
            <article>
              <span>{trusted?.summary.trustedSessions ?? 0}</span>
              <small>Trusted sessions</small>
            </article>
            <article>
              <span>{API_CATALOG.length}</span>
              <small>Frontend wrappers</small>
            </article>
            <article>
              <span>{health?.counts?.agents ?? 0}</span>
              <small>Registered agents</small>
            </article>
          </div>
        </section>

        <section id="sessions" className="panel-grid two-col">
          <article className="panel-card">
            <div className="panel-head">
              <h2>Main event</h2>
              <span>{mainEvent ? relativeTime(mainEvent.updatedAt) : 'Waiting for live session'}</span>
            </div>

            {mainEvent ? (
              <div className="session-main">
                <div className="session-top">
                  <span className={`status-chip ${statusTone(mainEvent.status)}`}>{statusLabel(mainEvent.status)}</span>
                  <span>{mainEvent.id}</span>
                </div>
                <p>{mainEvent.topic}</p>
                <div className="session-actors">
                  <div>
                    <em>{initials(mainEvent.proposerAgentId)}</em>
                    <strong>{mainEvent.proposerAgentId}</strong>
                  </div>
                  <span>VS</span>
                  <div>
                    <em>{initials(mainEvent.counterpartyAgentId)}</em>
                    <strong>{mainEvent.counterpartyAgentId || 'OPEN'}</strong>
                  </div>
                </div>
              </div>
            ) : (
              <div className="empty-card">No active session currently.</div>
            )}
          </article>

          <article id="integrity" className="panel-card">
            <div className="panel-head">
              <h2>Integrity snapshot</h2>
              <span>{verification?.environment || '—'}</span>
            </div>

            <div className="integrity-grid">
              {strictCards.map((item) => (
                <div key={item.label} className="integrity-item">
                  <span>{item.label}</span>
                  <strong>{yesNo(item.value)}</strong>
                </div>
              ))}
            </div>

            <div className="runtime-grid">
              <div>
                <span>Verified decisions</span>
                <strong>{runtimeProof?.verifiedDecisions ?? 0}</strong>
              </div>
              <div>
                <span>Runtime verified</span>
                <strong>{runtimeProof?.runtimeVerifiedDecisions ?? 0}</strong>
              </div>
              <div>
                <span>Attestation coverage</span>
                <strong>{runtimeAttestation ? `${Math.round(runtimeAttestation.attestationCoverage * 100)}%` : '—'}</strong>
              </div>
              <div>
                <span>Launch ready</span>
                <strong>{yesNo(health?.launchReady as boolean | undefined)}</strong>
              </div>
            </div>
          </article>
        </section>

        <section className="panel-card">
          <div className="panel-head">
            <h2>Latest sessions</h2>
            <span>{sortedSessions.length} entries</span>
          </div>

          <div className="session-grid">
            {sortedSessions.slice(0, 12).map((session) => (
              <article key={session.id} className="session-card">
                <div className="session-top">
                  <span className={`status-chip ${statusTone(session.status)}`}>{statusLabel(session.status)}</span>
                  <span>{relativeTime(session.updatedAt)}</span>
                </div>
                <p>{session.topic}</p>
                <div className="session-actors">
                  <div>
                    <em>{initials(session.proposerAgentId)}</em>
                    <strong>{session.proposerAgentId}</strong>
                  </div>
                  <span>VS</span>
                  <div>
                    <em>{initials(session.counterpartyAgentId)}</em>
                    <strong>{session.counterpartyAgentId || 'OPEN'}</strong>
                  </div>
                </div>
                <small>{session.id}</small>
              </article>
            ))}

            {sortedSessions.length === 0 && <div className="empty-card">No sessions yet.</div>}
          </div>
        </section>

        <section className="panel-card">
          <div className="panel-head">
            <h2>Trusted leaderboard</h2>
            <span>{trusted?.summary.leaderboardAgents ?? 0} agents</span>
          </div>

          <div className="leaderboard-list">
            {(trusted?.leaderboard || []).slice(0, 10).map((row, index) => (
              <div key={row.agentId} className="leader-row">
                <div className="leader-rank">#{index + 1}</div>
                <div className="leader-id">{row.agentId}</div>
                <div className="leader-metrics">{row.agreements} agreements · {row.trustScore} trust</div>
                <div className="leader-total">{row.trustedSessions} trusted</div>
              </div>
            ))}
            {(!trusted || trusted.leaderboard.length === 0) && (
              <div className="empty-card">No trusted entries yet.</div>
            )}
          </div>
        </section>

        {(warnings.length > 0 || lastUpdated) && (
          <footer className="panel-footer">
            {warnings.length > 0 ? <div>Warning: {warnings.join(' · ')}</div> : <div>All feeds synced.</div>}
            <small>{loading ? 'Loading…' : `Updated ${relativeTime(lastUpdated)}`}</small>
          </footer>
        )}
      </section>
    </main>
  );
}
