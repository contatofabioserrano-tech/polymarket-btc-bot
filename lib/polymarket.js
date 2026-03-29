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
// Horário NYSE: 9:20 AM – 4:00 PM ET (EDT = UTC-4)
const NYSE_OPEN_SECONDS  = (9 * 60 + 20) * 60;   // 9:20 AM em segundos desde meia-noite
const NYSE_CLOSE_SECONDS = (16 * 60)     * 60;   // 4:00 PM em segundos desde meia-noite
const EDT_OFFSET         = 4 * 3600;              // EDT = UTC-4

function isNyseOpen(nowUtc = Math.floor(Date.now() / 1000)) {
  const etSeconds = (nowUtc - EDT_OFFSET) % 86400;
  const dayOfWeek = new Date(nowUtc * 1000).getUTCDay();
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  return isWeekday && etSeconds >= NYSE_OPEN_SECONDS && etSeconds < NYSE_CLOSE_SECONDS;
}

function nextNyseOpen(nowUtc = Math.floor(Date.now() / 1000)) {
  let ts = nowUtc;
  for (let i = 0; i < 10; i++) {
    ts += 300;
    const etSeconds = (ts - EDT_OFFSET) % 86400;
    const dayOfWeek = new Date(ts * 1000).getUTCDay();
    const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
    if (isWeekday && etSeconds >= NYSE_OPEN_SECONDS && etSeconds < NYSE_CLOSE_SECONDS) {
      return Math.floor(ts / 300) * 300;
    }
  }
  // Pula para próximo dia útil
  ts = nowUtc;
  for (let d = 1; d <= 5; d++) {
    const nextDay = ts + d * 86400;
    const dayOfWeek = new Date(nextDay * 1000).getUTCDay();
    if (dayOfWeek >= 1 && dayOfWeek <= 5) {
      // Midnight ET + NYSE_OPEN_SECONDS + EDT_OFFSET
      const midnight = Math.floor((nextDay - EDT_OFFSET) / 86400) * 86400 + EDT_OFFSET;
      return midnight + NYSE_OPEN_SECONDS;
    }
  }
  return null;
}

export async function findActiveBtcMarket() {
  const nowUtc = Math.floor(Date.now() / 1000);

  if (!isNyseOpen(nowUtc)) {
    const next = nextNyseOpen(nowUtc);
    const nextDate = next ? new Date(next * 1000).toLocaleString('pt-BR', { timeZone: 'America/New_York' }) : '?';
    throw new Error(`Fora do horário NYSE (9:20AM–4PM ET). Próxima sessão: ${nextDate} ET`);
  }

  // Gera slug do slot atual (múltiplo de 300 segundos em UTC = start time)
  const currentSlot = Math.floor(nowUtc / 300) * 300;

  // Tenta slot atual e os próximos 3
  for (let i = 0; i <= 3; i++) {
    const slotTs  = currentSlot + i * 300;
    const slug    = `btc-updown-5m-${slotTs}`;

    try {
      // 1. Busca conditionId no Gamma pelo slug
      const gRes = await axios.get(`${gammaUrl}/markets`, {
        params: { slug, limit: 1 },
        timeout: 8000,
      });
      const gData = Array.isArray(gRes.data) ? gRes.data : [];
      const gMkt  = gData.find(m => m.slug === slug);
      if (!gMkt?.conditionId) continue;

      // 2. Busca detalhes no CLOB pelo conditionId
      const cRes = await axios.get(`${clobUrl}/markets/${gMkt.conditionId}`, { timeout: 5000 });
      const d    = cRes.data;

      if (!d.accepting_orders) continue; // mercado não está aceitando ordens

      // Tokens: outcome = "Up" e "Down"
      const upTok   = d.tokens?.find(t => /up/i.test(t.outcome));
      const downTok = d.tokens?.find(t => /down/i.test(t.outcome));

      if (!upTok || !downTok) continue;

      const endTime = new Date((slotTs + 300) * 1000);

      return {
        conditionId: gMkt.conditionId,
        slug,
        question:    d.question,
        endTime,
        accepting:   true,
        up: {
          conditionId: gMkt.conditionId,
          yesTokenId:  upTok.token_id,
          yesPrice:    parseFloat(upTok.price || 0.5),
        },
        down: {
          conditionId: gMkt.conditionId,
          yesTokenId:  downTok.token_id,
          yesPrice:    parseFloat(downTok.price || 0.5),
        },
      };
    } catch (e) {
      continue;
    }
  }

  throw new Error('Nenhum mercado BTC 5m aceitando ordens agora');
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
