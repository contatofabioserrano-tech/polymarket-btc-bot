// lib/signals.js — Sinais de BTC usando Binance API (gratuita, sem chave)
import axios from 'axios';
import { config } from '../config.js';

const BINANCE = 'https://api.binance.com/api/v3';

// Busca candles 1m do BTC/USDT
async function getCandles(count = 15) {
  const res = await axios.get(`${BINANCE}/klines`, {
    params: {
      symbol: 'BTCUSDT',
      interval: '1m',
      limit: count,
    },
    timeout: 5000,
  });
  // [openTime, open, high, low, close, volume, ...]
  return res.data.map(c => ({
    open:   parseFloat(c[1]),
    high:   parseFloat(c[2]),
    low:    parseFloat(c[3]),
    close:  parseFloat(c[4]),
    volume: parseFloat(c[5]),
  }));
}

// Preço atual do BTC
async function getCurrentPrice() {
  const res = await axios.get(`${BINANCE}/ticker/price`, {
    params: { symbol: 'BTCUSDT' },
    timeout: 3000,
  });
  return parseFloat(res.data.price);
}

// RSI simplificado
function calcRSI(closes, period = 9) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

// Calcula média
function avg(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

// Engine principal de sinal
export async function analyzeSignal() {
  const { minMomentum, rsiThreshold, minVolumeRatio } = config.signals;

  const candles = await getCandles(config.signals.candleCount + 1);
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  const currentPrice  = closes.at(-1);
  const price3mAgo    = closes.at(-4);  // 3 candles atrás
  const momentum      = ((currentPrice - price3mAgo) / price3mAgo) * 100;

  const rsi           = calcRSI(closes);
  const avgVolume     = avg(volumes.slice(0, -1));
  const currentVolume = volumes.at(-1);
  const volumeRatio   = currentVolume / avgVolume;

  // Calcula confiança baseada em múltiplos fatores
  let confidence = 0;
  let direction  = null;

  const absMomentum = Math.abs(momentum);

  if (momentum > minMomentum && rsi > rsiThreshold) {
    direction  = 'UP';
    confidence = Math.min(
      0.50                                           // base
      + Math.min(absMomentum / 0.5, 0.20)           // momentum até +20%
      + (rsi > 60 ? 0.10 : rsi > 55 ? 0.05 : 0)    // RSI forte
      + (volumeRatio > minVolumeRatio ? 0.10 : 0)   // volume acima da média
      , 0.90
    );
  } else if (momentum < -minMomentum && rsi < (100 - rsiThreshold)) {
    direction  = 'DOWN';
    confidence = Math.min(
      0.50
      + Math.min(absMomentum / 0.5, 0.20)
      + (rsi < 40 ? 0.10 : rsi < 45 ? 0.05 : 0)
      + (volumeRatio > minVolumeRatio ? 0.10 : 0)
      , 0.90
    );
  }

  return {
    direction,
    confidence,
    momentum,
    rsi,
    volumeRatio,
    currentPrice,
    timestamp: new Date().toISOString(),
    shouldBet: direction !== null && confidence >= config.minConfidence,
  };
}

// Teste: node lib/signals.js
if (process.argv[1].includes('signals.js')) {
  const sig = await analyzeSignal();
  console.log('\n=== SINAL BTC ===');
  console.log(`Preço atual:  $${sig.currentPrice.toLocaleString()}`);
  console.log(`Momentum:     ${sig.momentum > 0 ? '+' : ''}${sig.momentum.toFixed(3)}%`);
  console.log(`RSI:          ${sig.rsi.toFixed(1)}`);
  console.log(`Volume ratio: ${sig.volumeRatio.toFixed(2)}x`);
  console.log(`Direção:      ${sig.direction || 'NEUTRO'}`);
  console.log(`Confiança:    ${(sig.confidence * 100).toFixed(0)}%`);
  console.log(`Apostar?      ${sig.shouldBet ? '✅ SIM' : '❌ NÃO'}`);
}
