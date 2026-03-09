// ═══════════════════════════════════════════════════════════════════
//  NEXUS ULTRA v8 — Server (نظيف — بدون أخطاء)
//  ✅ أسعار حية: Finnhub → Yahoo v7 → Yahoo v8 → Stooq
//  ✅ تنبيهات تيليجرام: CALL/PUT + أهداف واقعية للمضارب اليومي
//  ✅ أخبار عربية + إنجليزية مترجمة
//  ✅ تقويم اقتصادي من Finnhub
//  ✅ مؤشرات: SuperTrend + VWAP + EMA9/21/50/200 + MACD + RSI + BB
// ═══════════════════════════════════════════════════════════════════

'use strict';
const express = require('express');
const path    = require('path');
const app     = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

const TG_TOKEN = process.env.TG_TOKEN || '';
const TG_CHAT  = process.env.TG_CHAT  || '';
const PORT     = process.env.PORT     || 3000;
const log = msg => console.log(`[${new Date().toISOString()}] ${msg}`);

// ── CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});

// ══════════════════════════════════════════════════════════════════
// حالة السوق
// ══════════════════════════════════════════════════════════════════
const S = {
  price: 0, prev: 0, open: 0, high: 0, low: 0, vol: 0, volR: 1,
  vix: 0, vixPrev: 0,
  rsi: 50, macd: 0, msig: 0, mhist: 0, sk: 50, sd: 50,
  bbU: 0, bbL: 0, bbB: 0, atr: 20,
  stV: 0, stD: 1,
  ema9: 0, ema21: 0, ema50: 0, ema200: 0, vwap: 0,
  obv: 0, obvE: 0,
  fibH: 0, fibL: 0,
  mktState: 'REGULAR', isExt: false, dataSource: 'Yahoo',
  lastSig: 'WAIT', lastScore: 0,
  _lastSource: 'Yahoo',
  history: [],
  confirmCount: 0,
  confirmDir: '',
};

// ── مفاتيح runtime
const RUNTIME_KEYS = { finnhub: '', alphavantage: '' };

// ── صفقة نشطة
const TRADE = {
  active: false, type: null, entry: 0, atr: 0,
  tp1: 0, tp2: 0, tp3: 0, sl: 0, trailSl: 0, score: 0,
  tp1Hit: false, tp2Hit: false,
  nearTp1: false, nearTp2: false, slWarned: false,
  openedAt: null, grade: 'B', entryHour: 10,
};

// ══════════════════════════════════════════════════════════════════
// نظام الأهداف الأسبوعية
// ══════════════════════════════════════════════════════════════════
const WEEKLY = {
  goalPnl: 500,
  maxLoss: -300,
  enabled: true,

  weeklyPnl() {
    const now    = new Date();
    const day    = now.getUTCDay();
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() - ((day + 6) % 7));
    monday.setUTCHours(0, 0, 0, 0);
    // نستخدم STATS.trades الذي يحتوي ts صحيح
    const trades = STATS.trades || [];
    return trades
      .filter(t => t.ts && new Date(t.ts) >= monday)
      .reduce((s, t) => s + (t.pnl || 0), 0);
  },

  isBlocked() {
    if (!this.enabled) return { blocked: false };
    const pnl = this.weeklyPnl();
    if (pnl >= this.goalPnl)  return { blocked: true, reason: `🏆 تم تحقيق الهدف الأسبوعي +$${pnl.toFixed(0)}` };
    if (pnl <= this.maxLoss)  return { blocked: true, reason: `🛑 Circuit Breaker: خسارة -$${Math.abs(pnl).toFixed(0)} تجاوزت الحد` };
    return { blocked: false, pnl };
  },
};

// ══════════════════════════════════════════════════════════════════
// إحصائيات الأداء
// ══════════════════════════════════════════════════════════════════
const STATS = {
  wins: 0, losses: 0, breakeven: 0,
  totalPnl: 0, totalTrades: 0,
  byGrade: { 'A+': { w: 0, l: 0, pnl: 0 }, 'A': { w: 0, l: 0, pnl: 0 }, 'B': { w: 0, l: 0, pnl: 0 } },
  byHour:  {},
  byType:  { 'BUY': { w: 0, l: 0 }, 'SELL': { w: 0, l: 0 } },
  lossCause: { 'SL_HIT': 0, 'TIMEOUT': 0, 'REVERSE': 0 },
  trades: [],
};

// ── Cooldown للتنبيهات
const CD = {};
const canAlert = (k, s = 120) => {
  const n = Date.now();
  if (CD[k] && n - CD[k] < s * 1000) return false;
  CD[k] = n;
  return true;
};

// ── تيليجرام
const tg = async msg => {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) { log('TG ERR: ' + e.message); }
};

// ══════════════════════════════════════════════════════════════════
// دوال المؤشرات
// ══════════════════════════════════════════════════════════════════
const ema = (arr, n) => {
  const k = 2 / (n + 1); let e = arr[0];
  return arr.map(v => { e = v * k + e * (1 - k); return e; });
};

const rsi14 = arr => {
  let g = 0, l = 0;
  for (let i = 1; i < 15; i++) { const d = arr[i] - arr[i - 1]; d > 0 ? g += d : l -= d; }
  let ag = g / 14, al = l / 14;
  const res = [50];
  for (let i = 15; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    ag = (ag * 13 + (d > 0 ? d : 0)) / 14;
    al = (al * 13 + (d < 0 ? -d : 0)) / 14;
    res.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return res;
};

const macdCalc = arr => {
  const e12 = ema(arr, 12), e26 = ema(arr, 26);
  const line = e12.map((v, i) => v - e26[i]);
  const sig  = ema(line, 9);
  const hist = line.map((v, i) => v - sig[i]);
  return { line, sig, hist };
};

const bollingerCalc = (arr, n = 20, mult = 2) => {
  return arr.map((_, i) => {
    if (i < n - 1) return { u: 0, l: 0, b: 0 };
    const sl = arr.slice(i - n + 1, i + 1);
    const m  = sl.reduce((a, v) => a + v, 0) / n;
    const sd = Math.sqrt(sl.reduce((a, v) => a + (v - m) ** 2, 0) / n);
    return { u: m + mult * sd, l: m - mult * sd, b: m };
  });
};

const superTrend = (highs, lows, closes, atrPeriod = 10, mult = 3) => {
  const atrs = closes.map((_, i) => {
    if (i === 0) return highs[0] - lows[0];
    return Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  });
  const atrEma = ema(atrs, atrPeriod);
  let dir = 1, st = closes[0];
  return closes.map((c, i) => {
    const hl2 = (highs[i] + lows[i]) / 2;
    const up  = hl2 + mult * atrEma[i], dn = hl2 - mult * atrEma[i];
    if (c > st && dir === -1) dir = 1;
    if (c < st && dir === 1)  dir = -1;
    st = dir === 1 ? Math.max(dn, st) : Math.min(up, st);
    return { v: st, d: dir };
  });
};

const atrCalc = (highs, lows, closes, n = 14) => {
  const trs = closes.map((_, i) => {
    if (i === 0) return highs[0] - lows[0];
    return Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  });
  return ema(trs, n).at(-1) || 20;
};

// Black-Scholes
function bsOpt(Sp, K, T, sig, opt) {
  if (T <= 0) return Math.max(opt === 'c' ? Sp - K : K - Sp, 0);
  const sqt = Math.sqrt(T);
  const d1  = (Math.log(Sp / K) + (0.053 + 0.5 * sig * sig) * T) / (sig * sqt);
  const d2  = d1 - sig * sqt;
  const N   = x => {
    const p2 = [0.319381530, -0.356563782, 1.781477937, -1.821255978, 1.330274429];
    const t  = 1 / (1 + 0.2316419 * Math.abs(x));
    let poly = 0, tp = t;
    for (const c of p2) { poly += c * tp; tp *= t; }
    const nd = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
    return x >= 0 ? 1 - nd * poly : nd * poly;
  };
  if (opt === 'c') return Math.max(Sp * N(d1) - K * Math.exp(-0.053 * T) * N(d2), 0);
  return Math.max(K * Math.exp(-0.053 * T) * (1 - N(d2)) - Sp * (1 - N(d1)), 0);
}

// IV من VIX
function getIV() {
  const vixNow = S.vix > 0 ? S.vix : 18;
  return Math.max(0.05, Math.min(0.60, (vixNow / 100) * Math.sqrt(1 / 12)));
}

// ── حساب Delta تقريبي
function calcDelta(Sp, K, T, sig, opt) {
  if (T <= 0) return opt === 'c' ? (Sp > K ? 1 : 0) : (Sp < K ? -1 : 0);
  const sqt = Math.sqrt(T);
  const d1  = (Math.log(Sp / K) + (0.053 + 0.5 * sig * sig) * T) / (sig * sqt);
  const N   = x => {
    const p2 = [0.319381530, -0.356563782, 1.781477937, -1.821255978, 1.330274429];
    const t  = 1 / (1 + 0.2316419 * Math.abs(x));
    let poly = 0, tp = t;
    for (const c of p2) { poly += c * tp; tp *= t; }
    const nd = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
    return x >= 0 ? 1 - nd * poly : nd * poly;
  };
  return opt === 'c' ? N(d1) : N(d1) - 1;
}

// ── ابحث عن أفضل سترايك: الأولوية (1) سعر $250-$350 (2) Delta 0.30-0.45 (3) أفضل R:R
function findStrikeForBudget(maxBudget, isLong, T, sig) {
  const p   = S.price;
  const opt = isLong ? 'c' : 'p';
  const base = Math.round(p / 5) * 5;

  // اجمع كل المرشحين (من ATM حتى 300 نقطة OTM)
  const candidates = [];
  for (let diff = 0; diff <= 300; diff += 5) {
    const K  = base + (isLong ? diff : -diff);
    if (K <= 0) continue;
    const pr = bsOpt(p, K, T, sig, opt);
    const cv = Math.round(pr * 100);
    const dl = Math.abs(calcDelta(p, K, T, sig, opt));
    candidates.push({ K, pr, cv, dl, diff });
  }

  // الأولوية 1: سعر $250-$350 + Delta 0.30-0.45
  let pool = candidates.filter(c => c.cv >= 250 && c.cv <= maxBudget && c.dl >= 0.30 && c.dl <= 0.45);

  // الأولوية 2: سعر $250-$350 فقط
  if (!pool.length) pool = candidates.filter(c => c.cv >= 250 && c.cv <= maxBudget);

  // الأولوية 3: أي سعر تحت الحد
  if (!pool.length) pool = candidates.filter(c => c.cv <= maxBudget && c.cv > 50);

  // fallback
  if (!pool.length) pool = candidates;

  // اختر الأقرب لـ Delta=0.40 وسعر=$300
  pool.sort((a, b) => {
    const aScore = Math.abs(a.dl - 0.40) * 10 + Math.abs(a.cv - 300) / 100;
    const bScore = Math.abs(b.dl - 0.40) * 10 + Math.abs(b.cv - 300) / 100;
    return aScore - bScore;
  });

  const best   = pool[0];
  const strike = best.K;
  const pv     = Math.round(best.pr * 100) / 100;
  const cv     = Math.round(pv * 100);
  const dl     = Math.round(best.dl * 100) / 100;
  const slP    = Math.round(pv * 0.60 * 100) / 100;
  const tpP    = Math.round(pv * 2.00 * 100) / 100;
  const otm    = best.diff;

  return {
    strike, pv, cv, dl, slP, tpP, otm,
    otmLbl  : otm === 0 ? 'ATM' : `OTM ${isLong ? '+' : '-'}${otm} نقطة`,
    deltaLbl: `\u0394 ${dl}`,
    slLoss  : cv - Math.round(slP * 100),
    tpGain  : Math.round(tpP * 100) - cv,
  };
}


// ══════════════════════════════════════════════════════════════════
// جلب بيانات السوق
// ══════════════════════════════════════════════════════════════════
async function fetchLivePrice(sym) {
  const hdrs   = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };
  const symFH  = sym === '^GSPC' ? 'SPX' : sym.replace('^', '');
  const enc    = encodeURIComponent(sym);

  // 1. Finnhub
  const FHK = process.env.FINNHUB_KEY || RUNTIME_KEYS.finnhub || '';
  if (FHK) {
    try {
      const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${symFH}&token=${FHK}`,
        { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const d = await r.json();
        if (d && d.c > 0) {
          const price = d.c, prev = d.pc || d.c, chg = price - prev, pct = prev ? chg / prev * 100 : 0;
          const now = new Date(), etH = ((now.getUTCHours() - 4 + 24) % 24) + now.getUTCMinutes() / 60, day = now.getUTCDay();
          let state = 'CLOSED', isExt = false;
          if (day >= 1 && day <= 5) {
            if (etH >= 4 && etH < 9.5)  { state = 'PRE';     isExt = true; }
            else if (etH >= 9.5 && etH < 16) { state = 'REGULAR'; }
            else if (etH >= 16 && etH < 20) { state = 'POST';  isExt = true; }
          }
          S._lastSource = 'Finnhub';
          log(`[Finnhub OK] SPX=${price.toFixed(2)} ${state}`);
          return { price, isExt, state, change: chg, changePct: pct,
            high: d.h || price, low: d.l || price, open: d.o || price, prev, source: 'Finnhub' };
        }
      }
    } catch (e) { log('[Finnhub ERR] ' + e.message); }
  }

  // 2. Yahoo v7
  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const fields = 'regularMarketPrice,preMarketPrice,postMarketPrice,marketState,regularMarketDayHigh,regularMarketDayLow,regularMarketOpen,regularMarketPreviousClose,regularMarketChange,regularMarketChangePercent,preMarketChange,preMarketChangePercent,postMarketChange,postMarketChangePercent';
      const r = await fetch(`${base}/v7/finance/quote?symbols=${enc}&fields=${fields}`,
        { headers: hdrs, signal: AbortSignal.timeout(6000) });
      if (!r.ok) continue;
      const qt = (await r.json())?.quoteResponse?.result?.[0];
      if (!qt) continue;
      const state = qt.marketState || 'REGULAR';
      const isPre  = state === 'PRE' || state === 'PREPRE';
      const isPost = state === 'POST' || state === 'POSTPOST';
      let price = qt.regularMarketPrice, chg = qt.regularMarketChange || 0, pct = qt.regularMarketChangePercent || 0;
      if (isPre  && qt.preMarketPrice)  { price = qt.preMarketPrice;  chg = qt.preMarketChange  || 0; pct = qt.preMarketChangePercent  || 0; }
      if (isPost && qt.postMarketPrice) { price = qt.postMarketPrice; chg = qt.postMarketChange || 0; pct = qt.postMarketChangePercent || 0; }
      if (!price) continue;
      S._lastSource = 'Yahoo_v7';
      log(`[Yahoo v7 OK] SPX=${price.toFixed(2)} ${state}`);
      return { price, isExt: isPre || isPost, state, change: chg, changePct: pct,
        high: qt.regularMarketDayHigh || price, low: qt.regularMarketDayLow || price,
        open: qt.regularMarketOpen || price, prev: qt.regularMarketPreviousClose || price, source: 'Yahoo_v7' };
    } catch (e) { log('[Yahoo v7 ERR] ' + e.message); }
  }

  // 3. Yahoo v8
  try {
    const r = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${enc}?interval=1m&range=1d`,
      { headers: hdrs, signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      const meta = (await r.json())?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice) {
        const state = meta.marketState || 'REGULAR';
        let price = meta.regularMarketPrice;
        if (state === 'PRE' && meta.preMarketPrice) price = meta.preMarketPrice;
        if ((state === 'POST' || state === 'POSTPOST') && meta.postMarketPrice) price = meta.postMarketPrice;
        const prev = meta.previousClose || price;
        S._lastSource = 'Yahoo_v8';
        return { price, isExt: state === 'PRE' || state === 'POST' || state === 'POSTPOST', state,
          change: price - prev, changePct: prev ? (price - prev) / prev * 100 : 0,
          high: meta.regularMarketDayHigh || price, low: meta.regularMarketDayLow || price,
          open: meta.regularMarketOpen || price, prev, source: 'Yahoo_v8' };
      }
    }
  } catch (e) { log('[Yahoo v8 ERR] ' + e.message); }

  // 4. Stooq
  try {
    const r = await fetch('https://stooq.com/q/l/?s=^spx&f=sd2t2ohlcv&h&e=json',
      { signal: AbortSignal.timeout(7000) });
    if (r.ok) {
      const row = (await r.json())?.symbols?.[0];
      if (row && row.close > 0) {
        S._lastSource = 'Stooq';
        return { price: row.close, isExt: false, state: 'DELAYED',
          change: row.close - (row.open || row.close), changePct: 0,
          high: row.high || row.close, low: row.low || row.close,
          open: row.open || row.close, prev: row.open || row.close, source: 'Stooq' };
      }
    }
  } catch (e) { log('[Stooq ERR] ' + e.message); }

  return null;
}

