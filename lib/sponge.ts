import { SpongePlatform, SpongeWallet } from "@paysponge/sdk";

const masterKey = process.env.SPONGE_MASTER_API_KEY;
const baseUrl = process.env.SPONGE_BASE_URL || undefined;

let platformPromise: Promise<SpongePlatform> | null = null;

function getPlatform(): Promise<SpongePlatform> {
  if (!masterKey) throw new Error("SPONGE_MASTER_API_KEY is not set");
  if (!platformPromise) {
    platformPromise = SpongePlatform.connect({ apiKey: masterKey, baseUrl });
  }
  return platformPromise;
}

export type BusinessSpongeWallet = {
  agentId: string;
  agentApiKey: string;
  baseAddress: string | null;
  solanaAddress: string | null;
};

export async function createBusinessWallet(input: {
  businessName: string;
  placeId: string;
  dailySpendingLimitUsd?: string;
}): Promise<BusinessSpongeWallet> {
  const platform = await getPlatform();
  const created = await platform.createAgent({
    name: `Receptionist · ${input.businessName}`.slice(0, 80),
    description: `AI phone receptionist wallet for placeId ${input.placeId}`,
    dailySpendingLimit: input.dailySpendingLimitUsd ?? "5",
  });

  let baseAddress: string | null = null;
  let solanaAddress: string | null = null;
  try {
    const wallet = await connectAgentWallet(created.apiKey, created.agent.id);
    const addrs = await wallet.getAddresses();
    baseAddress = addrs.base ?? null;
    solanaAddress = addrs.solana ?? null;
  } catch (err) {
    console.warn(`[sponge] failed to fetch initial wallet addresses:`, (err as Error).message);
  }

  return {
    agentId: created.agent.id,
    agentApiKey: created.apiKey,
    baseAddress,
    solanaAddress,
  };
}

async function connectAgentWallet(agentApiKey: string, agentId: string): Promise<SpongeWallet> {
  const platform = await getPlatform();
  return platform.connectAgent({ apiKey: agentApiKey, agentId });
}

export type WalletBalanceView = {
  baseUsdc: number;
  solanaUsdc: number;
  totalUsdc: number;
};

export async function getBusinessWalletBalance(input: {
  agentApiKey: string;
  agentId: string;
}): Promise<WalletBalanceView> {
  const wallet = await connectAgentWallet(input.agentApiKey, input.agentId);
  const detail = await wallet.getDetailedBalances({ onlyUsdc: true });
  let baseUsdc = 0;
  let solanaUsdc = 0;
  for (const [chain, info] of Object.entries(detail)) {
    const usdc = (info.balances ?? []).find((b) => b.token === "USDC");
    const amount = usdc ? Number.parseFloat(usdc.amount) : 0;
    if (chain === "base") baseUsdc = amount;
    else if (chain === "solana") solanaUsdc = amount;
  }
  return { baseUsdc, solanaUsdc, totalUsdc: baseUsdc + solanaUsdc };
}

export async function createTopUpLink(input: {
  agentApiKey: string;
  agentId: string;
  walletAddress: string;
  fiatAmountUsd: string;
  redirectUrl?: string;
  chain?: "base" | "solana" | "polygon";
}): Promise<string> {
  const wallet = await connectAgentWallet(input.agentApiKey, input.agentId);
  const resp = await wallet.onrampCrypto({
    wallet_address: input.walletAddress,
    chain: input.chain ?? "base",
    fiat_amount: input.fiatAmountUsd,
    fiat_currency: "USD",
    lock_wallet_address: true,
    redirect_url: input.redirectUrl,
  });
  return resp.url;
}

export async function transferFromBusinessToPlatform(input: {
  agentApiKey: string;
  agentId: string;
  amountUsdc: string;
  toAddress: string;
  chain?: "base" | "solana";
}): Promise<{ txHash: string; explorerUrl?: string }> {
  const wallet = await connectAgentWallet(input.agentApiKey, input.agentId);
  const chain = input.chain ?? "base";
  const result =
    chain === "base"
      ? await wallet.evmTransfer({
          chain: "base",
          to: input.toAddress,
          amount: input.amountUsdc,
          currency: "USDC",
        })
      : await wallet.solanaTransfer({
          chain: "solana",
          to: input.toAddress,
          amount: input.amountUsdc,
          currency: "USDC",
        });
  return { txHash: result.transactionHash, explorerUrl: result.explorerUrl };
}
