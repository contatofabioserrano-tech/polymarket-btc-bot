import express   from 'express';
import { WebSocketServer } from 'ws';
import { createServer }    from 'http';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';
import { config }          from './config.js';
import { analyzeSignal }   from './lib/signals.js';
import { findCurrentBtcMarket, placeBetBrowser } from './lib/browser-trader.js';
import { placeBet, getBalance, findActiveBtcMarket } from './lib/polymarket.js';
import { BettingStrategy } from './lib/strategy.js';
import { telegram }        from './lib/telegram.js';

const __dir = dirname(fileURLToPath(import.meta.url));

const app  = express();
app.use(express.json());
const http = createServer(app);
const wss  = new WebSocketServer({ server: http });

const strategy = new BettingStrategy();
let state = {
  status:   'iniciando',
  signal:   null,
  market:   null,
  balance:  null,
  lastTick: null,
  error:    null,
  log:      [],
};

function log(msg, type = 'info') {
  const entry = { ts: new Date().toISOString(), msg, type };
  state.log.unshift(entry);
  if (state.log.length > 100) state.log.pop();
  console.log(`[${entry.ts}] ${msg}`);
  broadcast();
}

function broadcast() {
  const payload = JSON.stringify({ ...state, bets: strategy.bets, summary: strategy.summary() });
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

// ── Dashboard HTML ─────────────────────────────────────────────────────────
app.get('/', (_, res) => res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Fortuna Bot · BTC 5m</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#0a0e1a;color:#e2e8f0;font-family:'Segoe UI',monospace;padding:20px}
    h1{color:#38bdf8;font-size:1.4rem;margin-bottom:4px}
    .sub{color:#64748b;font-size:.8rem;margin-bottom:20px}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:20px}
    .card{background:#111827;border:1px solid #1e293b;border-radius:10px;padding:16px}
    .card h3{font-size:.7rem;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px}
    .card .val{font-size:1.6rem;font-weight:700}
    .up{color:#22c55e}.down{color:#ef4444}.neutral{color:#94a3b8}.warn{color:#f59e0b}
    .panel{background:#111827;border:1px solid #1e293b;border-radius:10px;padding:16px;margin-bottom:16px}
    .panel h2{font-size:.85rem;color:#38bdf8;margin-bottom:12px;text-transform:uppercase;letter-spacing:.05em}
    .signal-row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #1e293b;font-size:.85rem}
    .signal-row:last-child{border:none}
    .badge{padding:2px 10px;border-radius:20px;font-size:.75rem;font-weight:700}
    .badge-up{background:#14532d;color:#22c55e}
    .badge-down{background:#450a0a;color:#ef4444}
    .badge-neutral{background:#1e293b;color:#94a3b8}
    .badge-sim{background:#713f12;color:#fbbf24}
    .badge-live{background:#450a0a;color:#ef4444}
    table{width:100%;border-collapse:collapse;font-size:.8rem}
    th{color:#64748b;text-align:left;padding:6px 8px;border-bottom:1px solid #1e293b}
    td{padding:6px 8px;border-bottom:1px solid #0f172a}
    .bar-wrap{background:#1e293b;border-radius:4px;height:8px;overflow:hidden}
    .bar{height:100%;border-radius:4px;transition:width .5s}
    .log-line{font-size:.75rem;color:#64748b;padding:3px 0;border-bottom:1px solid #0f172a}
    .log-line.bet{color:#38bdf8}.log-line.warn{color:#f59e0b}.log-line.err{color:#ef4444}
    #status-dot{width:8px;height:8px;border-radius:50%;background:#22c55e;display:inline-block;margin-right:6px;animation:pulse 2s infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
    .mode-tag{font-size:.7rem;padding:2px 8px;border-radius:4px;margin-left:8px}
  </style>
</head>
<body>
  <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:4px">
    <h1 style="margin:0">⚡ Fortuna Bot · BTC 5m <span id="mode-tag" class="mode-tag badge-sim"></span></h1>
    <a href="/setup" style="font-size:.75rem;color:#38bdf8;text-decoration:none;background:#0f172a;padding:6px 14px;border-radius:6px;border:1px solid #1e293b">🔑 Configurar Chave</a>
  </div>
  <p class="sub"><span id="status-dot"></span><span id="status-text">conectando...</span></p>

  <div class="grid">
    <div class="card">
      <h3>BTC Preço</h3>
      <div class="val neutral" id="btc-price">—</div>
    </div>
    <div class="card">
      <h3>Sinal</h3>
      <div class="val" id="signal-dir">—</div>
    </div>
    <div class="card">
      <h3>Confiança</h3>
      <div class="val neutral" id="confidence">—</div>
      <div class="bar-wrap" style="margin-top:8px"><div class="bar" id="conf-bar" style="width:0%;background:#38bdf8"></div></div>
    </div>
    <div class="card">
      <h3>Saldo USDC</h3>
      <div class="val up" id="balance">—</div>
    </div>
    <div class="card">
      <h3>P&amp;L Sessão</h3>
      <div class="val" id="pnl">$0.00</div>
    </div>
    <div class="card">
      <h3>Apostas</h3>
      <div class="val neutral" id="bets-count">0/20</div>
    </div>
    <div class="card">
      <h3>Acerto</h3>
      <div class="val neutral" id="winrate">—</div>
    </div>
    <div class="card">
      <h3>Streak</h3>
      <div class="val" id="streak">—</div>
    </div>
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
    <div>
      <div class="panel">
        <h2>📊 Sinal Atual</h2>
        <div class="signal-row"><span>Momentum</span><span id="momentum">—</span></div>
        <div class="signal-row"><span>RSI</span><span id="rsi">—</span></div>
        <div class="signal-row"><span>Volume ratio</span><span id="volratio">—</span></div>
        <div class="signal-row"><span>UP odds</span><span id="up-odds">—</span></div>
        <div class="signal-row"><span>DOWN odds</span><span id="down-odds">—</span></div>
        <div class="signal-row"><span>Mercado fecha em</span><span id="time-left">—</span></div>
      </div>

      <div class="panel">
        <h2>📋 Log</h2>
        <div id="log-box"></div>
      </div>
    </div>

    <div class="panel">
      <h2>🎯 Apostas</h2>
      <table>
        <thead><tr><th>#</th><th>Direção</th><th>Odds</th><th>$</th><th>P&amp;L</th><th>Status</th></tr></thead>
        <tbody id="bets-table"></tbody>
      </table>
    </div>
  </div>

<script>
const ws = new WebSocket('ws://' + location.host);
ws.onmessage = e => {
  const d = JSON.parse(e.data);
  document.getElementById('status-text').textContent = d.status;

  const mode = d.signal?.dryRun !== false;
  const modeTag = document.getElementById('mode-tag');
  modeTag.textContent = d.summary?.dryRun === false ? '🔴 AO VIVO' : '🧪 SIMULAÇÃO';
  modeTag.className = 'mode-tag badge ' + (d.summary?.dryRun === false ? 'badge-live' : 'badge-sim');

  if (d.signal) {
    const s = d.signal;
    document.getElementById('btc-price').textContent = s.currentPrice ? '$' + s.currentPrice.toLocaleString('en-US',{minimumFractionDigits:2}) : '—';
    const dir = s.direction;
    const dirEl = document.getElementById('signal-dir');
    dirEl.textContent = dir === 'UP' ? '▲ UP' : dir === 'DOWN' ? '▼ DOWN' : '— NEUTRO';
    dirEl.className = 'val ' + (dir === 'UP' ? 'up' : dir === 'DOWN' ? 'down' : 'neutral');
    const conf = s.confidence || 0;
    document.getElementById('confidence').textContent = (conf * 100).toFixed(0) + '%';
    document.getElementById('conf-bar').style.width = (conf * 100) + '%';
    document.getElementById('momentum').textContent = (s.momentum >= 0 ? '+' : '') + (s.momentum||0).toFixed(3) + '%';
    document.getElementById('rsi').textContent = (s.rsi||0).toFixed(1);
    document.getElementById('volratio').textContent = (s.volumeRatio||0).toFixed(2) + 'x';
  }

  if (d.market) {
    document.getElementById('up-odds').textContent = d.market.up?.yesPrice ? '$' + d.market.up.yesPrice.toFixed(3) : '—';
    document.getElementById('down-odds').textContent = d.market.down?.yesPrice ? '$' + d.market.down.yesPrice.toFixed(3) : '—';
    if (d.market.endTime) {
      const ms = new Date(d.market.endTime) - Date.now();
      document.getElementById('time-left').textContent = ms > 0 ? Math.floor(ms/1000) + 's' : 'fechado';
    }
  }

  if (d.balance !== null && d.balance !== undefined) {
    document.getElementById('balance').textContent = '$' + Number(d.balance).toFixed(2);
  }

  if (d.summary) {
    const sm = d.summary;
    const pnl = sm.totalPnl || 0;
    const pnlEl = document.getElementById('pnl');
    pnlEl.textContent = (pnl >= 0 ? '+' : '') + '$' + Math.abs(pnl).toFixed(2);
    pnlEl.className = 'val ' + (pnl >= 0 ? 'up' : 'down');
    document.getElementById('bets-count').textContent = sm.totalBets + '/' + ${config.maxBets};
    const wr = sm.wins + sm.losses > 0 ? sm.wins / (sm.wins + sm.losses) : null;
    document.getElementById('winrate').textContent = wr !== null ? (wr * 100).toFixed(0) + '%' : '—';
    const streak = sm.lossStreak || 0;
    const sEl = document.getElementById('streak');
    sEl.textContent = streak > 0 ? '❌ ' + streak + ' perdas' : (sm.winStreak ? '✅ ' + sm.winStreak + ' vitórias' : '—');
    sEl.className = 'val ' + (streak > 0 ? 'down' : 'up');
  }

  if (d.bets) {
    const rows = [...d.bets].reverse().slice(0, 20).map(b => {
      const icon = b.won === null ? '⏳' : b.won ? '✅' : '❌';
      const pnlStr = b.pnl !== null ? ((b.pnl >= 0 ? '<span class="up">+$' : '<span class="down">-$') + Math.abs(b.pnl).toFixed(2) + '</span>') : '—';
      const dirStr = b.direction === 'UP' ? '<span class="up">▲ UP</span>' : '<span class="down">▼ DOWN</span>';
      return \`<tr><td>\${b.id}</td><td>\${dirStr}</td><td>\${b.odds?.toFixed(3)}</td><td>$\${b.betSize}</td><td>\${pnlStr}</td><td>\${icon}</td></tr>\`;
    }).join('');
    document.getElementById('bets-table').innerHTML = rows || '<tr><td colspan="6" style="color:#64748b;text-align:center">Nenhuma aposta ainda</td></tr>';
  }

  if (d.log) {
    const lines = d.log.slice(0, 20).map(l =>
      \`<div class="log-line \${l.type}"><span style="color:#334155">\${l.ts.slice(11,19)}</span> \${l.msg}</div>\`
    ).join('');
    document.getElementById('log-box').innerHTML = lines;
  }
};
ws.onclose = () => { document.getElementById('status-text').textContent = '⚠️ desconectado — recarregando...'; setTimeout(() => location.reload(), 3000); };
setInterval(() => {
  const el = document.getElementById('time-left');
  if (el && el.textContent.endsWith('s')) {
    const v = parseInt(el.textContent);
    if (v > 0) el.textContent = (v - 1) + 's';
  }
}, 1000);
</script>
</body></html>`));

// ── Setup page ─────────────────────────────────────────────────────────────
app.get('/setup', (_, res) => res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bot Setup — Chave Privada</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#0a0e1a;color:#e2e8f0;font-family:'Segoe UI',monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
    .box{background:#111827;border:1px solid #1e293b;border-radius:16px;padding:40px;max-width:520px;width:100%}
    h1{color:#38bdf8;font-size:1.3rem;margin-bottom:8px}
    p{color:#64748b;font-size:.9rem;margin-bottom:24px;line-height:1.6}
    .step{background:#0f172a;border-radius:8px;padding:12px 16px;margin-bottom:12px;font-size:.85rem;color:#94a3b8;border-left:3px solid #38bdf8}
    .step b{color:#e2e8f0}
    label{display:block;font-size:.8rem;color:#64748b;margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em}
    input{width:100%;background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:12px 14px;color:#e2e8f0;font-family:monospace;font-size:.85rem;outline:none}
    input:focus{border-color:#38bdf8}
    button{width:100%;margin-top:16px;padding:14px;background:#0ea5e9;color:#fff;border:none;border-radius:8px;font-size:1rem;font-weight:700;cursor:pointer;transition:background .2s}
    button:hover{background:#0284c7}
    button:disabled{background:#1e293b;color:#64748b;cursor:not-allowed}
    .msg{margin-top:16px;padding:12px;border-radius:8px;font-size:.85rem;text-align:center;display:none}
    .msg.ok{background:#14532d;color:#22c55e;display:block}
    .msg.err{background:#450a0a;color:#ef4444;display:block}
    a.back{display:block;text-align:center;margin-top:20px;color:#38bdf8;font-size:.85rem;text-decoration:none}
    a.back:hover{text-decoration:underline}
  </style>
</head>
<body>
  <div class="box">
    <h1>🔑 Configurar Chave Privada</h1>
    <p>Para que o bot possa fazer apostas reais via API, precisa da sua chave privada do Polymarket.</p>

    <div class="step"><b>Passo 1:</b> Acesse <b>polymarket.com</b> → clique no seu avatar → <b>Configurações</b></div>
    <div class="step"><b>Passo 2:</b> Clique na aba <b>"Chave privada"</b> ou <b>"Private key"</b></div>
    <div class="step"><b>Passo 3:</b> Copie a chave que começa com <b>0x...</b> e cole abaixo</div>

    <label for="pk">Chave Privada (0x...)</label>
    <input type="password" id="pk" placeholder="0x0000000000000000000000000000000000000000000000000000000000000000" autocomplete="off">

    <button id="btn" onclick="save()">Salvar e Ativar Bot</button>
    <div class="msg" id="msg"></div>
    <a class="back" href="/">← Voltar ao Dashboard</a>
  </div>
<script>
async function save() {
  const pk = document.getElementById('pk').value.trim();
  const btn = document.getElementById('btn');
  const msg = document.getElementById('msg');
  msg.className = 'msg';
  if (!pk.startsWith('0x') || pk.length < 64) {
    msg.className = 'msg err';
    msg.textContent = '❌ Chave inválida — deve começar com 0x e ter 66 caracteres';
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Salvando...';
  try {
    const res = await fetch('/api/setup', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ privateKey: pk }) });
    const data = await res.json();
    if (data.ok) {
      msg.className = 'msg ok';
      msg.textContent = '✅ Chave salva! Bot iniciando apostas reais...';
      btn.textContent = 'Salvo!';
      setTimeout(() => location.href = '/', 2500);
    } else {
      throw new Error(data.error || 'Erro desconhecido');
    }
  } catch(e) {
    msg.className = 'msg err';
    msg.textContent = '❌ ' + e.message;
    btn.disabled = false;
    btn.textContent = 'Salvar e Ativar Bot';
  }
}
document.getElementById('pk').addEventListener('keydown', e => { if(e.key==='Enter') save(); });
</script>
</body></html>`));

// ── Setup API ──────────────────────────────────────────────────────────────
app.post('/api/setup', (req, res) => {
  const { privateKey } = req.body || {};
  if (!privateKey || !privateKey.startsWith('0x') || privateKey.length < 64) {
    return res.status(400).json({ ok: false, error: 'Chave privada inválida' });
  }
  try {
    const envPath = join(__dir, '.env');
    let envContent = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
    if (envContent.includes('PRIVATE_KEY=')) {
      envContent = envContent.replace(/^PRIVATE_KEY=.*$/m, `PRIVATE_KEY=${privateKey}`);
    } else {
      envContent = envContent.trimEnd() + `\nPRIVATE_KEY=${privateKey}\n`;
    }
    writeFileSync(envPath, envContent, 'utf8');
    process.env.PRIVATE_KEY = privateKey;
    config.privateKey = privateKey;
    log('🔑 Chave privada configurada — modo CLOB API ativado!', 'bet');
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Health check ───────────────────────────────────────────────────────────
app.get('/api/status', (_, res) => res.json({
  ...state,
  bets: strategy.bets,
  summary: strategy.summary(),
  hasPrivateKey: !!config.privateKey,
  setupUrl: config.privateKey ? null : `http://localhost:${config.port}/setup`,
}));

// ── Bot loop ───────────────────────────────────────────────────────────────
async function tick() {
  try {
    state.status  = 'analisando';
    state.lastTick = new Date().toISOString();
    broadcast();

    // 1. Sinal BTC
    const signal  = await analyzeSignal();
    state.signal  = { ...signal, dryRun: config.dryRun };

    // 2. Mercado
    try {
      if (config.privateKey) {
        state.market = await findActiveBtcMarket();
      } else {
        state.market = await findCurrentBtcMarket();
      }
    } catch (e) {
      log('Mercado indisponível: ' + e.message, 'warn');
    }

    // 3. Saldo
    if (config.privateKey) {
      const bal = await getBalance();
      state.balance = bal !== null ? bal : (config.maxBets - strategy.totalBets) * config.betSize;
    } else {
      state.balance = (config.maxBets - strategy.totalBets) * config.betSize;
    }

    state.status = !state.market ? 'fora de horário' : (strategy.canBet ? 'monitorando' : 'encerrado');
    state.error  = null;
    broadcast();

    // 4. Decisão
    if (!strategy.canBet) {
      log('Bot encerrado — limite atingido', 'warn');
      return;
    }

    const dec = strategy.shouldBet(signal, state.market);
    log(`Sinal: ${signal.direction || 'NEUTRO'} (conf ${(signal.confidence * 100).toFixed(0)}%) → ${dec.bet ? '✅ APOSTAR' : '⏭️ ' + dec.reason}`);

    if (!dec.bet) return;

    // 5. Aposta
    log(`Apostando $${config.betSize} em ${dec.direction}...`, 'bet');
    await telegram.signal({ direction: signal.direction, momentum: signal.momentum, rsi: signal.rsi, confidence: signal.confidence, marketPrice: dec.odds });

    const result = config.privateKey
      ? await placeBet({ direction: dec.direction, betSize: config.betSize, market: state.market })
      : await placeBetBrowser({ direction: dec.direction, betSize: config.betSize, marketInfo: state.market });
    const bet    = strategy.addBet({ direction: dec.direction, odds: result.odds, betSize: config.betSize, txHash: result.txHash });

    log(`#${bet.id} ${bet.direction} @ ${bet.odds?.toFixed(3)} ${config.dryRun ? '[simulado]' : ''}`, 'bet');
    await telegram.betPlaced({ betNumber: bet.id, direction: bet.direction, amount: config.betSize, odds: result.odds, potentialProfit: result.potentialProfit, txHash: result.txHash, dryRun: config.dryRun });

    // 6. Simula resultado (DRY RUN)
    if (config.dryRun && state.market?.endTime) {
      const delay = Math.max(5000, new Date(state.market.endTime) - Date.now());
      setTimeout(async () => {
        const won     = Math.random() > 0.45; // ligeiramente favorável para demo
        const resolved = strategy.resolveBet(bet.id, won);
        if (resolved) {
          log(`#${bet.id} resultado: ${won ? '✅ GANHOU' : '❌ PERDEU'} P&L: ${resolved.pnl >= 0 ? '+' : ''}$${resolved.pnl.toFixed(2)}`, won ? 'bet' : 'warn');
          await telegram.betResult({ betNumber: bet.id, direction: bet.direction, won, profit: resolved.pnl, totalPnl: strategy.totalPnl });
          if (strategy.lossStreak >= config.maxLossStreak) {
            await telegram.lossStreakAlert({ streak: strategy.lossStreak, totalLoss: Math.abs(strategy.totalPnl) });
          }
          broadcast();
        }
      }, delay);
    }

    broadcast();

  } catch (err) {
    state.error  = err.message;
    state.status = 'erro';
    log('Erro: ' + err.message, 'err');
    await telegram.alert('Erro no bot: ' + err.message);
    broadcast();
  }
}

// ── Start ───────────────────────────────────────────────────────────────────
http.listen(config.port, async () => {
  console.log(`\n🚀 Fortuna Bot rodando na porta ${config.port}`);
  console.log(`   Dashboard: http://localhost:${config.port}`);
  console.log(`   Modo: ${config.dryRun ? '🧪 SIMULAÇÃO' : '🔴 AO VIVO'}`);
  if (!config.privateKey) {
    console.log(`\n   ⚠️  Chave privada não configurada!`);
    console.log(`   👉 Acesse http://localhost:${config.port}/setup para ativar apostas reais via CLOB API\n`);
  } else {
    console.log(`   ✅ Chave privada configurada — CLOB API ativo\n`);
  }

  await telegram.botStart({ dryRun: config.dryRun, maxBets: config.maxBets, betSize: config.betSize });

  // Tick imediato
  await tick();

  // Loop a cada 30s
  setInterval(async () => {
    if (!strategy.canBet) return;
    await tick();
  }, 30_000);
});