// ══════════════════════════════════════════════════════════════════
// تحميل بيانات الشارت
// ══════════════════════════════════════════════════════════════════
async function loadMarketData() {
  try {
    const hdrs = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=60d',
      { headers: hdrs, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const js = (await r.json())?.chart?.result?.[0];
    if (!js) throw new Error('no data');

    const quotes = js.indicators.quote[0];
    const closes = quotes.close.filter(Boolean);
    const highs  = quotes.high.filter(Boolean);
    const lows   = quotes.low.filter(Boolean);
    const vols   = quotes.volume.filter(v => v != null);

    if (closes.length < 30) throw new Error('too short');

    const c = closes, h = highs, l = lows;

    const rsiArr = rsi14(c);
    const { line: ml, sig: ms, hist: mh } = macdCalc(c);
    const bbArr  = bollingerCalc(c);
    const stArr  = superTrend(h, l, c);
    const e9     = ema(c, 9), e21 = ema(c, 21), e50 = ema(c, 50), e200 = ema(c, 200);
    const atr    = atrCalc(h, l, c);

    const skArr = c.map((_, i) => {
      if (i < 13) return 50;
      const sl = c.slice(i - 13, i + 1), hl = Math.max(...sl), ll = Math.min(...sl);
      return hl === ll ? 50 : (c[i] - ll) / (hl - ll) * 100;
    });
    const sdArr = ema(skArr, 3);

    let obv = 0;
    const obvArr = c.map((p, i) => {
      if (i > 0) obv += p > c[i - 1] ? (vols[i] || 0) : p < c[i - 1] ? -(vols[i] || 0) : 0;
      return obv;
    });
    const obvEArr = ema(obvArr, 21);

    const vwSlice = 20, vwC = c.slice(-vwSlice), vwV = vols.slice(-vwSlice);
    const vwNum   = vwC.reduce((s, p, i) => s + p * (vwV[i] || 1), 0);
    const vwDen   = vwV.reduce((s, v) => s + (v || 1), 0);
    const vwap    = vwDen > 0 ? vwNum / vwDen : c.at(-1);

    const fibH = Math.max(...c.slice(-20)), fibL = Math.min(...c.slice(-20));

    const live  = await fetchLivePrice('^GSPC');
    const price = live?.price || c.at(-1);

    // VIX
    try {
      const vr = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=2d',
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) });
      if (vr.ok) {
        const vc = (await vr.json())?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(Boolean);
        if (vc && vc.length >= 1) {
          S.vixPrev = S.vix || vc[vc.length - 2] || 0;
          S.vix     = Math.round(vc[vc.length - 1] * 100) / 100;
        }
      }
    } catch (_) {}

    Object.assign(S, {
      price, prev: live?.prev || c.at(-2) || price,
      open: live?.open || c.at(-1), high: live?.high || h.at(-1),
      low:  live?.low  || l.at(-1), vol:  vols.at(-1) || 0,
      volR: vols.length > 20 ? vols.at(-1) / (vols.slice(-20).reduce((a, v) => a + v, 0) / 20) : 1,
      rsi:  rsiArr.at(-1) || 50, macd: ml.at(-1) || 0, msig: ms.at(-1) || 0, mhist: mh.at(-1) || 0,
      sk:   skArr.at(-1)  || 50, sd:   sdArr.at(-1) || 50,
      bbU:  bbArr.at(-1).u || price + 50, bbL: bbArr.at(-1).l || price - 50, bbB: bbArr.at(-1).b || price,
      stV:  stArr.at(-1).v || price, stD: stArr.at(-1).d || 1,
      ema9: e9.at(-1) || 0, ema21: e21.at(-1) || 0, ema50: e50.at(-1) || 0, ema200: e200.at(-1) || 0,
      vwap, obv: obvArr.at(-1) || 0, obvE: obvEArr.at(-1) || 0,
      fibH, fibL, atr, mktState: live?.state || 'REGULAR', isExt: live?.isExt || false,
      dataSource: S._lastSource || 'Yahoo',
    });

    S.history = c.slice(-100).map((p, i) => ({
      t: Date.now() - ((c.slice(-100).length - 1 - i) * 86400000),
      o: p, h: p, l: p, c: p, v: vols.slice(-100)[i] || 0,
    }));

    log(`✅ Market loaded: SPX=${price.toFixed(2)} RSI=${S.rsi.toFixed(1)} ST=${S.stD} VWAP=${S.vwap.toFixed(2)} ATR=${S.atr.toFixed(1)}`);
    return true;
  } catch (e) {
    log('❌ loadMarketData: ' + e.message);
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════
// Support/Resistance تلقائي
// ══════════════════════════════════════════════════════════════════
function calcSRLevels(history) {
  if (!history || history.length < 5) return { support: 0, resistance: 0, srBull: false, srBear: false };
  const recent     = history.slice(-20);
  const h_arr      = recent.map(c => c.h || c.c || c);
  const l_arr      = recent.map(c => c.l || c.c || c);
  const closes_arr = recent.map(c => c.c || c);
  const resistance = Math.max(...h_arr);
  const support    = Math.min(...l_arr);
  const price      = closes_arr[closes_arr.length - 1];
  const atr        = S.atr || 20;
  const srBull     = price > support   && Math.abs(price - support)    < atr * 0.8;
  const srBear     = price < resistance && Math.abs(price - resistance) < atr * 0.8;
  return { support: Math.round(support * 100) / 100, resistance: Math.round(resistance * 100) / 100, srBull, srBear };
}

// ══════════════════════════════════════════════════════════════════
// التقويم الاقتصادي
// ══════════════════════════════════════════════════════════════════
function getHighImpactWindow() {
  const now    = new Date();
  const etH    = ((now.getUTCHours() - 4 + 24) % 24);
  const etM    = now.getUTCMinutes();
  const etMin  = etH * 60 + etM;
  const dow    = now.getUTCDay();

  const EVENTS = [
    { dow: 5, time: 8*60+30, name: 'NFP/بيانات التوظيف الجمعة', window: 40 },
    { dow: 3, time: 8*60+30, name: 'ADP التوظيف', window: 30 },
    { dow: 3, time: 14*60+0, name: 'FOMC بيان الفائدة', window: 60 },
    { dow: 2, time: 8*60+30, name: 'CPI التضخم', window: 40 },
    { dow: 4, time: 8*60+30, name: 'GDP ناتج محلي', window: 30 },
    { dow: 4, time: 8*60+30, name: 'طلبات إعانة البطالة', window: 25 },
    { dow: 1, time: 10*60+0, name: 'ISM مؤشر التصنيع', window: 25 },
  ];

  for (const ev of EVENTS) {
    if (dow !== ev.dow) continue;
    const diff = etMin - ev.time;
    if (diff >= -30 && diff <= ev.window) {
      return { active: true, name: ev.name, minsLeft: diff < 0 ? Math.abs(diff) : 0 };
    }
  }
  return { active: false, name: '', minsLeft: 0 };
}

// ══════════════════════════════════════════════════════════════════
// نظام الإشارات — 22 نقطة
// ══════════════════════════════════════════════════════════════════
function computeSig() {
  const p = S.price;
  const empty = { isBuy: false, isSell: false, bs: 0, ss: 0,
    bScore: 0, sScore: 0, bPct: 0, sPct: 0, bLabels: [], sLabels: [],
    bc: [], sc: [], badTime: false, sideways: false, conviction: 0,
    bGrade: '', sGrade: '', reason: '', bullishFlow: false, bearishFlow: false,
    inVwapBull: false, inVwapBear: false };

  if (!p || p === 0) return empty;

  const etH      = ((new Date().getUTCHours() - 4 + 24) % 24) + new Date().getUTCMinutes() / 60;
  const tooEarly = etH < 9.75;
  const tooLate  = etH > 15.5;
  const badTime  = tooEarly || tooLate;

  const HI = getHighImpactWindow();
  if (HI.active) return { ...empty, badTime: true, reason: 'حدث اقتصادي: ' + HI.name };

  const vixHigh = S.vix > 0 && S.vix > 35;
  if (vixHigh) return { ...empty, sideways: true, reason: `VIX مرتفع جداً: ${S.vix} — سوق مضطرب` };

  const gapPct          = S.open > 0 ? Math.abs(S.price - S.open) / S.open * 100 : 0;
  const minutesSinceOpen = etH > 9.5 ? (etH - 9.5) * 60 : 9999;
  const gapOpen          = gapPct > 0.5 && minutesSinceOpen < 15;
  if (gapOpen) return { ...empty, badTime: true, reason: `فجوة افتتاح ${gapPct.toFixed(1)}% — انتظر 15 دقيقة` };

  const bbRange  = Math.max(S.bbU - S.bbL, 1);
  const bbWidth  = bbRange / p;
  const sideways = bbWidth < 0.003;
  const lowATR   = S.atr > 0 && S.atr < 12;
  const bbPct    = (p - S.bbL) / bbRange;
  const vwap     = S.vwap || p;

  const vwapSigma = (S.atr || 20) * 0.6;
  const vwapU1    = vwap + vwapSigma;
  const vwapL1    = vwap - vwapSigma;
  const inVwapBull = p > vwap && p < vwapU1;
  const inVwapBear = p < vwap && p > vwapL1;

  const dailyBull = S.ema200 > 0 ? p > S.ema200 : true;
  const dailyBear = S.ema200 > 0 ? p < S.ema200 : true;

  const volAboveAvg = S.volR >= 1.2;
  const bullishFlow = S.obv > S.obvE && volAboveAvg && p > S.prev;
  const bearishFlow = S.obv < S.obvE && volAboveAvg && p < S.prev;
  const strongBull  = S.obv > S.obvE && S.volR >= 1.5;
  const strongBear  = S.obv < S.obvE && S.volR >= 1.5;

  const bc = [
    { pass: S.stD === 1,                               w: 3, label: 'SuperTrend ↑',  core: true },
    { pass: S.vwap > 0 && p > vwap,                   w: 3, label: 'فوق VWAP',       core: true },
    { pass: S.ema9 > 0 && S.ema9 > S.ema21,           w: 2, label: 'EMA9 > EMA21' },
    { pass: S.mhist > 0 && S.macd > S.msig,           w: 2, label: 'MACD ↑' },
    { pass: S.rsi >= 42 && S.rsi < 65,                w: 2, label: 'RSI ' + Math.round(S.rsi) },
    { pass: bbPct < 0.45,                              w: 2, label: 'BB شراء' },
    { pass: calcSRLevels(S.history).srBull,            w: 1, label: 'قرب دعم S/R' },
    { pass: inVwapBull,                                w: 2, label: 'VWAP Band ↑' },
    { pass: bullishFlow || strongBull,                 w: 2, label: 'Order Flow ↑' },
    { pass: S.ema21 > 0 && S.ema21 > S.ema50,         w: 1, label: 'EMA21>EMA50' },
    { pass: dailyBull,                                 w: 1, label: 'Daily Bull' },
    { pass: S.sk > 0 && S.sk < 60,                    w: 1, label: 'Stoch ' + Math.round(S.sk) },
  ];

  const sc = [
    { pass: S.stD === -1,                              w: 3, label: 'SuperTrend ↓', core: true },
    { pass: S.vwap > 0 && p < vwap,                   w: 3, label: 'تحت VWAP',      core: true },
    { pass: S.ema9 > 0 && S.ema9 < S.ema21,           w: 2, label: 'EMA9 < EMA21' },
    { pass: S.mhist < 0 && S.macd < S.msig,           w: 2, label: 'MACD ↓' },
    { pass: S.rsi > 55 && S.rsi <= 78,                w: 2, label: 'RSI ' + Math.round(S.rsi) },
    { pass: bbPct > 0.55,                              w: 2, label: 'BB بيع' },
    { pass: calcSRLevels(S.history).srBear,            w: 1, label: 'قرب مقاومة S/R' },
    { pass: inVwapBear,                                w: 2, label: 'VWAP Band ↓' },
    { pass: bearishFlow || strongBear,                 w: 2, label: 'Order Flow ↓' },
    { pass: S.ema21 > 0 && S.ema21 < S.ema50,         w: 1, label: 'EMA21<EMA50' },
    { pass: dailyBear,                                 w: 1, label: 'Daily Bear' },
    { pass: S.sk > 0 && S.sk > 40,                    w: 1, label: 'Stoch ' + Math.round(S.sk) },
  ];

  const bPassed  = bc.filter(c => c.pass);
  const sPassed  = sc.filter(c => c.pass);
  const bScore   = bPassed.reduce((s, c) => s + c.w, 0);
  const sScore   = sPassed.reduce((s, c) => s + c.w, 0);
  const maxScore = 22;
  const bPct     = Math.round(bScore / maxScore * 100);
  const sPct     = Math.round(sScore / maxScore * 100);
  const bLabels  = bPassed.map(c => c.label);
  const sLabels  = sPassed.map(c => c.label);

  const bHasCore = bPassed.filter(c => c.core).length === 2;
  const sHasCore = sPassed.filter(c => c.core).length === 2;

  const bHasFlow = bPassed.some(c => c.label === 'Order Flow ↑');
  const sHasFlow = sPassed.some(c => c.label === 'Order Flow ↓');

  // تصنيف الإشارة — محسوب مبكراً قبل الاستخدام
  const bGrade = (bScore >= 15 && bHasCore && bPassed.length >= 6 && bHasFlow) ? 'A+'
               : (bScore >= 11 && bHasCore && bPassed.length >= 5) ? 'A'
               : (bScore >= 8  && bHasCore && bPassed.length >= 4) ? 'B' : '';

  const sGrade = (sScore >= 15 && sHasCore && sPassed.length >= 6 && sHasFlow) ? 'A+'
               : (sScore >= 11 && sHasCore && sPassed.length >= 5) ? 'A'
               : (sScore >= 8  && sHasCore && sPassed.length >= 4) ? 'B' : '';

  let reason = '';
  if (badTime)     reason = 'وقت سيئ';
  else if (sideways) reason = 'سوق جانبي BB=' + (bbWidth * 100).toFixed(2) + '%';
  else if (lowATR)   reason = 'ATR منخفض=' + (S.atr || 0).toFixed(1);

  const valid  = !badTime && !sideways && !lowATR;
  const isBuy  = valid && bGrade !== '' && bScore > sScore;
  const isSell = valid && sGrade !== '' && sScore > bScore;

  return {
    isBuy, isSell, bs: bPassed.length, ss: sPassed.length,
    bScore, sScore, bPct, sPct, maxScore,
    bLabels, sLabels, bc, sc,
    bGrade, sGrade, badTime, sideways, lowATR, reason,
    bullishFlow, bearishFlow, inVwapBull, inVwapBear,
    conviction: isBuy ? bPct : isSell ? sPct : 0,
  };
}

// ══════════════════════════════════════════════════════════════════
// Probability Engine
// ══════════════════════════════════════════════════════════════════
function calcProbability(isLong, bScore, sScore, maxScore) {
  const p          = S.price;
  const vwap       = S.vwap || p;
  const atr        = S.atr  || 20;
  const etH        = ((new Date().getUTCHours() - 4 + 24) % 24) + new Date().getUTCMinutes() / 60;
  const hoursLeft  = Math.max(16.0 - etH, 0.1);
  const sigScore   = isLong ? bScore : sScore;
  const sigPct     = sigScore / maxScore;
  const vwapDist   = Math.abs(p - vwap);
  const vwapPctD   = vwapDist / atr;

  let vwapScore;
  if (isLong) {
    vwapScore = vwapPctD < 0.3 ? 1.0 : vwapPctD < 0.6 ? 0.85 : vwapPctD < 1.0 ? 0.65 : vwapPctD < 1.5 ? 0.40 : 0.20;
    if (p < vwap) vwapScore *= 0.3;
  } else {
    vwapScore = vwapPctD < 0.3 ? 1.0 : vwapPctD < 0.6 ? 0.85 : vwapPctD < 1.0 ? 0.65 : vwapPctD < 1.5 ? 0.40 : 0.20;
    if (p > vwap) vwapScore *= 0.3;
  }

  let momentumScore = 0;
  if (isLong) {
    if (S.mhist > 0) momentumScore += 0.5;
    if (S.rsi >= 45 && S.rsi < 60) momentumScore += 0.5;
    else if (S.rsi >= 40 && S.rsi < 65) momentumScore += 0.3;
  } else {
    if (S.mhist < 0) momentumScore += 0.5;
    if (S.rsi > 55 && S.rsi <= 70) momentumScore += 0.5;
    else if (S.rsi > 50 && S.rsi <= 75) momentumScore += 0.3;
  }

  let trendScore = 0;
  if (isLong) {
    if (S.stD === 1)        trendScore += 0.4;
    if (S.ema9 > S.ema21)   trendScore += 0.3;
    if (S.ema21 > S.ema50)  trendScore += 0.2;
    if (S.ema50 > S.ema200) trendScore += 0.1;
  } else {
    if (S.stD === -1)       trendScore += 0.4;
    if (S.ema9 < S.ema21)   trendScore += 0.3;
    if (S.ema21 < S.ema50)  trendScore += 0.2;
    if (S.ema50 < S.ema200) trendScore += 0.1;
  }

  const volBull  = S.obv > S.obvE && S.volR >= 1.2;
  const volBear  = S.obv < S.obvE && S.volR >= 1.2;
  const volScore = isLong
    ? (S.volR >= 1.5 && volBull ? 1.0 : volBull ? 0.75 : S.volR >= 1.0 ? 0.45 : 0.25)
    : (S.volR >= 1.5 && volBear ? 1.0 : volBear ? 0.75 : S.volR >= 1.0 ? 0.45 : 0.25);

  const bestMorning   = etH >= 10.0 && etH < 11.5;
  const bestAfternoon = etH >= 13.5 && etH < 15.0;
  const goodTime      = etH >= 9.75 && etH < 15.5;
  const timeScore     = bestMorning || bestAfternoon ? 1.0 : goodTime ? 0.7 : 0.3;

  const thetaScore = hoursLeft > 4 ? 1.0 : hoursLeft > 2 ? 0.8 : hoursLeft > 1 ? 0.55 : 0.25;
  const atrScore   = atr > 30 ? 1.0 : atr > 20 ? 0.85 : atr > 15 ? 0.65 : atr > 10 ? 0.40 : 0.20;

  const factors = [
    { name: 'قوة الإشارة',      score: Math.min(sigPct * 1.3, 1.0),     weight: 30, detail: `${sigScore}/${maxScore}` },
    { name: 'موقع VWAP',        score: vwapScore,                        weight: 20, detail: `${vwapDist.toFixed(1)}pt` },
    { name: 'مومنتم MACD+RSI',  score: momentumScore,                    weight: 15, detail: `RSI:${S.rsi.toFixed(0)}` },
    { name: 'تناسق الاتجاه',    score: Math.min(trendScore, 1.0),        weight: 15, detail: `ST:${S.stD===1?'↑':'↓'}` },
    { name: 'Order Flow',       score: volScore,                         weight: 10, detail: `Vol:${(S.volR||1).toFixed(1)}x` },
    { name: 'توقيت الجلسة',     score: timeScore,                        weight:  5, detail: etH.toFixed(1) + 'h ET' },
    { name: 'Theta Risk',       score: thetaScore,                       weight:  3, detail: `${hoursLeft.toFixed(1)}h` },
    { name: 'تقلب ATR',         score: atrScore,                         weight:  2, detail: `ATR:${atr.toFixed(0)}` },
  ];

  const totalW = factors.reduce((s, f) => s + f.weight, 0);
  const wSum   = factors.reduce((s, f) => s + f.score * f.weight, 0);
  const prob   = Math.round(Math.min(wSum / totalW * 100, 92));

  const topFactors  = factors.filter(f => f.score >= 0.75).sort((a, b) => b.score * b.weight - a.score * a.weight).slice(0, 3);
  const weakFactors = factors.filter(f => f.score < 0.5).sort((a, b) => a.score * a.weight - b.score * b.weight).slice(0, 2);
  const grade = prob >= 75 ? '🟢 عالية' : prob >= 60 ? '🟡 متوسطة' : '🔴 منخفضة';

  return { prob, grade, factors, topFactors, weakFactors };
}

// ══════════════════════════════════════════════════════════════════
// نظام الحجم المتغير
// ══════════════════════════════════════════════════════════════════
function calcContracts(prob, grade, vix) {
  let base = 1;
  if (prob >= 80 && grade === 'A+') base = 2;
  else if (prob >= 75 && grade !== 'B') base = 2;
  if (vix > 25 && vix <= 35) base = Math.max(1, base - 1);
  if (vix > 30) base = 1;
  return Math.min(base, 3);
}

// ══════════════════════════════════════════════════════════════════
// تنسيق الأرقام
// ══════════════════════════════════════════════════════════════════
const fmt  = n => n?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || '--';
const fmtP = n => (n >= 0 ? '+' : '') + n?.toFixed(2) + '%';
const nowAr = () => new Date().toLocaleString('ar-SA', {
  timeZone: 'America/New_York', hour12: true,
  year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: '2-digit', second: '2-digit',
});
const mktLn = () => {
  const m = { REGULAR: '🟢 جلسة رسمية', PRE: '🌅 ما قبل الجلسة',
    POST: '🌙 ما بعد الجلسة', CLOSED: '🔴 السوق مغلق', DELAYED: '⏱️ بيانات مؤخرة' };
  return m[S.mktState] || '📊 ' + S.mktState;
};

// ══════════════════════════════════════════════════════════════════
// تنبيهات تيليجرام
// ══════════════════════════════════════════════════════════════════
async function alertEntry(type, bScore, sScore, bLabels, sLabels) {
  const weeklyCheck = WEEKLY.isBlocked();
  if (weeklyCheck.blocked) {
    log('[WeeklyBlock] ' + weeklyCheck.reason);
    await tg(`⛔ <b>NEXUS v8 — إيقاف تلقائي</b>\n\n${weeklyCheck.reason}\n\nسيُستأنف الأسبوع القادم تلقائياً.\n⏰ ${nowAr()}`);
    return;
  }

  const p    = S.price;
  const isL  = type === 'BUY';
  const score = isL ? bScore : sScore;

  const PB        = calcProbability(isL, bScore, sScore, 22);
  const probVal   = PB.prob;
  const probGrade = PB.grade;
  const topFacts  = PB.topFactors.map(f => f.name).join(' · ');
  const weakFacts = PB.weakFactors.length > 0
    ? '⚠️ ' + PB.weakFactors.map(f => f.name + ' (' + Math.round(f.score * 100) + '%)').join(' | ')
    : '✅ لا مخاطر واضحة';

  if (probVal < 55) {
    log('[ProbFilter] ' + type + ' prob:' + probVal + '% - لم يرسل');
    TRADE.active = false;
    return;
  }

  const d    = isL ? 1 : -1;
  const slPts = 8, tp1Pts = 10, tp2Pts = 20, tp3Pts = 35;
  const tp1  = Math.round((p + d * tp1Pts) * 100) / 100;
  const tp2  = Math.round((p + d * tp2Pts) * 100) / 100;
  const tp3  = Math.round((p + d * tp3Pts) * 100) / 100;
  const sl   = Math.round((p - d * slPts)  * 100) / 100;
  const rr   = (tp2Pts / slPts).toFixed(1);

  const etH       = ((new Date().getUTCHours() - 4 + 24) % 24) + new Date().getUTCMinutes() / 60;
  const hoursLeft = Math.max(16.0 - etH, 0.1);
  const T         = hoursLeft / (252 * 6.5);
  const sig       = getIV();

  // تصنيف الدرجة
  const curGrade  = isL
    ? (bScore >= 15 ? 'A+' : bScore >= 11 ? 'A' : 'B')
    : (sScore >= 15 ? 'A+' : sScore >= 11 ? 'A' : 'B');
  const sigLevel  = curGrade === 'A+' ? 'A+ 🔥 ممتازة' : curGrade === 'A' ? 'A ⭐ قوية' : 'B ✅ جيدة';

  const sessionIcon = hoursLeft < 1 ? '🔴' : hoursLeft < 2 ? '🟡' : '🟢';
  const sessionNote = hoursLeft < 1 ? 'آخر ساعة' : hoursLeft < 2 ? 'آخر ساعتين' : hoursLeft < 4 ? 'منتصف الجلسة' : 'بداية الجلسة';

  const expDate = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: '2-digit', year: '2-digit',
  }).replace(', ', " '");

  // سجّل الصفقة
  Object.assign(TRADE, {
    active: true, type, entry: p, atr: S.atr,
    tp1, tp2, tp3, sl, trailSl: sl, score,
    grade: curGrade, entryHour: etH,
    tp1Hit: false, tp2Hit: false,
    nearTp1: false, nearTp2: false, slWarned: false,
    openedAt: new Date(),
  });

  const rsiV  = S.rsi.toFixed(1), macdV = S.mhist > 0 ? '▲' : '▼', stV = S.stD === 1 ? '▲' : '▼';
  const statsLine = getDailyStats();

  // رسالة 1: ملخص الإشارة
  await tg(
`${isL ? '🚀' : '🔻'} <b>NEXUS — إشارة ${isL ? 'شراء CALL' : 'بيع PUT'} | درجة ${sigLevel}</b>
━━━━━━━━━━━━━━━━━━
💹 SPX: <b>${fmt(p)}</b>  |  ${isL ? 'الاتجاه صاعد ▲' : 'الاتجاه هابط ▼'}
⭐️ قوة الإشارة: <b>${score}/22</b>  |  احتمالية النجاح: <b>${probVal}%</b>
━━━━━━━━━━━━━━━━━━
🎯 أهداف المؤشر:
├ هدف 1: <b>${fmt(tp1)}</b>  (+${tp1Pts} نقطة)
├ هدف 2: <b>${fmt(tp2)}</b>  (+${tp2Pts} نقطة)
└ هدف 3: <b>${fmt(tp3)}</b>  (+${tp3Pts} نقطة)
🛑 وقف الخسارة: <b>${fmt(sl)}</b>  (-${slPts} نقطة)
━━━━━━━━━━━━━━━━━━
👇 تفاصيل العقد حسب ميزانيتك 👇
⏰ ${nowAr()}`);

  // رسائل 2/3/4: كل ميزانية
  // رسالة واحدة — ميزانية $350
  const m = findStrikeForBudget(350, isL, T, sig);
  await tg(
`🥇 <b>NEXUS — ${isL ? 'شراء CALL' : 'شراء PUT'} | درجة ${sigLevel}</b>
━━━━━━━━━━━━━━━━━━
📋 <b>العقد المقترح:</b>
${isL ? '📈' : '📉'} SPXW <b>${isL ? 'CALL' : 'PUT'} ${m.strike}</b>
🗓 ينتهي اليوم — ${expDate}
💰 تكلفة العقد: <b>~$${m.cv}</b>
━━━━━━━━━━━━━━━━━━
⚡️ <b>خطوات التنفيذ:</b>
1️⃣ ابحث عن: <b>SPXW ${isL ? 'CALL' : 'PUT'} ${m.strike}</b>
2️⃣ تأكد السعر قريب من: <b>$${m.pv}</b> للسهم
3️⃣ اشتر عقد واحد (~$${m.cv})
━━━━━━━━━━━━━━━━━━
🛑 <b>متى تخرج بخسارة؟</b> (أيهما يحدث أولاً)
• SPX ينزل تحت <b>${fmt(sl)}</b> → اخرج فوراً
• سعر العقد ينزل لـ <b>$${m.slP}</b> → اخرج فوراً
(خسارة محتملة: ~$${m.slLoss})

🎯 <b>متى تخرج بربح؟</b>
إذا وصل سعر العقد لـ <b>$${m.tpP}</b> → اخرج
(ربح محتمل: ~$${m.tpGain})
━━━━━━━━━━━━━━━━━━
📊 SPX: <b>${fmt(p)}</b>  |  VWAP: <b>${fmt(S.vwap || p)}</b>${S.vix > 0 ? '  |  VIX: <b>' + S.vix.toFixed(1) + '</b> ' + (S.vix > 30 ? '🔴' : S.vix > 20 ? '🟡' : '🟢') : ''}
🎯 أهداف المؤشر: ${fmt(tp1)} ← ${fmt(tp2)} ← ${fmt(tp3)}
🛑 وقف المؤشر: <b>${fmt(sl)}</b>  |  نسبة الربح/الخسارة: 1:${rr}
━━━━━━━━━━━━━━━━━━
📊 سجل اليوم: ${statsLine}
⏰ ${nowAr()}
⚠️ <i>ليست نصيحة مالية</i>`);

  log(`📤 ${type} grade:${curGrade} SPXW strike:${m.strike} TP1:${fmt(tp1)} SL:${fmt(sl)}`);
}

