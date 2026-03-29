import axios from 'axios';
import { ethers } from 'ethers';
import { config } from '../config.js';

const { clobUrl, gammaUrl, chainId, exchangeContract } = config.polymarket;

// ── Wallet ──────────────────────────────────────────────────────────────────
function createWallet() {
  if (!config.privateKey) throw new Error('PRIVATE_KEY não configurada');
  return new ethers.Wallet(config.privateKey);
}

// ── Auth L1 (EIP-712) ────────────────────────────────────────────────────────
async function l1Headers(wallet) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sig = await wallet.signTypedData(
    { name: 'ClobAuthDomain', version: '1', chainId },
    {
      ClobAuth: [
        { name: 'address',   type: 'address' },
        { name: 'timestamp', type: 'string'  },
        { name: 'nonce',     type: 'uint256' },
        { name: 'message',   type: 'string'  },
      ],
    },
    {
      address:   wallet.address,
      timestamp,
      nonce:     0,
      message:   'This message attests that I control the given wallet',
    }
  );
  return { 'POLY_ADDRESS': wallet.address, 'POLY_SIGNATURE': sig, 'POLY_TIMESTAMP': timestamp, 'POLY_NONCE': '0' };
}

// ── API Creds (gera ou usa env) ───────────────────────────────────────────────
let _creds = null;
export async function getApiCreds() {
  if (_creds) return _creds;

  // Se já tem API key nas vars de ambiente, usa direto
  if (config.polymarket.apiKey) {
    const wallet = createWallet();
    _creds = { apiKey: config.polymarket.apiKey, apiSecret: config.polymarket.apiSecret, passphrase: config.polymarket.passphrase, wallet };
    return _creds;
  }

  // Gera nova API key via L1 auth
  const wallet  = createWallet();
  const headers = await l1Headers(wallet);
  const res     = await axios.post(`${clobUrl}/auth/api-key`, {}, { headers });
  _creds = { apiKey: res.data.apiKey, apiSecret: res.data.secret, passphrase: res.data.passphrase, wallet };
  return _creds;
}

function hmacAuth(creds, method, path, body = '') {
  const ts  = Math.floor(Date.now() / 1000).toString();
  const msg = ts + method + path + body;
  const mac = ethers.computeHmac('sha256', ethers.toUtf8Bytes(creds.apiSecret), ethers.toUtf8Bytes(msg));
  return {
    'POLY-API-KEY':    creds.apiKey,
    'POLY-PASSPHRASE': creds.passphrase,
    'POLY-TIMESTAMP':  ts,
    'POLY-SIGNATURE':  ethers.hexlify(mac),
    'Content-Type':    'application/json',
  };
}

// ── Mercados ──────────────────────────────────────────────────────────────────
export async function findActiveBtcMarket() {
  const res = await axios.get(`${gammaUrl}/events`, {
    params: { slug_contains: 'btc-updown-5m', active: true, limit: 5 },
    timeout: 8000,
  });

  const events = Array.isArray(res.data) ? res.data : res.data?.data || [];
  const event  = events.sort((a, b) => (b.startDate || 0) - (a.startDate || 0))[0];
  if (!event) throw new Error('Nenhum mercado BTC 5m ativo');

  const markets    = event.markets || [];
  const upMarket   = markets.find(m => /up|higher/i.test(m.question))  || markets[0];
  const downMarket = markets.find(m => /down|lower/i.test(m.question)) || markets[1];

  async function enrich(m) {
    if (!m) return null;
    try {
      const r = await axios.get(`${clobUrl}/market/${m.conditionId}`, { timeout: 5000 });
      const d = r.data;
      const yes = d.tokens?.find(t => t.outcome === 'Yes');
      const no  = d.tokens?.find(t => t.outcome === 'No');
      return {
        conditionId: m.conditionId,
        question:    m.question,
        yesTokenId:  yes?.token_id,
        noTokenId:   no?.token_id,
        yesPrice:    parseFloat(yes?.price || 0.5),
        noPrice:     parseFloat(no?.price  || 0.5),
        active:      d.active,
      };
    } catch {
      return { ...m, yesPrice: 0.5, noPrice: 0.5, active: true };
    }
  }

  return {
    eventId:   event.id,
    eventSlug: event.slug,
    endTime:   event.endDate ? new Date(event.endDate * 1000) : null,
    up:        await enrich(upMarket),
    down:      await enrich(downMarket),
  };
}

