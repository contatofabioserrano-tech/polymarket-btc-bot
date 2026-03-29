import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));

try {
  const lines = readFileSync(join(__dir, '.env'), 'utf8').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [k, ...v] = t.split('=');
    if (k && v.length) process.env[k.trim()] = v.join('=').trim();
  }
} catch {}

export const config = {
  port:       parseInt(process.env.PORT || '3000'),
  privateKey: process.env.PRIVATE_KEY || '',

  telegram: {
    token:  process.env.TELEGRAM_TOKEN  || '8294348983:AAFBYMXJ96UNyX-2xZhAhAKfAQgGuwPq-uw',
    chatId: process.env.TELEGRAM_CHAT_ID || '7394238926',
  },

  maxBets:       parseInt(process.env.MAX_BETS    || '20'),
  betSize:       parseFloat(process.env.BET_SIZE  || '2'),
  minConfidence: parseFloat(process.env.MIN_CONFIDENCE || '0.65'),
  maxLossStreak: parseInt(process.env.MAX_LOSS_STREAK  || '5'),
  dryRun:        process.env.DRY_RUN !== 'false',

  polymarket: {
    clobUrl:          'https://clob.polymarket.com',
    gammaUrl:         'https://gamma-api.polymarket.com',
    chainId:          137,
    exchangeContract: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
    usdcContract:     '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    // API Key (opcional — o bot gera automaticamente via privateKey)
    apiKey:           process.env.POLY_API_KEY        || '',
    apiSecret:        process.env.POLY_API_SECRET     || '',
    passphrase:       process.env.POLY_PASSPHRASE     || '',
  },

  signals: {
    minMomentum:    0.18,
    candleCount:    15,
    rsiThreshold:   52,
    minVolumeRatio: 1.1,
    minOdds:        0.30,
    maxOdds:        0.75,
  },
};
