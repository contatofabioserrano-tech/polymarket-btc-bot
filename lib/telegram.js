// lib/telegram.js — Notificações Telegram para o bot de apostas
import axios from 'axios';
import { config } from '../config.js';

const BASE = `https://api.telegram.org/bot${config.telegram.token}`;

async function send(text) {
  try {
    await axios.post(`${BASE}/sendMessage`, {
      chat_id: config.telegram.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error('[Telegram] Erro ao enviar:', err.message);
  }
}

export const telegram = {
  // Notifica início do bot
  async botStart({ dryRun, maxBets, betSize }) {
    const mode = dryRun ? '🧪 SIMULAÇÃO' : '💰 REAL';
    await send(
      `🤖 <b>Polymarket BTC Bot iniciado</b>\n` +
      `Modo: ${mode}\n` +
      `Apostas: ${maxBets}x $${betSize} = $${maxBets * betSize} total\n` +
      `Mercado: BTC Up/Down 5m`
    );
  },

  // Notifica sinal identificado
  async signal({ direction, momentum, rsi, confidence, marketPrice }) {
    const emoji = direction === 'UP' ? '📈' : '📉';
    await send(
      `${emoji} <b>Sinal ${direction}</b>\n` +
      `Momentum: ${momentum > 0 ? '+' : ''}${momentum.toFixed(3)}%\n` +
      `RSI: ${rsi.toFixed(1)}\n` +
      `Confiança: ${(confidence * 100).toFixed(0)}%\n` +
      `Preço odds: $${marketPrice.toFixed(3)}`
    );
  },

  // Notifica aposta executada
  async betPlaced({ betNumber, direction, amount, odds, potentialProfit, txHash, dryRun }) {
    const emoji = direction === 'UP' ? '📈' : '📉';
    const mode = dryRun ? ' [SIMULADO]' : '';
    await send(
      `✅ <b>Aposta #${betNumber}${mode}</b>\n` +
      `${emoji} Direção: <b>${direction}</b>\n` +
      `💵 Valor: $${amount.toFixed(2)}\n` +
      `🎯 Odds: ${(odds * 100).toFixed(1)}¢\n` +
      `💰 Lucro potencial: $${potentialProfit.toFixed(2)}\n` +
      (txHash ? `🔗 TX: <code>${txHash.slice(0, 20)}...</code>` : '')
    );
  },

  // Notifica resultado de aposta resolvida
  async betResult({ betNumber, direction, won, profit, totalPnl }) {
    const emoji = won ? '🏆' : '❌';
    const sign = profit >= 0 ? '+' : '';
    await send(
      `${emoji} <b>Resultado #${betNumber}</b>\n` +
      `Direção: ${direction} → ${won ? 'ACERTOU' : 'ERROU'}\n` +
      `P&L: ${sign}$${profit.toFixed(2)}\n` +
      `P&L Total: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`
    );
  },

  // Notifica pausa por streak de perdas
  async lossStreakAlert({ streak, totalLoss }) {
    await send(
      `⚠️ <b>Bot pausado — ${streak} perdas seguidas</b>\n` +
      `Perda total: $${totalLoss.toFixed(2)}\n` +
      `Ajuste a estratégia antes de continuar.`
    );
  },

  // Notifica fim das apostas
  async summary({ totalBets, wins, losses, totalPnl, winRate }) {
    const emoji = totalPnl >= 0 ? '🎉' : '📊';
    await send(
      `${emoji} <b>Sessão encerrada</b>\n` +
      `Apostas: ${totalBets} (${wins}W / ${losses}L)\n` +
      `Taxa de acerto: ${(winRate * 100).toFixed(0)}%\n` +
      `P&L Final: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`
    );
  },

  // Alerta genérico
  async alert(message) {
    await send(`⚠️ ${message}`);
  },
};

// Teste rápido: node lib/telegram.js test
if (process.argv[2] === 'test') {
  await telegram.botStart({ dryRun: true, maxBets: 20, betSize: 2 });
  console.log('Mensagem de teste enviada!');
}