// ── Ordens ────────────────────────────────────────────────────────────────────
async function signOrder(wallet, { tokenId, side, makerAmount, takerAmount }) {
  const order = {
    salt:          BigInt(Math.floor(Math.random() * 1e15)),
    maker:         wallet.address,
    signer:        wallet.address,
    taker:         '0x0000000000000000000000000000000000000000',
    tokenId:       BigInt(tokenId),
    makerAmount:   BigInt(Math.round(makerAmount * 1e6)),
    takerAmount:   BigInt(Math.round(takerAmount * 1e6)),
    expiration:    0n,
    nonce:         0n,
    feeRateBps:    0n,
    side:          side === 'BUY' ? 0 : 1,
    signatureType: 0,
  };
  const sig = await wallet.signTypedData(
    { name: 'Polymarket CTF Exchange', version: '1', chainId, verifyingContract: exchangeContract },
    {
      Order: [
        { name: 'salt',          type: 'uint256' },
        { name: 'maker',         type: 'address' },
        { name: 'signer',        type: 'address' },
        { name: 'taker',         type: 'address' },
        { name: 'tokenId',       type: 'uint256' },
        { name: 'makerAmount',   type: 'uint256' },
        { name: 'takerAmount',   type: 'uint256' },
        { name: 'expiration',    type: 'uint256' },
        { name: 'nonce',         type: 'uint256' },
        { name: 'feeRateBps',    type: 'uint256' },
        { name: 'side',          type: 'uint8'   },
        { name: 'signatureType', type: 'uint8'   },
      ],
    },
    order
  );
  return { ...order, signature: sig };
}

export async function placeBet({ direction, betSize, market }) {
  const isUp     = direction === 'UP';
  const side     = isUp ? market.up : market.down;
  const tokenId  = side?.yesTokenId;
  const odds     = side?.yesPrice || 0.5;
  const profit   = betSize / odds - betSize;

  if (config.dryRun) {
    return { simulated: true, direction, odds, betSize, potentialProfit: profit, txHash: null };
  }

  if (!tokenId) throw new Error('Token ID não encontrado para ' + direction);

  const creds  = await getApiCreds();
  const order  = await signOrder(creds.wallet, { tokenId, side: 'BUY', makerAmount: betSize, takerAmount: betSize / odds });

  const body = JSON.stringify({
    order: {
      ...order,
      salt:        order.salt.toString(),
      tokenId:     order.tokenId.toString(),
      makerAmount: order.makerAmount.toString(),
      takerAmount: order.takerAmount.toString(),
    },
    owner:     creds.wallet.address,
    orderType: 'FOK',
  });

  const path    = '/order';
  const headers = hmacAuth(creds, 'POST', path, body);
  const res     = await axios.post(`${clobUrl}${path}`, body, { headers, timeout: 10000 });

  return { simulated: false, direction, odds, betSize, potentialProfit: profit, txHash: res.data?.transactionHash || res.data?.orderID };
}

export async function getBalance() {
  if (!config.privateKey) return null;
  try {
    const wallet   = createWallet();
    const provider = new ethers.JsonRpcProvider('https://polygon-rpc.com');
    const usdc     = new ethers.Contract(config.polymarket.usdcContract, ['function balanceOf(address) view returns (uint256)'], provider);
    const raw      = await usdc.balanceOf(wallet.address);
    return parseFloat(ethers.formatUnits(raw, 6));
  } catch { return null; }
}
