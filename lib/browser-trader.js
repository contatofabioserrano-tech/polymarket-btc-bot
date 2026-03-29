// lib/browser-trader.js — Coloca apostas via browser automation (usa sessão Magic.link)
import puppeteer from 'puppeteer-core';
import { config } from '../config.js';

const CHROME_PATH    = config.chromePath;
const CHROME_PROFILE = config.chromeProfile;
const GAMMA_API      = 'https://gamma-api.polymarket.com';

import axios from 'axios';

let _browser = null;
let _page    = null;

async function getBrowser() {
  if (_browser && _browser.connected) return _browser;

  _browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    userDataDir:    CHROME_PROFILE,
    headless:       false,      // visível para debug; trocar para 'new' em produção
    defaultViewport: { width: 1280, height: 800 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const pages = await _browser.pages();
  _page = pages[0] || await _browser.newPage();
  return _browser;
}

async function getPage() {
  await getBrowser();
  return _page;
}

// Busca o mercado BTC 5m ativo mais recente via Gamma API
export async function findCurrentBtcMarket() {
  const res = await axios.get(`${GAMMA_API}/events`, {
    params: { slug_contains: 'btc-updown-5m', active: true, limit: 3 },
    timeout: 8000,
  });

  const events = Array.isArray(res.data) ? res.data : res.data?.data || [];
  const event  = events
    .filter(e => !e.closed && e.active)
    .sort((a, b) => (b.startDate || 0) - (a.startDate || 0))[0];

  if (!event) return null;

  const markets    = event.markets || [];
  const upMarket   = markets.find(m => /up|higher|cima|subir/i.test(m.question));
  const downMarket = markets.find(m => /down|lower|baixo|cair/i.test(m.question));

  // Preços via CLOB
  async function price(m) {
    if (!m) return 0.5;
    try {
      const r = await axios.get(`https://clob.polymarket.com/market/${m.conditionId}`, { timeout: 4000 });
      const yes = r.data?.tokens?.find(t => t.outcome === 'Yes');
      return parseFloat(yes?.price || 0.5);
    } catch { return 0.5; }
  }

  return {
    slug:      event.slug,
    eventUrl:  `https://polymarket.com/pt/event/${event.slug}`,
    endTime:   event.endDate ? new Date(event.endDate * 1000) : null,
    up:   { market: upMarket,   price: await price(upMarket)   },
    down: { market: downMarket, price: await price(downMarket) },
  };
}

// Coloca aposta de $betSize na direção (UP ou DOWN) via browser
export async function placeBetBrowser({ direction, betSize, marketInfo }) {
  if (config.dryRun) {
    const odds   = direction === 'UP' ? marketInfo?.up?.price : marketInfo?.down?.price;
    return { simulated: true, direction, odds, betSize, potentialProfit: betSize / odds - betSize };
  }

  const page    = await getPage();
  const eventUrl = marketInfo?.eventUrl || 'https://polymarket.com/pt/predictions/crypto';

  // Navega para o mercado
  await page.goto(eventUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(3000); // aguarda React renderizar

  // Captura odds atual antes de apostar
  const odds = direction === 'UP' ? marketInfo?.up?.price : marketInfo?.down?.price;

  // Clica no botão de direção (UP = "Sim", DOWN = "Não")
  const btnText = direction === 'UP' ? /sim|yes|cima|up/i : /não|no|baixo|down/i;

  const clicked = await page.evaluate((pattern) => {
    const btns = Array.from(document.querySelectorAll('button'));
    const btn  = btns.find(b => new RegExp(pattern).test(b.textContent));
    if (btn) { btn.click(); return true; }
    return false;
  }, btnText.source);

  if (!clicked) throw new Error(`Botão "${direction}" não encontrado na página`);

  await sleep(1500);

  // Limpa e digita o valor no input de aposta
  const inputFilled = await page.evaluate((amount) => {
    const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="number"], input[inputmode="decimal"]'));
    const amountInput = inputs.find(i =>
      /amount|value|bet|stake|size/i.test(i.placeholder || i.name || i.id || i.className)
      || parseFloat(i.value) >= 0
    ) || inputs[inputs.length - 1];

    if (!amountInput) return false;
    amountInput.focus();
    amountInput.value = '';
    amountInput.dispatchEvent(new Event('input', { bubbles: true }));
    amountInput.value = String(amount);
    amountInput.dispatchEvent(new Event('input', { bubbles: true }));
    amountInput.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, betSize);

  if (!inputFilled) throw new Error('Input de valor não encontrado');

  await sleep(1500);

  // Clica em "Comprar" / "Buy" / "Confirmar"
  const confirmed = await page.evaluate(() => {
    const btns   = Array.from(document.querySelectorAll('button'));
    const buyBtn = btns.find(b => /comprar|buy|confirmar|confirm|submit|trade/i.test(b.textContent));
    if (buyBtn && !buyBtn.disabled) { buyBtn.click(); return true; }
    return false;
  });

  if (!confirmed) throw new Error('Botão Comprar não encontrado');

  await sleep(3000); // aguarda confirmação on-chain

  return {
    simulated:       false,
    direction,
    odds,
    betSize,
    potentialProfit: betSize / odds - betSize,
    txHash:          null, // Magic.link não expõe txHash diretamente
  };
}

export async function closeBrowser() {
  if (_browser) {
    await _browser.close();
    _browser = null;
    _page    = null;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