async function alertSLBroken() {
  if (!canAlert('sl', 300)) return;
  const p  = S.price;
  const pl = ((p - TRADE.entry) / TRADE.entry * 100).toFixed(2);
  TRADE.active = false;
  await tg(
`🛑 <b>NEXUS v8 — وقف الخسارة</b>
━━━━━━━━━━━━━━━━━━━━
📊 SPX: <b>${fmt(p)}</b>
📍 دخولك: <b>${fmt(TRADE.entry)}</b>
📉 P&L: <b>${pl}%</b>
${mktLn()}
⏰ ${nowAr()}
💡 <i>التزم بخطة التداول</i>`);
}

async function alertSLWarn() {
  if (!canAlert('slwarn', 180)) return;
  await tg(`⚠️ <b>NEXUS v8 — تحذير: اقتراب وقف الخسارة</b>\n\n📊 SPX: <b>${fmt(S.price)}</b>\n🛑 وقف الخسارة: <b>${fmt(TRADE.trailSl || TRADE.sl)}</b>\n⏰ ${nowAr()}`);
}

async function alertTPHit(num, tp) {
  if (!canAlert('tp' + num, 60)) return;
  const p     = S.price;
  const emoji = num === 1 ? '🎯' : num === 2 ? '🏆' : '👑';
  await tg(
`${emoji} <b>NEXUS v8 — TP${num} ✅</b>
━━━━━━━━━━━━━━━━━━━━
📊 SPX: <b>${fmt(p)}</b>
🎯 الهدف ${num}: <b>${fmt(tp)}</b>
📍 الدخول: <b>${fmt(TRADE.entry)}</b>
💰 الربح: <b>${fmtP((p - TRADE.entry) / TRADE.entry * 100)}</b>
${mktLn()}
${num < 3 ? '💡 احمِ جزءاً من الربح' : '🎊 جميع الأهداف حققت!'}
⏰ ${nowAr()}`);
}

