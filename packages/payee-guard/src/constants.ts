export const USDC: Readonly<Record<string, string>> = {
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base mainnet
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // Solana mainnet
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // Solana devnet
  "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // Solana testnet
};

export const BINDING_PATH = "/.well-known/spendmandate-payees.json";

export const BINDING_SIGNING_PREFIX = "spendmandate-payee-binding/v1\n";
