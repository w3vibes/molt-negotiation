import Fastify from 'fastify';
import { ethers } from 'ethers';
import { createHash } from 'node:crypto';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });

// ============ CONFIGURATION - ONLY PRIVATE KEY NEEDED ============
// Everything else (appId, signerAddress, imageDigest) comes from agent registration in API
const AGENT_NAME = process.env.AGENT_NAME || 'Negotiator';
const ECLOUD_PRIVATE_KEY = process.env.ECLOUD_PRIVATE_KEY || process.env.PAYOUT_SIGNER_PRIVATE_KEY || '';

const PROFILE = {
  name: AGENT_NAME,
  style: 'strategic-concession',
  aggression: Number(process.env.AGGRESSION || 0.7),
  anchorWeight: Number(process.env.ANCHOR_WEIGHT || 0.25)
};

const SESSIONS = new Map();

// Derive signer address from private key
let AGENT_SIGNER_ADDRESS = '';
if (ECLOUD_PRIVATE_KEY) {
  try {
    const wallet = new ethers.Wallet(ECLOUD_PRIVATE_KEY);
    AGENT_SIGNER_ADDRESS = wallet.address.toLowerCase();
  } catch (e) {
    // Invalid key, will handle later
  }
}

// ============ CRYPTO HELPERS ============
function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function canonicalStringify(obj) {
  if (obj === null || obj === undefined) return '';
  if (typeof obj !== 'object') return String(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalStringify).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => `"${k}":${canonicalStringify(obj[k])}`).join(',') + '}';
}

function computeDecisionHash(input) {
  const payload = {
    protocol: 'MOLT_NEGOTIATION_TURN_PROOF',
    version: 'v1',
    sessionId: input.sessionId,
    turn: input.turn,
    agentId: input.agentId,
    role: input.role,
    offer: Number(input.offer.toFixed(4)),
    challenge: input.challenge.toLowerCase(),
    appId: input.appId,
    environment: input.environment,
    imageDigest: input.imageDigest,
    timestamp: input.timestamp
  };
  return '0x' + sha256Hex(canonicalStringify(payload));
}

function buildProofMessage(input) {
  return [
    'MOLT_NEGOTIATION_TURN_PROOF',
    'v1',
    input.sessionId,
    String(input.turn),
    input.agentId,
    input.role,
    Number(input.offer.toFixed(4)).toString(),
    input.challenge.toLowerCase(),
    input.decisionHash,
    input.appId || '',
    input.environment || '',
    input.imageDigest || '',
    input.timestamp
  ].join('|');
}

// ============ UTILITY FUNCTIONS ============
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizePayload(body) {
  if (!body || typeof body !== 'object') return null;
  
  return {
    sessionId: body.sessionId,
    topic: body.topic,
    turn: clamp(toNumber(body.turn, 1), 1, 100),
    maxTurns: clamp(toNumber(body.maxTurns, 10), 1, 100),
    role: body.role,
    agentId: body.agentId,
    challenge: body.challenge,
    privateContext: body.privateContext,
    publicState: body.publicState,
    // These come from the API's registered agent metadata, not from the request
    expectedProofBinding: body.expectedProofBinding
  };
}

function getSession(sessionId) {
  let session = SESSIONS.get(sessionId);
  if (!session) {
    session = {
      id: sessionId,
      seenTurns: 0,
      priorOffers: [],
      recentDecisions: []
    };
    SESSIONS.set(sessionId, session);
  }
  return session;
}

// ============ STRATEGY ENGINE ============
function calculateOffer(params) {
  const { context, publicState, turn, maxTurns, role } = params;
  const isBuyer = role === 'buyer';
  
  const reservation = toNumber(context?.strategy?.reservationPrice, 100);
  const strategy = context?.strategy || {};
  const initialPrice = toNumber(strategy.initialPrice);
  const concessionStep = toNumber(strategy.concessionStep, 5);
  
  const opponentLastOffer = isBuyer 
    ? toNumber(publicState?.latestSellerAsk)
    : toNumber(publicState?.latestBuyerOffer);
  
  const priorTurns = publicState?.priorTurns || [];
  const progress = Math.min(1, turn / Math.max(1, maxTurns * 0.8));
  
  let offer;
  const baseConcession = concessionStep;
  
  if (isBuyer) {
    const buyerStart = Math.min(reservation - 1, initialPrice || reservation - baseConcession * 2);
    const buyerEnd = reservation - 1;
    offer = buyerStart + (buyerEnd - buyerStart) * Math.pow(progress, 1 - PROFILE.aggression * 0.35);
  } else {
    const sellerStart = Math.max(reservation + 1, initialPrice || reservation + baseConcession * 2);
    const sellerEnd = reservation + 1;
    offer = sellerStart - (sellerStart - sellerEnd) * Math.pow(progress, 1 - PROFILE.aggression * 0.35);
  }
  
  if (opponentLastOffer && priorTurns.length > 0) {
    const midpoint = (offer + opponentLastOffer) / 2;
    offer = offer * (1 - PROFILE.anchorWeight) + midpoint * PROFILE.anchorWeight;
  }
  
  const noise = (Math.random() - 0.5) * baseConcession * 0.2;
  offer += noise;
  
  offer = Math.round(offer * 100) / 100;
  
  if (isBuyer) {
    offer = Math.max(0, Math.min(reservation - 0.01, offer));
  } else {
    offer = Math.max(reservation + 0.01, offer);
  }
  
  return offer;
}

