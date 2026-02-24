import { ethers } from 'ethers';

const [,, usdcToken, escrowContract, sessionIdHex, amountPerPlayer] = process.argv;

if (!usdcToken || !escrowContract || !sessionIdHex || !amountPerPlayer) {
  console.error('Usage: node scripts/depositEscrow.mjs <USDC_TOKEN_ADDRESS> <ESCROW_CONTRACT_ADDRESS> <SESSION_ID_HEX> <AMOUNT_PER_PLAYER_6DP>');
  process.exit(1);
}

const rpcUrl = process.env.SEPOLIA_RPC_URL;
const playerKey = process.env.PLAYER_PRIVATE_KEY;

if (!rpcUrl || !playerKey) {
  throw new Error('Missing SEPOLIA_RPC_URL or PLAYER_PRIVATE_KEY');
}

const provider = new ethers.JsonRpcProvider(rpcUrl);
const wallet = new ethers.Wallet(playerKey, provider);

const usdcAbi = [
  'function approve(address spender, uint256 amount) external returns (bool)'
];

const escrowAbi = [
  'function deposit(bytes32 sessionId, uint256 amount) external'
];

const usdc = new ethers.Contract(usdcToken, usdcAbi, wallet);
const escrow = new ethers.Contract(escrowContract, escrowAbi, wallet);

console.log('Player wallet:', wallet.address);
console.log('Approving USDC...');
const approveTx = await usdc.approve(escrowContract, BigInt(amountPerPlayer));
console.log('approve tx:', approveTx.hash);
await approveTx.wait();

console.log('Depositing into escrow...');
const depositTx = await escrow.deposit(sessionIdHex, BigInt(amountPerPlayer));
console.log('deposit tx:', depositTx.hash);
await depositTx.wait();

console.log('✅ Deposit complete for session', sessionIdHex);
