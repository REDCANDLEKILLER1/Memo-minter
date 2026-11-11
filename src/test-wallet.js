/**
 * XRPMan disposable Testnet/Devnet funding.
 * Only public account addresses are sent to the XRPL faucet.
 * A confirmed, positive VALIDATED ledger balance gates a "funded" status.
 */
export const NON_MAINNET_NETWORKS = Object.freeze(["testnet", "devnet"]);
export const MIN_TEST_BALANCE_DROPS = 1;

export function assertTestNetwork(network) {
  if (!NON_MAINNET_NETWORKS.includes(network)) {
    throw new Error("Only XRPL Testnet and Devnet wallets may be funded.");
  }
}

export function validatedDrops(response, address) {
  const r = response?.result;
  if (r?.account_data?.Account !== address) {
    throw new Error("Wallet balance account mismatch.");
  }
  const drops = r?.account_data?.Balance;
  if (typeof drops !== "string" || !/^\d+$/.test(drops)) {
    throw new Error("Invalid wallet balance from XRPL.");
  }
  return BigInt(drops);
}
export function isMissingAccount(error) {
  const value = String(error?.data?.error || error?.message || "");
  return /actNotFound|Account not found|accountNotFound/i.test(value);
}
export async function readValidatedDrops(client, address) {
  try {
    const result = await client.request({command: "account_info", account: address, ledger_index: "validated"});
    return validatedDrops(result, address);
  } catch (err) {
    if (isMissingAccount(err)) return 0n;
    throw err; // Node outages are not evidence of an unfunded wallet.
  }
}
export async function fundAndVerifyTestWallet({
  client, wallet, network, onStatus = () => {}, maxPolls = 5,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms))
}) {
  assertTestNetwork(network);
  if (!client?.isConnected?.() || !wallet?.address) throw new Error("Test network and local wallet required.");
  let balance = await readValidatedDrops(client, wallet.address);
  if (balance >= BigInt(MIN_TEST_BALANCE_DROPS)) {
    onStatus("existing-funded");
    return {balanceDrops: balance, alreadyFunded: true};
  }
  onStatus("request-faucet");
  // fundWallet(wallet) asks the known Testnet/Devnet faucet to fund wallet.address.
  // Never submit the seed, public/private keys, or seed JSON to the faucet endpoint.
  const result = await client.fundWallet(wallet, {usageContext: "XRPMan Memo Minter test wallet"});
  if (result?.wallet?.address !== wallet.address) {
    throw new Error("Faucet returned the wrong wallet identity.");
  }
  for (let index = 0; index < maxPolls; index++) {
    onStatus("verify-ledger");
    balance = await readValidatedDrops(client, wallet.address);
    if (balance >= BigInt(MIN_TEST_BALANCE_DROPS)) {
      return {balanceDrops: balance, alreadyFunded: false};
    }
    if (index < maxPolls - 1) await pause(1800);
  }
  throw new Error("Faucet funding was requested, but no validated ledger balance was confirmed. Check again; do not create a replacement wallet.");
}
