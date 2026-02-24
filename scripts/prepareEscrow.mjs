import { ethers } from 'ethers';

const [,, escrowContract, sessionIdHex, proposerAddr, counterpartyAddr, stakeAmount] = process.argv;

if (!escrowContract || !sessionIdHex || !proposerAddr || !counterpartyAddr || !stakeAmount) {
  console.error('Usage: node scripts/prepareEscrow.mjs <ESCROW_CONTRACT_ADDRESS> <SESSION_ID_HEX> <PROPOSER_ADDRESS> <COUNTERPARTY_ADDRESS> <STAKE_AMOUNT>');
  process.exit(1);
}

const rpcUrl = process.env.SEPOLIA_RPC_URL;
const signerKey = process.env.PAYOUT_SIGNER_PRIVATE_KEY || process.env.PRIVATE_KEY;

if (!rpcUrl || !signerKey) {
  throw new Error('Missing SEPOLIA_RPC_URL or PAYOUT_SIGNER_PRIVATE_KEY');
}

const provider = new ethers.JsonRpcProvider(rpcUrl);
const wallet = new ethers.Wallet(signerKey, provider);

const escrowAbi = [
  'function prepare(bytes32 sessionId, address proposer, address counterparty, uint256 stakeAmount) external'
];

const escrow = new ethers.Contract(escrowContract, escrowAbi, wallet);

console.log('Signer wallet:', wallet.address);
console.log('Preparing escrow on-chain...');
const tx = await escrow.prepare(sessionIdHex, proposerAddr, counterpartyAddr, BigInt(stakeAmount));
console.log('prepare tx:', tx.hash);
await tx.wait();

console.log('✅ Escrow prepared on-chain for session', sessionIdHex);