// ============ DECISION WITH PROOF ============
async function makeDecision(payload) {
  const { sessionId, turn, maxTurns, role, agentId, challenge, privateContext, publicState } = payload;
  
  const offer = calculateOffer({
    context: privateContext,
    publicState,
    turn,
    maxTurns,
    role
  });
  
  const timestamp = new Date().toISOString();
  
  // Get expected binding from the request (provided by API from registered metadata)
  const binding = payload.expectedProofBinding || {};
  
  // Build proof if we have private key
  if (ECLOUD_PRIVATE_KEY && AGENT_SIGNER_ADDRESS) {
    const decisionHash = computeDecisionHash({
      sessionId,
      turn,
      agentId,
      role,
      offer,
      challenge,
      appId: binding.appId || '',
      environment: binding.environment,
      imageDigest: binding.imageDigest,
      timestamp
    });
    
    const wallet = new ethers.Wallet(ECLOUD_PRIVATE_KEY);
    const message = buildProofMessage({
      sessionId,
      turn,
      agentId,
      role,
      offer,
      challenge,
      decisionHash,
      appId: binding.appId || '',
      environment: binding.environment,
      imageDigest: binding.imageDigest,
      timestamp
    });
    
    const signature = await wallet.signMessage(message);
    
    return {
      offer,
      proof: {
        version: 'v1',
        sessionId,
        turn,
        agentId,
        challenge,
        decisionHash,
        appId: binding.appId || '',
        environment: binding.environment || '',
        imageDigest: binding.imageDigest || '',
        signer: AGENT_SIGNER_ADDRESS,
        signature,
        timestamp
      }
    };
  }
  
  // No signing key, return just offer
  return { offer };
}

function decide(payload) {
  const session = getSession(payload.sessionId);
  session.seenTurns += 1;
  
  const offer = calculateOffer({
    context: payload.privateContext,
    publicState: payload.publicState,
    turn: payload.turn,
    maxTurns: payload.maxTurns,
    role: payload.role
  });
  
  session.priorOffers.push(offer);
  session.recentDecisions.push({ turn: payload.turn, offer });
  
  if (session.recentDecisions.length > 20) {
    session.recentDecisions.shift();
  }
  
  return { offer };
}

// ============ ROUTES ============
app.get('/health', async () => ({
  ok: true,
  name: PROFILE.name,
  style: PROFILE.style,
  hasSigner: !!AGENT_SIGNER_ADDRESS,
  signerAddress: AGENT_SIGNER_ADDRESS,
  activeSessions: SESSIONS.size
}));

app.get('/profile', async () => ({
  ok: true,
  profile: PROFILE,
  notes: 'Strategic concession negotiation agent with EigenCompute proof signing'
}));

app.post('/decide', async (req) => {
  try {
    const payload = normalizePayload(req.body);
    if (!payload || !payload.sessionId || !payload.turn) {
      return { offer: 0 };
    }

    // If we have signing credentials and expected binding, create proof
    if (ECLOUD_PRIVATE_KEY && AGENT_SIGNER_ADDRESS && payload.expectedProofBinding) {
      const decision = await makeDecision(payload);
      return decision;
    }
    
    // Otherwise just return offer without proof
    const decision = decide(payload);
    return decision;
  } catch (error) {
    req.log.error({ error }, 'decision_failure_fallback');
    return { offer: 0 };
  }
});

const port = Number(process.env.PORT || 3000);
app.listen({ port, host: '0.0.0.0' })
  .then(() => app.log.info({ 
    name: PROFILE.name, 
    port, 
    hasSigner: !!AGENT_SIGNER_ADDRESS 
  }, 'agent_endpoint_ready'))
  .catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
