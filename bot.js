// bot.js — Loop principal do Polymarket BTC 5m Bot
import chalk from 'chalk';
import Table from 'cli-table3';
import { config } from './config.js';
import { analyzeSignal } from './lib/signals.js';
import { findActiveBtcMarket, placeBet, getBalance } from './lib/polymarket.js';
import { BettingStrategy } from './lib/strategy.js';
import { telegram } from './lib/telegram.js';

const strategy = new BettingStrategy();
let lastMarket  = null;
let lastSignal  = null;
let running     = true;

// ─── Dashboard Terminal ───────────────────────────────────────────────────────

function clearScreen() {
  process.stdout.write('\x1Bc');
}

function printDashboard(signal, market, balance) {
  clearScreen();

  const mode = config.dryRun
    ? chalk.yellow('🧪 SIMULAÇÃO')
    : chalk.red('💰 AO VIVO');

  console.log(chalk.bold.cyan('\n╔══════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('║     POLYMARKET BTC 5m BOT            ║'));
  console.log(chalk.bold.cyan('╚══════════════════════════════════════╝'));
  console.log(`  Modo: ${mode}   ${chalk.gray(new Date().toLocaleTimeString('pt-BR'))}`);
  if (balance !== null) console.log(`  Saldo: ${chalk.green('$' + balance?.toFixed(2) || '—')} USDC`);

  // ─── Sinal atual ───
  if (signal) {
    const dir = signal.direction;
    const dirLabel = !dir
      ? chalk.gray('NEUTRO')
      : dir === 'UP'
        ? chalk.green('▲ UP')
        : chalk.red('▼ DOWN');

    const confPct = (signal.confidence * 100).toFixed(0);
    const confBar = '█'.repeat(Math.round(signal.confidence * 10)) + '░'.repeat(10 - Math.round(signal.confidence * 10));

    console.log(chalk.bold('\n  ── SINAL BTC ──'));
    console.log(`  Preço:     $${signal.currentPrice?.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    console.log(`  Momentum:  ${signal.momentum > 0 ? chalk.green('+') : chalk.red('')}${signal.momentum?.toFixed(3)}%`);
    console.log(`  RSI:       ${signal.rsi?.toFixed(1)}`);
    console.log(`  Volume:    ${signal.volumeRatio?.toFixed(2)}x média`);
    console.log(`  Direção:   ${dirLabel}`);
    console.log(`  Confiança: [${confBar}] ${confPct}%`);
  }

  // ─── Mercado ───
  if (market) {
    const msLeft = market.endTime ? Math.max(0, market.endTime - Date.now()) : 0;
    const secLeft = Math.floor(msLeft / 1000);
    console.log(chalk.bold('\n  ── MERCADO ──'));
    console.log(`  UP odds:   ${chalk.green('$' + (market.up?.yesPrice || '—'))}`);
    console.log(`  DOWN odds: ${chalk.red('$' + (market.down?.yesPrice || '—'))}`);
    console.log(`  Fecha em:  ${secLeft}s`);
  }

  // ─── Histórico de apostas ───
  const summary = strategy.summary();
  console.log(chalk.bold('\n  ── APOSTAS ──'));
  console.log(`  Total:   ${summary.totalBets}/${config.maxBets}`);
  console.log(`  Vitórias: ${chalk.green(summary.wins)} | Derrotas: ${chalk.red(summary.losses)} | Pendentes: ${summary.pending}`);
  console.log(`  Acerto:  ${(summary.winRate * 100).toFixed(0)}%`);
  const pnl = summary.totalPnl;
  const pnlStr = (pnl >= 0 ? chalk.green('+$') : chalk.red('-$')) + Math.abs(pnl).toFixed(2);
  console.log(`  P&L:     ${pnlStr}`);
  console.log(`  Streak:  ${strategy.lossStreak > 0 ? chalk.red('❌ ' + strategy.lossStreak + ' perdas') : chalk.green('✅ ' + strategy.winStreak + ' vitórias')}`);

  // ─── Últimas apostas ───
  const lastBets = strategy.bets.slice(-5).reverse();
  if (lastBets.length) {
    const table = new Table({
      head: ['#', 'Direção', 'Odds', '$', 'P&L', 'Status'],
      style: { head: ['cyan'] },
      colWidths: [4, 8, 6, 5, 8, 10],
    });
    for (const b of lastBets) {
      const statusIcon = b.won === null ? '⏳' : b.won ? '✅' : '❌';
      const pnlVal = b.pnl !== null ? (b.pnl >= 0 ? chalk.green('+$' + b.pnl.toFixed(2)) : chalk.red('-$' + Math.abs(b.pnl).toFixed(2))) : '—';
      table.push([
        b.id,
        b.direction === 'UP' ? chalk.green('▲ UP') : chalk.red('▼ DOWN'),
        b.odds?.toFixed(2),
        '$' + b.betSize,
        pnlVal,
        statusIcon,
      ]);
    }
    console.log('\n' + table.toString());
  }

  if (!summary.canContinue) {
    console.log(chalk.red.bold('\n  ⛔ BOT PARADO — limite atingido\n'));
  } else {
    console.log(chalk.gray('\n  Próxima verificação em 30s... (Ctrl+C para parar)\n'));
  }
}

// ─── Loop principal ───────────────────────────────────────────────────────────

async function tick() {
  try {
    // 1. Busca sinal de BTC
    const signal = await analyzeSignal();
    lastSignal = signal;

    // 2. Busca mercado ativo
    let market = lastMarket;
    try {
      market     = await findActiveBtcMarket();
      lastMarket = market;
    } catch (e) {
      console.error(chalk.yellow('Aviso: não conseguiu atualizar mercado:', e.message));
    }

    // 3. Verifica saldo (opcional)
    const balance = config.dryRun ? config.maxBets * config.betSize : await getBalance();

    // 4. Renderiza dashboard
    printDashboard(signal, market, balance);

    // 5. Avalia se deve apostar
    if (!strategy.canBet) {
      if (!running) return;
      running = false;
      const sum = strategy.summary();
      await telegram.summary(sum);
      return;
    }

    const decision = strategy.shouldBet(signal, market);
    if (!decision.bet) {
      console.log(chalk.gray(`  → Sem aposta: ${decision.reason}`));
      return;
    }

    // 6. Executa aposta
    console.log(chalk.bold.yellow(`\n  → Apostando ${decision.direction} ($${config.betSize})...`));

    await telegram.signal({
      direction:   signal.direction,
      momentum:    signal.momentum,
      rsi:         signal.rsi,
      confidence:  signal.confidence,
      marketPrice: decision.odds,
    });

    const result = await placeBet({
      direction: decision.direction,
      betSize:   config.betSize,
      market,
    });

    const bet = strategy.addBet({
      direction: decision.direction,
      odds:      result.odds,
      betSize:   config.betSize,
      txHash:    result.txHash,
    });

    await telegram.betPlaced({
      betNumber:       bet.id,
      direction:       bet.direction,
      amount:          config.betSize,
      odds:            result.odds,
      potentialProfit: result.potentialProfit,
      txHash:          result.txHash,
      dryRun:          config.dryRun,
    });

    console.log(chalk.green(`  ✅ Aposta #${bet.id} registrada!`));

    // 7. Simula resultado para DRY RUN (resolve após 5 minutos)
    if (config.dryRun) {
      const msToEnd = market?.endTime ? Math.max(5000, market.endTime - Date.now()) : 300_000;
      console.log(chalk.gray(`  (Simulação: resultado em ${Math.round(msToEnd / 1000)}s)`));
      setTimeout(async () => {
        // Simula resultado com 50% de chance
        const won = Math.random() > 0.5;
        const resolved = strategy.resolveBet(bet.id, won);
        if (resolved) {
          await telegram.betResult({
            betNumber: bet.id,
            direction: bet.direction,
            won,
            profit:    resolved.pnl,
            totalPnl:  strategy.totalPnl,
          });
        }
      }, msToEnd);
    }

  } catch (err) {
    console.error(chalk.red('\nErro no tick:', err.message));
    await telegram.alert(`Erro no bot: ${err.message}`);
  }
}

// ─── Inicialização ───────────────────────────────────────────────────────────

async function main() {
  console.log(chalk.bold.cyan('\n🚀 Iniciando Polymarket BTC 5m Bot...\n'));

  if (config.dryRun) {
    console.log(chalk.yellow('⚠️  Modo SIMULAÇÃO ativo — nenhuma aposta real será feita.'));
    console.log(chalk.yellow('   Para apostas reais: defina DRY_RUN=false no .env\n'));
  } else {
    console.log(chalk.red.bold('🔴 MODO AO VIVO — apostas reais com USDC!'));
    if (!config.privateKey) {
      console.error(chalk.red('ERRO: PRIVATE_KEY não configurada no .env!'));
      process.exit(1);
    }
  }

  await telegram.botStart({
    dryRun:   config.dryRun,
    maxBets:  config.maxBets,
    betSize:  config.betSize,
  });

  // Primeiro tick imediato
  await tick();

  // Loop a cada 30 segundos
  const interval = setInterval(async () => {
    if (!running || !strategy.canBet) {
      clearInterval(interval);
      return;
    }
    await tick();
  }, 30_000);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    clearInterval(interval);
    const sum = strategy.summary();
    printDashboard(lastSignal, lastMarket, null);
    await telegram.summary(sum);
    console.log(chalk.bold('\n👋 Bot encerrado.\n'));
    process.exit(0);
  });
}

main().catch(err => {
  console.error(chalk.red('Erro fatal:', err));
  process.exit(1);
});