async function alertNearTP(num, tp) {
  await tg(`⚡ <b>NEXUS v8 — اقتراب TP${num}</b>\n📊 SPX: <b>${fmt(S.price)}</b>\n🎯 الهدف: <b>${fmt(tp)}</b>\n⏰ ${nowAr()}`);
}

async function alertRegimeChange(dir) {
  if (!canAlert('regime', 600)) return;
  await tg(
`⚡ <b>NEXUS v8 — تغيير اتجاه!</b>
━━━━━━━━━━━━━━━━━━━━
${dir === 'UP' ? '📈 الاتجاه انقلب صاعداً' : '📉 الاتجاه انقلب هابطاً'}
📊 SPX: <b>${fmt(S.price)}</b>
${mktLn()}
⏰ ${nowAr()}`);
}

async function alertCancel(msg) {
  await tg(`⚡ <b>NEXUS v8</b>\n${msg}\n📊 SPX: <b>${fmt(S.price)}</b>\n⏰ ${nowAr()}`);
}

// ══════════════════════════════════════════════════════════════════
// checkAlerts — حلقة التحقق
// ══════════════════════════════════════════════════════════════════
async function checkAlerts() {
  const sig = computeSig();
  const { isBuy, isSell, bScore, sScore, bLabels, sLabels, bGrade, sGrade, reason } = sig;
  const cur   = isBuy ? 'BUY' : isSell ? 'SELL' : 'WAIT';
  const grade = isBuy ? bGrade : isSell ? sGrade : '';
  const score = isBuy ? bScore : isSell ? sScore : 0;
  const p     = S.price;

  // إدارة الصفقة المفتوحة
  if (TRADE.active) {
    const isL  = TRADE.type === 'BUY';
    const trail = TRADE.trailSl || TRADE.sl;
    const age   = TRADE.openedAt ? (Date.now() - TRADE.openedAt.getTime()) / 60000 : 0;

    // Timeout 45 دقيقة
    if (!TRADE.tp1Hit && age > 45 && canAlert('timeout', 300)) {
      const pnl = isL ? p - TRADE.entry : TRADE.entry - p;
      recordResult('TIMEOUT', pnl, TRADE.score || 0, TRADE.grade || 'B', TRADE.type || 'BUY', TRADE.entryHour || 10);
      await tg(`⏱ <b>انتهاء الوقت — 45 دقيقة</b>\n\n📊 SPX: <b>${fmt(p)}</b>  |  دخول: <b>${fmt(TRADE.entry)}</b>\n${pnl >= 0 ? '💚' : '❤️'} P&L: <b>${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)} نقطة</b>\n\n📊 سجل اليوم: ${getDailyStats()}\n⏰ ${nowAr()}`);
      Object.assign(TRADE, { active: false, type: null, entry: 0, tp1Hit: false, tp2Hit: false });
      S.lastSig = 'WAIT'; S.confirmCount = 0; S.confirmDir = '';
      return;
    }

    // كسر SL
    if ((isL && p <= trail) || (!isL && p >= trail)) {
      const pnl = isL ? p - TRADE.entry : TRADE.entry - p;
      recordResult('SL_HIT', pnl, TRADE.score || 0, TRADE.grade || 'B', TRADE.type || 'BUY', TRADE.entryHour || 10);
      await alertSLBroken();
      return;
    }

    // تحذير SL
    const slDist = Math.abs(TRADE.entry - TRADE.sl);
    if (!TRADE.slWarned && Math.abs(p - trail) < slDist * 0.30) {
      TRADE.slWarned = true;
      await alertSLWarn();
    }

    // TP1 → breakeven
    if (!TRADE.tp1Hit) {
      if (!TRADE.nearTp1 && Math.abs(TRADE.tp1 - p) < 4) { TRADE.nearTp1 = true; await alertNearTP(1, TRADE.tp1); }
      if ((isL && p >= TRADE.tp1) || (!isL && p <= TRADE.tp1)) {
        TRADE.tp1Hit = true; TRADE.trailSl = TRADE.entry;
        await alertTPHit(1, TRADE.tp1);
      }
    }

    // TP2
    if (TRADE.tp1Hit && !TRADE.tp2Hit) {
      const newT = isL ? p - 5 : p + 5;
      if (isL && newT > TRADE.trailSl) TRADE.trailSl = newT;
      if (!isL && newT < TRADE.trailSl) TRADE.trailSl = newT;
      if (!TRADE.nearTp2 && Math.abs(TRADE.tp2 - p) < 4) { TRADE.nearTp2 = true; await alertNearTP(2, TRADE.tp2); }
      if ((isL && p >= TRADE.tp2) || (!isL && p <= TRADE.tp2)) {
        TRADE.tp2Hit = true; TRADE.trailSl = TRADE.tp1;
        await alertTPHit(2, TRADE.tp2);
      }
    }

    // TP3
    if (TRADE.tp2Hit) {
      if ((isL && p >= TRADE.tp3) || (!isL && p <= TRADE.tp3)) {
        const pnl = isL ? TRADE.tp3 - TRADE.entry : TRADE.entry - TRADE.tp3;
        recordResult('TP3', pnl, TRADE.score || 0, TRADE.grade || 'B', TRADE.type || 'BUY', TRADE.entryHour || 10);
        await alertTPHit(3, TRADE.tp3);
        Object.assign(TRADE, { active: false, type: null, entry: 0, tp1Hit: false, tp2Hit: false });
        S.lastSig = 'WAIT'; S.confirmCount = 0; S.confirmDir = '';
      }
    }

    // إشارة عكسية
    if (cur !== 'WAIT' && cur !== TRADE.type && grade === 'A+' && canAlert('reverse', 900)) {
      await alertCancel('⚡ إشارة عكسية A+ — فكّر في الخروج');
    }
    return;
  }

  // نظام التأكيد الذكي
  if (cur === 'WAIT') {
    if (S.confirmDir !== 'WAIT' && reason) log(`[Filter] ${reason}`);
    S.confirmCount = 0; S.confirmDir = 'WAIT'; S.lastSig = 'WAIT';
    return;
  }

  if (cur !== S.confirmDir) {
    S.confirmCount = 1; S.confirmDir = cur;
    log(`[C 1] ${cur} grade:${grade} score:${score}`);
    return;
  }

  S.confirmCount++;

  const needed = grade === 'A+' ? 1 : grade === 'A' ? 2 : 3;
  log(`[C ${S.confirmCount}/${needed}] ${cur} grade:${grade} score:${score}`);
  if (S.confirmCount < needed) return;

  const cd = grade === 'A+' ? 1200 : grade === 'A' ? 1800 : 2700;
  if (!canAlert('entry', cd)) { log(`[CD] ${cur} grade:${grade}`); return; }

  S.confirmCount = 0; S.confirmDir = ''; S.lastSig = cur;
  log(`✅ [SIGNAL] ${cur} grade:${grade} score:${score}`);
  await alertEntry(cur, bScore, sScore, bLabels, sLabels);
}

