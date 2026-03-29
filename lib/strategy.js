// lib/strategy.js — Engine de decisão: aceitar ou recusar aposta
import { config } from '../config.js';

export class BettingStrategy {
  constructor() {
    this.bets        = [];     // histórico de apostas
    this.lossStreak  = 0;
    this.winStreak   = 0;
  }

  get totalBets()    { return this.bets.length; }
  get wins()         { return this.bets.filter(b => b.won === true).length; }
  get losses()       { return this.bets.filter(b => b.won === false).length; }
  get pending()      { return this.bets.filter(b => b.won === null).length; }
  get totalPnl()     { return this.bets.reduce((s, b) => s + (b.pnl || 0), 0); }
  get winRate()      { const closed = this.wins + this.losses; return closed ? this.wins / closed : 0; }
  get canBet()       { return this.totalBets < config.maxBets && this.lossStreak < config.maxLossStreak; }

  // Avalia se deve apostar com base no sinal e condições do mercado
  shouldBet(signal, market) {
    const reasons = [];

    if (!this.canBet) {
      if (this.totalBets >= config.maxBets)          reasons.push(`Limite de ${config.maxBets} apostas atingido`);
      if (this.lossStreak >= config.maxLossStreak)   reasons.push(`${this.lossStreak} perdas seguidas — pausado`);
      return { bet: false, reason: reasons.join('; ') };
    }

    if (!signal.shouldBet) {
      return { bet: false, reason: `Sinal fraco (conf: ${(signal.confidence * 100).toFixed(0)}%)` };
    }

    // Verifica se o mercado tem odds aceitáveis
    const odds = signal.direction === 'UP'
      ? market?.up?.yesPrice
      : market?.down?.yesPrice;

    if (!odds) return { bet: false, reason: 'Mercado sem dados' };
    if (!market?.up?.active && !market?.down?.active) return { bet: false, reason: 'Mercado inativo' };

    const { minOdds, maxOdds } = config.signals;
    if (odds < minOdds) return { bet: false, reason: `Odds ${odds.toFixed(2)} < mínimo ${minOdds}` };
    if (odds > maxOdds) return { bet: false, reason: `Odds ${odds.toFixed(2)} > máximo ${maxOdds}` };

    // Verifica tempo restante do mercado (não apostar nos últimos 30s)
    if (market.endTime) {
      const msLeft = market.endTime - Date.now();
      if (msLeft < 30_000) return { bet: false, reason: 'Menos de 30s para fechar' };
    }

    // Calcula payoff esperado (Kelly simplificado)
    const winProb    = signal.confidence;
    const payoff     = (1 / odds) - 1;
    const kellyEdge  = winProb - ((1 - winProb) / payoff);

    if (kellyEdge <= 0) {
      return { bet: false, reason: `Edge negativo (Kelly: ${(kellyEdge * 100).toFixed(1)}%)` };
    }

    return {
      bet:       true,
      direction: signal.direction,
      odds,
      edge:      kellyEdge,
      reason:    `Edge +${(kellyEdge * 100).toFixed(1)}%, confiança ${(signal.confidence * 100).toFixed(0)}%`,
    };
  }

  // Registra nova aposta
  addBet({ direction, odds, betSize, txHash }) {
    const bet = {
      id:        this.totalBets + 1,
      direction,
      odds,
      betSize,
      txHash,
      won:       null,   // null = pendente
      pnl:       null,
      placedAt:  new Date(),
    };
    this.bets.push(bet);
    return bet;
  }

  // Atualiza resultado quando mercado resolver
  resolveBet(betId, won) {
    const bet = this.bets.find(b => b.id === betId);
    if (!bet) return;

    bet.won       = won;
    bet.resolvedAt = new Date();

    if (won) {
      bet.pnl    = bet.betSize * ((1 / bet.odds) - 1);
      this.lossStreak = 0;
      this.winStreak++;
    } else {
      bet.pnl    = -bet.betSize;
      this.winStreak  = 0;
      this.lossStreak++;
    }
    return bet;
  }

  // Resumo da sessão
  summary() {
    return {
      totalBets:  this.totalBets,
      wins:       this.wins,
      losses:     this.losses,
      pending:    this.pending,
      winRate:    this.winRate,
      totalPnl:   this.totalPnl,
      lossStreak: this.lossStreak,
      canContinue: this.canBet,
    };
  }
}