// ══════════════════════════════════════════════════════════════════
// Analytics & Stats
// ══════════════════════════════════════════════════════════════════
function recordResult(exitType, pnl, score, grade, tradeType, entryHour) {
  const isWin  = pnl >  2;
  const isLoss = pnl < -2;

  STATS.totalTrades++;
  STATS.totalPnl += pnl;
  if (isWin)       STATS.wins++;
  else if (isLoss) STATS.losses++;
  else             STATS.breakeven++;

  const g = grade || 'B';
  if (STATS.byGrade[g]) {
    if (isWin)  STATS.byGrade[g].w++;
    if (isLoss) STATS.byGrade[g].l++;
    STATS.byGrade[g].pnl += pnl;
  }

  const h = Math.floor(entryHour || 10);
  if (!STATS.byHour[h]) STATS.byHour[h] = { w: 0, l: 0 };
  if (isWin)  STATS.byHour[h].w++;
  if (isLoss) STATS.byHour[h].l++;

  const t = tradeType || 'BUY';
  if (STATS.byType[t]) {
    if (isWin)  STATS.byType[t].w++;
    if (isLoss) STATS.byType[t].l++;
  }

  if (isLoss && STATS.lossCause[exitType] !== undefined)
    STATS.lossCause[exitType]++;

  STATS.trades.push({
    exitType, pnl: Math.round(pnl * 10) / 10,
    score, grade: g, type: t,
    hour: entryHour || 10,
    ts: Date.now(),
  });
  if (STATS.trades.length > 100) STATS.trades.shift();

  log('[Stats] ' + exitType + ' pnl:' + pnl.toFixed(1) + ' grade:' + g + ' W:' + STATS.wins + ' L:' + STATS.losses);
}

function getDailyStats() {
  const total = STATS.wins + STATS.losses + STATS.breakeven;
  if (total === 0) return 'لا صفقات بعد اليوم';
  const wr   = Math.round(STATS.wins / (STATS.wins + STATS.losses || 1) * 100);
  const sign = STATS.totalPnl >= 0 ? '+' : '';
  return '✅' + STATS.wins + ' ❌' + STATS.losses +
         ' | Win:' + wr + '% | P&L:' + sign + STATS.totalPnl.toFixed(0) + 'pt';
}

function getFullReport() {
  const total = STATS.wins + STATS.losses + STATS.breakeven;
  if (total === 0) return '📊 لا توجد بيانات كافية بعد.';

  const wr  = Math.round(STATS.wins / (STATS.wins + STATS.losses || 1) * 100);
  const avg = (STATS.totalPnl / total).toFixed(1);

  let bestH = '?', bestWR = 0;
  for (const [h, v] of Object.entries(STATS.byHour)) {
    const tot = v.w + v.l; if (tot < 2) continue;
    const r   = Math.round(v.w / tot * 100);
    if (r > bestWR) { bestWR = r; bestH = h + ':00 ET'; }
  }

  const gradeLines = Object.entries(STATS.byGrade)
    .filter(([, v]) => v.w + v.l > 0)
    .map(([g, v]) => {
      const t = v.w + v.l;
      return g + ': ' + Math.round(v.w / t * 100) + '% (' + t + ' صفقة)';
    }).join(' | ');

  const topCause   = Object.entries(STATS.lossCause).sort((a, b) => b[1] - a[1])[0];
  const causeLabel = topCause[1] > 0
    ? (topCause[0] === 'SL_HIT' ? 'كسر SL' : topCause[0] === 'TIMEOUT' ? 'انتهاء وقت' : 'إشارة عكسية')
    : 'لا خسائر';

  return '📊 <b>تقرير الأداء</b>\n\n' +
    '📈 الصفقات: <b>' + total + '</b> | Win Rate: <b>' + wr + '%</b>\n' +
    '💰 P&L الإجمالي: <b>' + (STATS.totalPnl >= 0 ? '+' : '') + STATS.totalPnl.toFixed(0) + ' نقطة</b>\n' +
    '📉 متوسط/صفقة: <b>' + avg + ' نقطة</b>\n\n' +
    '🏆 حسب الدرجة: ' + gradeLines + '\n' +
    '⏰ أفضل وقت: <b>' + bestH + '</b> (' + bestWR + '%)\n' +
    '⚠️ سبب الخسارة الأكثر: <b>' + causeLabel + '</b>';
}

// ══════════════════════════════════════════════════════════════════
// أخبار مالية — RSS
// ══════════════════════════════════════════════════════════════════
const NEWS_CACHE = { data: [], ts: 0 };
const NEWS_TTL   = 10 * 60 * 1000;

function translateFinance(text) {
  const dict = {
    'Federal Reserve': 'الاحتياطي الفيدرالي', 'Fed': 'الفيدرالي', 'interest rates': 'أسعار الفائدة',
    'inflation': 'التضخم', 'GDP': 'الناتج المحلي', 'unemployment': 'البطالة',
    'stocks': 'الأسهم', 'market': 'السوق', 'rally': 'ارتفاع', 'decline': 'انخفاض',
    'earnings': 'الأرباح', 'revenue': 'الإيرادات', 'forecast': 'التوقعات',
    'Wall Street': 'وول ستريت', 'S&P 500': 'مؤشر S&P 500', 'Nasdaq': 'ناسداك',
    'Dow Jones': 'داو جونز', 'Treasury': 'الخزانة', 'bonds': 'السندات',
    'oil': 'النفط', 'gold': 'الذهب', 'dollar': 'الدولار', 'euro': 'اليورو',
    'China': 'الصين', 'Europe': 'أوروبا', 'Asia': 'آسيا', 'recession': 'ركود',
    'rate hike': 'رفع الفائدة', 'rate cut': 'خفض الفائدة', 'tariff': 'الرسوم الجمركية',
    'trade war': 'الحرب التجارية', 'technology': 'التكنولوجيا', 'bank': 'البنك',
    'profit': 'الربح', 'loss': 'الخسارة', 'quarterly': 'الفصلية', 'annual': 'السنوية',
    'merger': 'اندماج', 'acquisition': 'استحواذ', 'IPO': 'الاكتتاب العام',
    'crypto': 'العملات الرقمية', 'bitcoin': 'بيتكوين', 'energy': 'الطاقة',
    'report': 'التقرير', 'data': 'البيانات', 'growth': 'النمو', 'slowdown': 'التباطؤ',
  };
  let t = text;
  for (const [en, ar] of Object.entries(dict)) {
    t = t.replace(new RegExp(en, 'gi'), ar);
  }
  return t;
}

async function fetchRSS(url, src, lang) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/rss+xml,text/xml,*/*' },
      signal: AbortSignal.timeout(7000),
    });
    if (!r.ok) { log(`[News] ${src} HTTP ${r.status}`); return []; }
    const xml   = await r.text();
    const items = [];
    const itemRx = /<item[^>]*>([\s\S]*?)<\/item>/gi;
    let m;
    while ((m = itemRx.exec(xml)) !== null && items.length < 5) {
      const b = m[1];
      let title = ((b.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || '').trim();
      const link = ((b.match(/<link[^>]*>([^<]+)<\/link>/) || b.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '').trim();
      const date = ((b.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/) || [])[1] || '').trim();
      let desc   = ((b.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/) || [])[1] || '')
                    .replace(/<[^>]+>/g, '').trim().slice(0, 150);
      if (lang === 'en') { title = translateFinance(title); desc = translateFinance(desc); }
      title = title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      if (title.length > 5) items.push({ title, link, desc, src, lang: 'ar', ts: date ? new Date(date).getTime() : Date.now() });
    }
    log(`[News] ${src}: ${items.length} items`);
    return items;
  } catch (e) { log(`[News] ${src} ERR: ${e.message}`); return []; }
}

async function fetchAllNews() {
  if (Date.now() - NEWS_CACHE.ts < NEWS_TTL && NEWS_CACHE.data.length > 0) return NEWS_CACHE.data;
  const feeds = [
    { url: 'https://feeds.bbci.co.uk/arabic/business/rss.xml',      src: 'BBC عربي',    lang: 'ar' },
    { url: 'https://www.aljazeera.net/rss/economy/index.xml',         src: 'الجزيرة',     lang: 'ar' },
    { url: 'https://feeds.marketwatch.com/marketwatch/topstories/',  src: 'MarketWatch', lang: 'en' },
    { url: 'https://feeds.reuters.com/reuters/businessNews',          src: 'Reuters',     lang: 'en' },
    { url: 'https://finance.yahoo.com/news/rssindex',                 src: 'Yahoo',       lang: 'en' },
  ];
  const results = await Promise.allSettled(feeds.map(f => fetchRSS(f.url, f.src, f.lang)));
  let all = [];
  results.forEach(r => { if (r.status === 'fulfilled') all = all.concat(r.value); });
  all.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  NEWS_CACHE.data = all.slice(0, 25);
  NEWS_CACHE.ts   = Date.now();
  log(`[News] Total: ${NEWS_CACHE.data.length} items`);
  return NEWS_CACHE.data;
}

// ══════════════════════════════════════════════════════════════════
// تقارير تلقائية
// ══════════════════════════════════════════════════════════════════
let _morningReportSent    = '';
let _preMarketReportSent  = '';

// ── حساب مناطق الدعم والمقاومة — متعدد المصادر مع وزن التقاطع
function calcSRZones() {
  const p    = S.price;
  const atr  = S.atr  || 20;
  const high = S.fibH || (p + atr * 2.5);
  const low  = S.fibL || (p - atr * 2.5);
  const rng  = Math.max(high - low, 1);

  // ── 1. Fibonacci من أعلى/أدنى 20 يوم
  const fib236 = high - rng * 0.236;
  const fib382 = high - rng * 0.382;
  const fib500 = high - rng * 0.500;
  const fib618 = high - rng * 0.618;
  const fib786 = high - rng * 0.786;

  // ── 2. المستويات النفسية (كل 25 و 50 نقطة)
  const base50  = Math.round(p / 50) * 50;
  const base25  = Math.round(p / 25) * 25;
  const psychLevels = [base50-50, base50, base50+50, base25-25, base25+25];

  // ── 3. EMAs + VWAP + BB + SuperTrend
  const ema9   = S.ema9   || 0;
  const ema21  = S.ema21  || 0;
  const ema50  = S.ema50  || 0;
  const ema200 = S.ema200 || 0;
  const vwap   = S.vwap   || p;
  const bbU    = S.bbU    || 0;
  const bbL    = S.bbL    || 0;
  const stV    = S.stV    || 0;

  // ── اجمع كل المستويات في قائمة موحدة مع الوزن
  // الوزن: كلما زاد كلما كان المستوى أقوى
  const allLevels = [
    { v: fib236,  w: 2, lbl: 'Fib 23.6%' },
    { v: fib382,  w: 3, lbl: 'Fib 38.2%' },
    { v: fib500,  w: 3, lbl: 'Fib 50%'   },
    { v: fib618,  w: 3, lbl: 'Fib 61.8%' },
    { v: fib786,  w: 2, lbl: 'Fib 78.6%' },
    { v: ema9,    w: 2, lbl: 'EMA9'   },
    { v: ema21,   w: 2, lbl: 'EMA21'  },
    { v: ema50,   w: 3, lbl: 'EMA50'  },
    { v: ema200,  w: 4, lbl: 'EMA200' },
    { v: vwap,    w: 4, lbl: 'VWAP'   },
    { v: bbU,     w: 2, lbl: 'BB Upper' },
    { v: bbL,     w: 2, lbl: 'BB Lower' },
    { v: stV,     w: 3, lbl: 'SuperTrend' },
    ...psychLevels.map(v => ({ v, w: 2, lbl: 'نفسي' })),
  ].filter(l => l.v > 10);

  // دمج المستويات المتقاربة (في نطاق 8 نقاط) وجمع أوزانها
  const merged = [];
  for (const lv of allLevels) {
    const existing = merged.find(m => Math.abs(m.v - lv.v) <= 8);
    if (existing) { existing.w += lv.w; existing.lbl += '+'+lv.lbl; existing.v = (existing.v+lv.v)/2; }
    else merged.push({ ...lv });
  }

  // مقاومات: فوق السعر مرتبة من الأقرب للأبعد ثم الأقوى
  const res = merged
    .filter(l => l.v > p + 3)
    .sort((a,b) => (a.v - p) - (b.v - p) || b.w - a.w)
    .slice(0, 4);

  // دعوم: تحت السعر مرتبة من الأقرب للأبعد ثم الأقوى
  const sup = merged
    .filter(l => l.v < p - 3)
    .sort((a,b) => (p - a.v) - (p - b.v) || b.w - a.w)
    .slice(0, 4);

  return { res, sup, high: Math.round(high), low: Math.round(low), fib382, fib618 };
}

// ── تقرير تحليل الافتتاح الشامل
async function sendMorningReport() {
  const p    = S.price;
  const prev = S.prev || p;
  const chg  = p - prev;
  const chgP = prev > 0 ? (chg / prev * 100).toFixed(2) : '0.00';
  const dir  = chg >= 0 ? '📈' : '📉';
  const atr  = S.atr  || 20;
  const vwap = S.vwap || p;
  const rsi  = S.rsi  || 50;
  const open = S.open || p;

  // ── 1. قوة الاتجاه بـ 10 مؤشرات موزونة
  const trendChecks = [
    { pass: S.stD === 1,                          w: 3, lbl: 'SuperTrend ↑'   },
    { pass: p > vwap,                             w: 2, lbl: 'فوق VWAP'        },
    { pass: S.ema9  > 0 && p > S.ema9,            w: 1, lbl: 'فوق EMA9'        },
    { pass: S.ema21 > 0 && p > S.ema21,           w: 1, lbl: 'فوق EMA21'       },
    { pass: S.ema50 > 0 && p > S.ema50,           w: 2, lbl: 'فوق EMA50'       },
    { pass: S.ema200> 0 && p > S.ema200,          w: 3, lbl: 'فوق EMA200'      },
    { pass: rsi > 55,                             w: 1, lbl: 'RSI قوي'          },
    { pass: S.mhist > 0 && S.macd > S.msig,      w: 2, lbl: 'MACD ↑'          },
    { pass: S.obv > S.obvE,                       w: 2, lbl: 'حجم صاعد'         },
    { pass: p > open,                             w: 1, lbl: 'فوق الافتتاح'     },
  ];
  const maxW     = trendChecks.reduce((s,c) => s+c.w, 0);  // 18
  const bullW    = trendChecks.filter(c=>c.pass).reduce((s,c) => s+c.w, 0);
  const bullPct  = Math.round(bullW / maxW * 100);
  const trendStr = bullPct >= 72 ? '🟢 صاعد قوي' : bullPct >= 55 ? '🟡 صاعد متوسط' :
                   bullPct <= 28 ? '🔴 هابط قوي'  : '🟠 هابط متوسط';
  const trendDir = bullPct >= 55;

  // ── 2. مناطق الدعم والمقاومة المدمجة
  const sr = calcSRZones();

  // ── 3. منطقة دخول CALL — فوق أقرب مقاومة أو VWAP أيهما أعلى
  const callEntryBase = Math.max(vwap, S.ema9 || vwap, S.ema21 || vwap);
  const callEntry = Math.round((callEntryBase + 1) / 5) * 5;
  // أهداف CALL = مستويات المقاومة الموجودة فوق السعر
  const callTargets = sr.res.slice(0, 3).map(l => Math.round(l.v / 5) * 5);
  // fallback إذا لم تكن هناك مقاومات
  if (!callTargets.length) {
    callTargets.push(
      Math.round((p + atr * 0.5) / 5) * 5,
      Math.round((p + atr * 1.0) / 5) * 5,
      Math.round((p + atr * 1.8) / 5) * 5
    );
  }
  const callSL = sr.sup.length ? Math.round(sr.sup[0].v / 5) * 5 : Math.round((p - atr * 0.6) / 5) * 5;

  // ── 4. منطقة دخول PUT — تحت أقرب دعم أو VWAP أيهما أدنى
  const putEntryBase = Math.min(vwap, S.ema9 || vwap, S.ema21 || vwap);
  const putEntry  = Math.round((putEntryBase - 1) / 5) * 5;
  const putTargets = sr.sup.slice(0, 3).map(l => Math.round(l.v / 5) * 5);
  if (!putTargets.length) {
    putTargets.push(
      Math.round((p - atr * 0.5) / 5) * 5,
      Math.round((p - atr * 1.0) / 5) * 5,
      Math.round((p - atr * 1.8) / 5) * 5
    );
  }
  const putSL = sr.res.length ? Math.round(sr.res[0].v / 5) * 5 : Math.round((p + atr * 0.6) / 5) * 5;

  // ── 5. مؤشرات إضافية
  const vixStr   = S.vix > 0 ? S.vix.toFixed(1)+' '+(S.vix>30?'🔴 مرتفع':S.vix>20?'🟡 متوسط':'🟢 هادئ') : '--';
  const rsiStr   = rsi>70 ? rsi.toFixed(0)+' ⚠️ مشبع شراء' : rsi<30 ? rsi.toFixed(0)+' ⚠️ مشبع بيع' : rsi.toFixed(0)+' ✅ محايد';
  const macdStr  = S.mhist > 0 ? '▲ صاعد' : '▼ هابط';
  const bbStr    = S.bbU > 0 ? 'BB: '+fmt(S.bbL,0)+' — '+fmt(S.bbU,0) : '';
  const obvStr   = S.obv > S.obvE ? '📈 تدفق شراء' : '📉 تدفق بيع';

  // ── 6. أقوى 3 إشارات صاعدة وهابطة
  const topBull = trendChecks.filter(c=>c.pass).sort((a,b)=>b.w-a.w).slice(0,3).map(c=>c.lbl).join(' · ');
  const topBear = trendChecks.filter(c=>!c.pass).sort((a,b)=>b.w-a.w).slice(0,3).map(c=>c.lbl).join(' · ');

  // ── بناء سطور المقاومة والدعم مع قوة التقاطع
  const resLines = sr.res.slice(0,3).map((l,i) => {
    const stars = l.w >= 8 ? '⭐️⭐️⭐️' : l.w >= 5 ? '⭐️⭐️' : '⭐️';
    return '🔴 مقاومة '+(i+1)+': <b>'+fmt(l.v,0)+'</b>  '+stars+' (+'+Math.round(l.v-p)+' نقطة)';
  }).join('\n') || '🔴 لا توجد مقاومة قريبة';

  const supLines = sr.sup.slice(0,3).map((l,i) => {
    const stars = l.w >= 8 ? '⭐️⭐️⭐️' : l.w >= 5 ? '⭐️⭐️' : '⭐️';
    return '🟢 دعم '+(i+1)+': <b>'+fmt(l.v,0)+'</b>  '+stars+' (-'+Math.round(p-l.v)+' نقطة)';
  }).join('\n') || '🟢 لا يوجد دعم قريب';

  await tg(
`🌅 <b>NEXUS — تحليل افتتاح السوق</b>
━━━━━━━━━━━━━━━━━━
💹 SPX: <b>${fmt(p)}</b>  ${dir} <b>${chg>=0?'+':''}${chg.toFixed(1)}</b> (${chg>=0?'+':''}${chgP}%)
🧭 الاتجاه: <b>${trendStr}</b>  (${bullPct}% صاعد)
📊 RSI: <b>${rsiStr}</b>  |  MACD: <b>${macdStr}</b>  |  ${obvStr}
📏 ATR: <b>${atr.toFixed(1)}</b> نقطة  |  VWAP: <b>${fmt(vwap)}</b>  |  VIX: <b>${vixStr}</b>
${bbStr ? '📉 '+bbStr : ''}
━━━━━━━━━━━━━━━━━━
✅ إشارات صاعدة: ${topBull || '--'}
❌ إشارات هابطة: ${topBear || '--'}
━━━━━━━━━━━━━━━━━━
🟢 <b>منطقة دخول CALL:</b>
▶️ الدخول فوق: <b>${fmt(callEntry,0)}</b>
🎯 أهداف: ${callTargets.map(v=>'<b>'+fmt(v,0)+'</b>').join(' ← ')}
🛑 وقف: <b>${fmt(callSL,0)}</b>
━━━━━━━━━━━━━━━━━━
🔴 <b>منطقة دخول PUT:</b>
▶️ الدخول تحت: <b>${fmt(putEntry,0)}</b>
🎯 أهداف: ${putTargets.map(v=>'<b>'+fmt(v,0)+'</b>').join(' ← ')}
🛑 وقف: <b>${fmt(putSL,0)}</b>
━━━━━━━━━━━━━━━━━━
📐 <b>مناطق المقاومة:</b>
${resLines}
━━━━━━━━━━━━━━━━━━
📐 <b>مناطق الدعم:</b>
${supLines}
━━━━━━━━━━━━━━━━━━
⚠️ انتظر تأكيد الاتجاه خلال أول 15 دقيقة
⏰ ${nowAr()}`);

  S._lastTrendDir   = trendDir;
  S._lastBullPct    = bullPct;
  S._trendChecks    = trendChecks;
  log('📨 تقرير الافتتاح الشامل أُرسل');
}

// ── تحديث الاتجاه عند تغيره
let _lastTrendSent = '';
async function checkTrendChange() {
  if (!S.price || S._lastTrendDir === undefined) return;
  const p    = S.price;
  const vwap = S.vwap || p;
  const rsi  = S.rsi  || 50;
  const open = S.open || p;
  const atr  = S.atr  || 20;

  const trendChecks = [
    { pass: S.stD === 1,                     w: 3 },
    { pass: p > vwap,                        w: 2 },
    { pass: S.ema9  > 0 && p > S.ema9,       w: 1 },
    { pass: S.ema21 > 0 && p > S.ema21,      w: 1 },
    { pass: S.ema50 > 0 && p > S.ema50,      w: 2 },
    { pass: S.ema200> 0 && p > S.ema200,     w: 3 },
    { pass: rsi > 55,                        w: 1 },
    { pass: S.mhist > 0 && S.macd > S.msig, w: 2 },
    { pass: S.obv > S.obvE,                  w: 2 },
    { pass: p > open,                        w: 1 },
  ];
  const maxW   = 18;
  const bullW  = trendChecks.filter(c=>c.pass).reduce((s,c)=>s+c.w,0);
  const bullPct = Math.round(bullW / maxW * 100);
  const newDir  = bullPct >= 55;

  // يرسل فقط إذا: تغير الاتجاه + تغير بأكثر من 15% + مرّ 5 دقائق على الأقل
  const key = `${newDir}-${Math.floor(Date.now()/300000)}`;
  const pctDiff = Math.abs(bullPct - (S._lastBullPct || 50));
  if (newDir !== S._lastTrendDir && _lastTrendSent !== key && pctDiff >= 15) {
    _lastTrendSent    = key;
    S._lastTrendDir   = newDir;
    S._lastBullPct    = bullPct;
    const sr = calcSRZones();
    const trendStr = bullPct >= 72 ? '🟢 صاعد قوي' : bullPct >= 55 ? '🟡 صاعد متوسط' :
                     bullPct <= 28 ? '🔴 هابط قوي'  : '🟠 هابط متوسط';
    const entryLvl = newDir
      ? Math.round(Math.max(vwap, S.ema9||vwap)/5)*5
      : Math.round(Math.min(vwap, S.ema9||vwap)/5)*5;
    const targets  = newDir
      ? sr.res.slice(0,3).map(l=>'<b>'+fmt(l.v,0)+'</b>').join(' ← ')
      : sr.sup.slice(0,3).map(l=>'<b>'+fmt(l.v,0)+'</b>').join(' ← ');
    const slLvl = newDir
      ? Math.round((p - atr*0.6)/5)*5
      : Math.round((p + atr*0.6)/5)*5;

    await tg(
`⚡️ <b>NEXUS — تغير الاتجاه</b>
━━━━━━━━━━━━━━━━━━
💹 SPX: <b>${fmt(p)}</b>  |  VWAP: <b>${fmt(vwap)}</b>
🔄 الاتجاه الجديد: <b>${trendStr}</b>  (${bullPct}% صاعد)
━━━━━━━━━━━━━━━━━━
${newDir ?
'🟢 <b>الاتجاه صاعد — يفضل CALL</b>\n▶️ الدخول فوق: <b>'+fmt(entryLvl,0)+'</b>' :
'🔴 <b>الاتجاه هابط — يفضل PUT</b>\n▶️ الدخول تحت: <b>'+fmt(entryLvl,0)+'</b>'}
🎯 أهداف: ${targets || '--'}
🛑 وقف: <b>${fmt(slLvl,0)}</b>
━━━━━━━━━━━━━━━━━━
⏰ ${nowAr()}`);
  }
}

function checkMorningReport() {
  const now     = new Date();
  const etH     = ((now.getUTCHours() - 4 + 24) % 24) + now.getUTCMinutes() / 60;
  const day     = now.getUTCDay();
  const dateKey = now.toISOString().slice(0, 10);
  if (day === 0 || day === 6) return;
  if (etH >= 9.55 && etH <= 9.67 && _morningReportSent !== dateKey && S.price > 0) {
    _morningReportSent = dateKey;
    sendMorningReport();
  }
}

async function sendPreMarketReport() {
  const p    = S.price || 0;
  if (!p) { log('[PreMkt] لا يوجد سعر — تخطي'); return; }

  const prev  = S.prev || p;
  const chg   = p - prev;
  const chgP  = prev > 0 ? (chg / prev * 100).toFixed(2) : '0.00';
  const vwap  = S.vwap || p;
  const atr   = S.atr  || 20;
  const sig   = getIV();

  const trend = S.stD === 1 && p > vwap ? 'صاعد 📈'
              : S.stD === -1 && p < vwap ? 'هابط 📉'
              : p > vwap ? 'صاعد بحذر 📈⚠️'
              : 'هابط بحذر 📉⚠️';

  const fibR1 = Math.round((p + atr * 0.618) * 100) / 100;
  const fibR2 = Math.round((p + atr * 1.000) * 100) / 100;
  const fibS1 = Math.round((p - atr * 0.618) * 100) / 100;
  const fibS2 = Math.round((p - atr * 1.000) * 100) / 100;

  const openBias = chg > atr * 0.3  ? '🟢 افتتاح صاعد محتمل'
                 : chg < -atr * 0.3 ? '🔴 افتتاح هابط محتمل'
                 : '🟡 افتتاح محايد متوقع';

  const T_full = 6.5 / (252 * 6.5);
  const isLong = S.stD === 1 && p >= vwap;
  const mCall  = findStrikeForBudget(350, true,  T_full, sig);
  const mPut   = findStrikeForBudget(350, false, T_full, sig);

  const emaAlign = S.ema9 > S.ema21 && S.ema21 > S.ema50
    ? '✅ EMAs صاعدة (9>21>50)'
    : S.ema9 < S.ema21 && S.ema21 < S.ema50
    ? '❌ EMAs هابطة (9<21<50)'
    : '⚠️ EMAs متقاطعة (غير واضح)';

  const vixLine  = S.vix > 0
    ? `🌡 VIX: <b>${S.vix.toFixed(1)}</b>  ${S.vix > 30 ? '🔴 خطر عالٍ — قلل الحجم' : S.vix > 20 ? '🟡 تقلب متوسط' : '🟢 هادئ — ظروف جيدة'}`
    : '';

  const expDate = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: '2-digit', year: '2-digit',
  }).replace(', ', "'");

  await tg(
`🌙 <b>NEXUS v8 — تقرير ما قبل السوق</b>
━━━━━━━━━━━━━━━━━━
📊 <b>S&P 500 · SPX Futures</b>
💰 السعر الآن: <b>${fmt(p)}</b>
${chg >= 0 ? '📈' : '📉'} التغير الليلي: <b>${chg >= 0 ? '+' : ''}${chg.toFixed(2)}</b>  (${chg >= 0 ? '+' : ''}${chgP}%)
━━━━━━━━━━━━━━━━━━
🧭 <b>الاتجاه:</b> ${trend}
📐 RSI: <b>${S.rsi.toFixed(1)}</b>  |  VWAP: <b>${fmt(vwap)}</b>
${emaAlign}
${vixLine}
━━━━━━━━━━━━━━━━━━
🎯 <b>مستويات الجلسة القادمة:</b>
📌 مقاومة 2: <b>${fmt(fibR2)}</b>  (+${(fibR2 - p).toFixed(0)} نقطة)
📌 مقاومة 1: <b>${fmt(fibR1)}</b>  (+${(fibR1 - p).toFixed(0)} نقطة)
〰️ السعر الحالي: <b>${fmt(p)}</b>
📌 دعم 1:    <b>${fmt(fibS1)}</b>  (-${(p - fibS1).toFixed(0)} نقطة)
📌 دعم 2:    <b>${fmt(fibS2)}</b>  (-${(p - fibS2).toFixed(0)} نقطة)
━━━━━━━━━━━━━━━━━━
${openBias}

💡 <b>تجهيز للجلسة — SPXW ${expDate}:</b>
📈 CALL ${mCall.strike} → Premium ~$${mCall.pv}/سهم (~$${mCall.cv}/عقد)
📉 PUT  ${mPut.strike} → Premium ~$${mPut.pv}/سهم (~$${mPut.cv}/عقد)

⚡ <b>خطة التداول:</b>
${isLong
  ? '• الاتجاه صاعد → ترقب CALL عند الافتتاح\n• ادخل بعد تأكيد 9:45-10:00 AM ET'
  : '• الاتجاه هابط → ترقب PUT عند الافتتاح\n• ادخل بعد تأكيد 9:45-10:00 AM ET'
}
• لا تدخل في أول 15 دقيقة من الافتتاح
━━━━━━━━━━━━━━━━━━
⏰ ${nowAr()}
⚠️ <i>تحليل ليلي — أسعار الأوبشن ستتغير عند الافتتاح</i>`);

  log('🌙 تقرير Pre-Market أُرسل');
}

function checkPreMarketReport() {
  const now     = new Date();
  const etH     = ((now.getUTCHours() - 4 + 24) % 24) + now.getUTCMinutes() / 60;
  const day     = now.getUTCDay();
  const dateKey = now.toISOString().slice(0, 10);
  if (day === 0 || day === 6) return;
  if (etH >= 0.25 && etH <= 0.42 && _preMarketReportSent !== dateKey && S.price > 0) {
    _preMarketReportSent = dateKey;
    sendPreMarketReport();
  }
}

// ══════════════════════════════════════════════════════════════════
// جدول التحديث
// ══════════════════════════════════════════════════════════════════
let alertLoop = null;

function getRefreshInterval() {
  const etH = ((new Date().getUTCHours() - 4 + 24) % 24) + new Date().getUTCMinutes() / 60;
  const day = new Date().getUTCDay();
  if (day === 0 || day === 6)          return 10 * 60 * 1000;
  if (etH >= 4    && etH < 9.5)        return  2 * 60 * 1000;
  if (etH >= 9.5  && etH < 16)         return       15 * 1000;
  if (etH >= 16   && etH < 20)         return  2 * 60 * 1000;
  return 10 * 60 * 1000;
}

async function tick() {
  await loadMarketData();
  checkPreMarketReport();
  checkMorningReport();
  await checkTrendChange();
  await checkAlerts();
  const next = getRefreshInterval();
  alertLoop = setTimeout(tick, next);
  log(`⏰ التالي: ${Math.round(next / 1000)}ث`);
}

// ══════════════════════════════════════════════════════════════════
// API Routes
// ══════════════════════════════════════════════════════════════════
app.post('/api/keys', (req, res) => {
  const { finnhub, alphavantage } = req.body || {};
  if (finnhub)      { RUNTIME_KEYS.finnhub      = finnhub;      log('🔑 Finnhub key set'); }
  if (alphavantage) { RUNTIME_KEYS.alphavantage = alphavantage; log('🔑 AV key set');      }
  res.json({ ok: true, hasFinnhub: !!RUNTIME_KEYS.finnhub, hasAV: !!RUNTIME_KEYS.alphavantage });
});

app.get('/api/keys/status', (req, res) => {
  res.json({ hasFinnhub: !!(RUNTIME_KEYS.finnhub || process.env.FINNHUB_KEY), hasAV: !!(RUNTIME_KEYS.alphavantage || process.env.ALPHAVANTAGE_KEY) });
});

app.get('/api/market', async (req, res) => {
  if (S.price === 0) { log('⚡ جلب فوري...'); await loadMarketData(); }
  const sig = computeSig();
  const { isBuy, isSell, bs, ss, bScore = 0, sScore = 0, bPct = 0, sPct = 0, bLabels = [], sLabels = [], conviction = 0 } = sig;
  res.json({
    price: S.price, prev: S.prev, open: S.open, high: S.high, low: S.low,
    vol: S.vol, volR: S.volR, mktState: S.mktState,
    rsi: S.rsi, macd: S.macd, msig: S.msig, mhist: S.mhist,
    sk: S.sk, sd: S.sd, bbU: S.bbU, bbL: S.bbL, bbB: S.bbB,
    atr: S.atr, stV: S.stV, stD: S.stD,
    ema9: S.ema9, ema21: S.ema21, ema50: S.ema50, ema200: S.ema200, vwap: S.vwap,
    obv: S.obv, obvE: S.obvE, fibH: S.fibH, fibL: S.fibL,
    isExt: S.isExt, dataSource: S._lastSource || 'Yahoo',
    history: S.history.slice(-300),
    vix: S.vix, vixPrev: S.vixPrev,
    sig: { isBuy, isSell, bs, ss, bScore, sScore, bPct, sPct, bLabels, sLabels, conviction },
    trade: { active: TRADE.active, type: TRADE.type, entry: TRADE.entry,
      tp1: TRADE.tp1, tp2: TRADE.tp2, tp3: TRADE.tp3, sl: TRADE.sl, trailSl: TRADE.trailSl,
      tp1Hit: TRADE.tp1Hit, tp2Hit: TRADE.tp2Hit, score: TRADE.score },
    weekly: { goalPnl: WEEKLY.goalPnl, maxLoss: WEEKLY.maxLoss, weeklyPnl: WEEKLY.weeklyPnl(), enabled: WEEKLY.enabled },
    ts: Date.now(),
  });
});

app.get('/api/news', async (req, res) => {
  try {
    const news = await fetchAllNews();
    res.json({ ok: true, count: news.length, news, ts: Date.now() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message, news: [] }); }
});

app.get('/api/calendar', async (req, res) => {
  try {
    const FHK = process.env.FINNHUB_KEY || RUNTIME_KEYS.finnhub || '';
    if (!FHK) { res.json({ ok: false, msg: 'FINNHUB_KEY مطلوب', events: [] }); return; }
    const today   = new Date();
    const dateStr = today.toISOString().slice(0, 10);
    const r = await fetch(`https://finnhub.io/api/v1/calendar/economic?from=${dateStr}&to=${dateStr}&token=${FHK}`,
      { signal: AbortSignal.timeout(8000) });
    if (!r.ok) { res.json({ ok: false, msg: 'HTTP ' + r.status, events: [] }); return; }
    const d = await r.json();
    res.json({ ok: true, events: d.economicCalendar || [] });
  } catch (e) { res.json({ ok: false, error: e.message, events: [] }); }
});

app.get('/api/report', (req, res) => {
  res.json({
    summary: getDailyStats(),
    full: getFullReport(),
    stats: {
      total:    STATS.totalTrades,
      wins:     STATS.wins,
      losses:   STATS.losses,
      winRate:  STATS.wins + STATS.losses > 0 ? Math.round(STATS.wins / (STATS.wins + STATS.losses) * 100) : 0,
      totalPnl: Math.round(STATS.totalPnl * 10) / 10,
      byGrade:  STATS.byGrade,
      byHour:   STATS.byHour,
      lossCause: STATS.lossCause,
      recentTrades: STATS.trades.slice(-10),
    },
  });
});

app.get('/api/reset-stats', (req, res) => {
  STATS.wins = 0; STATS.losses = 0; STATS.breakeven = 0;
  STATS.totalPnl = 0; STATS.totalTrades = 0;
  STATS.trades = [];
  Object.keys(STATS.byHour).forEach(k => delete STATS.byHour[k]);
  Object.keys(STATS.byGrade).forEach(k => { STATS.byGrade[k] = { w: 0, l: 0, pnl: 0 }; });
  Object.keys(STATS.lossCause).forEach(k => { STATS.lossCause[k] = 0; });
  res.json({ ok: true, message: 'تم إعادة ضبط الإحصائيات' });
});

app.post('/api/weekly-goals', (req, res) => {
  const { goal, maxLoss } = req.body || {};
  if (goal    && typeof goal    === 'number') WEEKLY.goalPnl = goal;
  if (maxLoss && typeof maxLoss === 'number') WEEKLY.maxLoss = maxLoss;
  log(`⚙️ أهداف أسبوعية: +$${WEEKLY.goalPnl} / -$${Math.abs(WEEKLY.maxLoss)}`);
  res.json({ ok: true, goalPnl: WEEKLY.goalPnl, maxLoss: WEEKLY.maxLoss });
});

app.get('/ping', (req, res) => res.json({ ok: true, price: S.price, ts: Date.now() }));

app.get('/', (req, res) => {
  const fs = require('fs');
  const p1 = path.join(__dirname, 'public', 'index.html');
  const p2 = path.join(__dirname, 'index.html');
  if (fs.existsSync(p1)) res.sendFile(p1);
  else if (fs.existsSync(p2)) res.sendFile(p2);
  else res.status(404).send('index.html مفقود — ضعه في نفس مجلد server.js');
});

app.get('/manifest.json', (req, res) => {
  res.json({
    name: 'NEXUS ULTRA v8', short_name: 'NEXUS v8',
    start_url: '/', display: 'standalone',
    background_color: '#050510', theme_color: '#5a6eff',
    lang: 'ar', dir: 'rtl',
    icons: [{ src: 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect width=%22100%22 height=%22100%22 fill=%22%235a6eff%22/><text y=%22.9em%22 font-size=%2290%22>📈</text></svg>', sizes: '192x192', type: 'image/svg+xml' }],
  });
});

// ══════════════════════════════════════════════════════════════════
// تشغيل السيرفر
// ══════════════════════════════════════════════════════════════════
(async () => {
  log('⏳ تحميل البيانات الأولية...');
  let loaded = await loadMarketData();
  if (!loaded) { await new Promise(r => setTimeout(r, 3000)); loaded = await loadMarketData(); }

  app.listen(PORT, async () => {
    log(`🚀 NEXUS v8 يعمل على المنفذ ${PORT}`);
    if (TG_TOKEN && TG_CHAT) {
      await tg(`🟢 <b>NEXUS v8 انطلق!</b>\n\n✅ السيرفر يعمل\n💹 SPX: <b>${fmt(S.price)}</b>\n🤖 التنبيهات مفعّلة\n📊 ATR: <b>${S.atr.toFixed(1)}</b> نقطة\n${mktLn()}\n⏰ ${nowAr()}`);
    }
    setTimeout(tick, 5000);
  });
})();
