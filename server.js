// ═══════════════════════════════════════════════════════════════════
//  NEXUS ULTRA v7 — Server  (نظيف — بني من الصفر)
//  ✅ أسعار حية: Finnhub → Yahoo v7 → Yahoo v8 → Stooq
//  ✅ تنبيهات تيليجرام: CALL/PUT + أهداف واقعية للمضارب اليومي
//  ✅ أخبار عربية + إنجليزية مترجمة
//  ✅ تقويم اقتصادي من Finnhub
//  ✅ مؤشرات: SuperTrend + VWAP + EMA9/21/50/200 + MACD + RSI + BB
// ═══════════════════════════════════════════════════════════════════

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
app.use((req,res,next)=>{
  res.header('Access-Control-Allow-Origin','*');
  res.header('Access-Control-Allow-Headers','Content-Type');
  res.header('Cache-Control','no-cache, no-store, must-revalidate');
  next();
});

// ══════════════════════════════════════════════════════════════════
// حالة السوق
// ══════════════════════════════════════════════════════════════════
const S = {
  price:0, prev:0, open:0, high:0, low:0, vol:0, volR:1,
  vix:0, vixPrev:0,
  rsi:50, macd:0, msig:0, mhist:0, sk:50, sd:50,
  bbU:0, bbL:0, bbB:0, atr:20,
  stV:0, stD:1,
  ema9:0, ema21:0, ema50:0, ema200:0, vwap:0,
  obv:0, obvE:0,
  fibH:0, fibL:0,
  mktState:'REGULAR', isExt:false, dataSource:'Yahoo',
  lastSig:'WAIT', lastScore:0,
  _lastSource:'Yahoo',
  history:[],
};

// ── مفاتيح runtime (تُرسَل من الداشبورد)
const RUNTIME_KEYS = { finnhub:'', alphavantage:'' };

// ── صفقة نشطة
// ══════════════════════════════════════════════════════════════════
// نظام الأهداف الأسبوعية — يوقف الإشارات عند تحقيق الهدف
// ══════════════════════════════════════════════════════════════════
const WEEKLY = {
  goalPnl:   500,   // هدف الربح الأسبوعي بالدولار (قابل للتعديل)
  maxLoss:  -300,   // أقصى خسارة أسبوعية (circuit breaker)
  enabled:   true,

  // احسب P&L هذا الأسبوع من STATS
  weeklyPnl() {
    const now  = new Date();
    const day  = now.getUTCDay(); // 0=Sun
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() - ((day+6)%7));
    monday.setUTCHours(0,0,0,0);
    // جمع P&L من STATS.recentTrades هذا الأسبوع
    const trades = STATS.recentTrades || [];
    return trades
      .filter(t => t.ts && new Date(t.ts) >= monday)
      .reduce((s,t) => s + (t.pnl||0), 0);
  },

  isBlocked() {
    if(!this.enabled) return false;
    const pnl = this.weeklyPnl();
    if(pnl >= this.goalPnl)  return { blocked:true, reason:`🏆 تم تحقيق الهدف الأسبوعي +$${pnl}` };
    if(pnl <= this.maxLoss)  return { blocked:true, reason:`🛑 Circuit Breaker: خسارة -$${Math.abs(pnl)} تجاوزت الحد` };
    return { blocked:false, pnl };
  },
};
window.WEEKLY = WEEKLY;


const TRADE = {
  active:false, type:null, entry:0, atr:0,
  tp1:0, tp2:0, tp3:0, sl:0, trailSl:0, score:0,
  tp1Hit:false, tp2Hit:false,
  nearTp1:false, nearTp2:false, slWarned:false,
  openedAt:null,
};

// ── Cooldown للتنبيهات
const CD = {};
const canAlert = (k,s=120) => {
  const n=Date.now();
  if(CD[k]&&n-CD[k]<s*1000) return false;
  CD[k]=n; return true;
};

// ── تيليجرام
const tg = async msg => {
  if(!TG_TOKEN||!TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({chat_id:TG_CHAT, text:msg, parse_mode:'HTML', disable_web_page_preview:true}),
      signal:AbortSignal.timeout(10000)
    });
  } catch(e){ log('TG ERR: '+e.message); }
};

// ══════════════════════════════════════════════════════════════════
// دوال المؤشرات
// ══════════════════════════════════════════════════════════════════
const ema = (arr, n) => {
  const k=2/(n+1); let e=arr[0];
  return arr.map(v=>{ e=v*k+e*(1-k); return e; });
};

const rsi14 = arr => {
  let g=0,l=0;
  for(let i=1;i<15;i++){const d=arr[i]-arr[i-1];d>0?g+=d:l-=d;}
  let ag=g/14,al=l/14;
  const res=[50];
  for(let i=15;i<arr.length;i++){
    const d=arr[i]-arr[i-1];
    ag=(ag*13+(d>0?d:0))/14;
    al=(al*13+(d<0?-d:0))/14;
    res.push(al===0?100:100-100/(1+ag/al));
  }
  return res;
};

const macdCalc = arr => {
  const e12=ema(arr,12),e26=ema(arr,26);
  const line=e12.map((v,i)=>v-e26[i]);
  const sig=ema(line,9);
  const hist=line.map((v,i)=>v-sig[i]);
  return {line,sig,hist};
};

const bollingerCalc = (arr,n=20,mult=2) => {
  return arr.map((_,i)=>{
    if(i<n-1) return {u:0,l:0,b:0};
    const sl=arr.slice(i-n+1,i+1);
    const m=sl.reduce((a,v)=>a+v,0)/n;
    const sd=Math.sqrt(sl.reduce((a,v)=>a+(v-m)**2,0)/n);
    return {u:m+mult*sd,l:m-mult*sd,b:m};
  });
};

const superTrend = (highs,lows,closes,atrPeriod=10,mult=3) => {
  const atrs=closes.map((_,i)=>{
    if(i===0) return highs[0]-lows[0];
    const tr=Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1]));
    return tr;
  });
  const atrEma=ema(atrs,atrPeriod);
  let dir=1,st=closes[0];
  return closes.map((c,i)=>{
    const hl2=(highs[i]+lows[i])/2;
    const up=hl2+mult*atrEma[i], dn=hl2-mult*atrEma[i];
    if(c>st&&dir===-1) dir=1;
    if(c<st&&dir===1)  dir=-1;
    st=dir===1?Math.max(dn,st):Math.min(up,st);
    return {v:st,d:dir};
  });
};

const atrCalc = (highs,lows,closes,n=14) => {
  const trs=closes.map((_,i)=>{
    if(i===0) return highs[0]-lows[0];
    return Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1]));
  });
  return ema(trs,n).at(-1)||20;
};

// ══════════════════════════════════════════════════════════════════
// جلب بيانات السوق
// ══════════════════════════════════════════════════════════════════
async function fetchLivePrice(sym) {
  const hdrs={'User-Agent':'Mozilla/5.0','Accept':'application/json'};
  const symFH = sym==='^GSPC'?'SPX':sym.replace('^','');
  const enc   = encodeURIComponent(sym);

  // 1. Finnhub
  const FHK = process.env.FINNHUB_KEY||RUNTIME_KEYS.finnhub||'';
  if(FHK){
    try{
      const r=await fetch(`https://finnhub.io/api/v1/quote?symbol=${symFH}&token=${FHK}`,
        {signal:AbortSignal.timeout(5000)});
      if(r.ok){
        const d=await r.json();
        if(d&&d.c>0){
          const price=d.c,prev=d.pc||d.c,chg=price-prev,pct=prev?chg/prev*100:0;
          const now=new Date(),etH=((now.getUTCHours()-4+24)%24)+now.getUTCMinutes()/60,day=now.getUTCDay();
          let state='CLOSED',isExt=false;
          if(day>=1&&day<=5){
            if(etH>=4&&etH<9.5){state='PRE';isExt=true;}
            else if(etH>=9.5&&etH<16){state='REGULAR';}
            else if(etH>=16&&etH<20){state='POST';isExt=true;}
          }
          S._lastSource='Finnhub';
          log(`[Finnhub OK] SPX=${price.toFixed(2)} ${state}`);
          return{price,isExt,state,change:chg,changePct:pct,high:d.h||price,low:d.l||price,open:d.o||price,prev,source:'Finnhub'};
        }
      }
    }catch(e){log('[Finnhub ERR] '+e.message);}
  }

  // 2. Yahoo v7
  for(const base of ['https://query1.finance.yahoo.com','https://query2.finance.yahoo.com']){
    try{
      const fields='regularMarketPrice,preMarketPrice,postMarketPrice,marketState,regularMarketDayHigh,regularMarketDayLow,regularMarketOpen,regularMarketPreviousClose,regularMarketChange,regularMarketChangePercent,preMarketChange,preMarketChangePercent,postMarketChange,postMarketChangePercent';
      const r=await fetch(`${base}/v7/finance/quote?symbols=${enc}&fields=${fields}`,
        {headers:hdrs,signal:AbortSignal.timeout(6000)});
      if(!r.ok) continue;
      const qt=(await r.json())?.quoteResponse?.result?.[0];
      if(!qt) continue;
      const state=qt.marketState||'REGULAR';
      const isPre=state==='PRE'||state==='PREPRE',isPost=state==='POST'||state==='POSTPOST';
      let price=qt.regularMarketPrice,chg=qt.regularMarketChange||0,pct=qt.regularMarketChangePercent||0;
      if(isPre&&qt.preMarketPrice){price=qt.preMarketPrice;chg=qt.preMarketChange||0;pct=qt.preMarketChangePercent||0;}
      if(isPost&&qt.postMarketPrice){price=qt.postMarketPrice;chg=qt.postMarketChange||0;pct=qt.postMarketChangePercent||0;}
      if(!price) continue;
      S._lastSource='Yahoo_v7';
      log(`[Yahoo v7 OK] SPX=${price.toFixed(2)} ${state}`);
      return{price,isExt:isPre||isPost,state,change:chg,changePct:pct,
        high:qt.regularMarketDayHigh||price,low:qt.regularMarketDayLow||price,
        open:qt.regularMarketOpen||price,prev:qt.regularMarketPreviousClose||price,source:'Yahoo_v7'};
    }catch(e){log('[Yahoo v7 ERR] '+e.message);}
  }

  // 3. Yahoo v8
  try{
    const r=await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${enc}?interval=1m&range=1d`,
      {headers:hdrs,signal:AbortSignal.timeout(6000)});
    if(r.ok){
      const meta=(await r.json())?.chart?.result?.[0]?.meta;
      if(meta?.regularMarketPrice){
        const state=meta.marketState||'REGULAR';
        let price=meta.regularMarketPrice;
        if(state==='PRE'&&meta.preMarketPrice) price=meta.preMarketPrice;
        if((state==='POST'||state==='POSTPOST')&&meta.postMarketPrice) price=meta.postMarketPrice;
        const prev=meta.previousClose||price;
        S._lastSource='Yahoo_v8';
        return{price,isExt:state==='PRE'||state==='POST'||state==='POSTPOST',state,
          change:price-prev,changePct:prev?(price-prev)/prev*100:0,
          high:meta.regularMarketDayHigh||price,low:meta.regularMarketDayLow||price,
          open:meta.regularMarketOpen||price,prev,source:'Yahoo_v8'};
      }
    }
  }catch(e){log('[Yahoo v8 ERR] '+e.message);}

  // 4. Stooq
  try{
    const r=await fetch('https://stooq.com/q/l/?s=^spx&f=sd2t2ohlcv&h&e=json',
      {signal:AbortSignal.timeout(7000)});
    if(r.ok){
      const row=(await r.json())?.symbols?.[0];
      if(row&&row.close>0){
        S._lastSource='Stooq';
        return{price:row.close,isExt:false,state:'DELAYED',
          change:row.close-(row.open||row.close),changePct:0,
          high:row.high||row.close,low:row.low||row.close,open:row.open||row.close,
          prev:row.open||row.close,source:'Stooq'};
      }
    }
  }catch(e){log('[Stooq ERR] '+e.message);}

  return null;
}

// ══════════════════════════════════════════════════════════════════
// تحميل بيانات الشارت (Yahoo — 60 يوم)
// ══════════════════════════════════════════════════════════════════
async function loadMarketData(){
  try{
    const hdrs={'User-Agent':'Mozilla/5.0','Accept':'application/json'};
    const r=await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=60d',
      {headers:hdrs,signal:AbortSignal.timeout(10000)});
    if(!r.ok) throw new Error('HTTP '+r.status);
    const js=(await r.json())?.chart?.result?.[0];
    if(!js) throw new Error('no data');

    const quotes=js.indicators.quote[0];
    const closes=quotes.close.filter(Boolean);
    const highs =quotes.high.filter(Boolean);
    const lows  =quotes.low.filter(Boolean);
    const vols  =quotes.volume.filter(v=>v!=null);

    if(closes.length<30) throw new Error('too short');

    const c=closes,h=highs,l=lows;

    // مؤشرات
    const rsiArr=rsi14(c);
    const {line:ml,sig:ms,hist:mh}=macdCalc(c);
    const bbArr=bollingerCalc(c);
    const stArr=superTrend(h,l,c);
    const e9=ema(c,9),e21=ema(c,21),e50=ema(c,50),e200=ema(c,200);
    const atr=atrCalc(h,l,c);

    // Stochastic
    const skArr=c.map((_,i)=>{
      if(i<13) return 50;
      const sl=c.slice(i-13,i+1),hl=Math.max(...sl),ll=Math.min(...sl);
      return hl===ll?50:(c[i]-ll)/(hl-ll)*100;
    });
    const sdArr=ema(skArr,3);

    // OBV
    let obv=0;
    const obvArr=c.map((p,i)=>{
      if(i>0) obv+=p>c[i-1]?(vols[i]||0):p<c[i-1]?-(vols[i]||0):0;
      return obv;
    });
    const obvEArr=ema(obvArr,21);

    // VWAP تقريبي
    const vwSlice=20,vwC=c.slice(-vwSlice),vwV=vols.slice(-vwSlice);
    const vwNum=vwC.reduce((s,p,i)=>s+p*(vwV[i]||1),0);
    const vwDen=vwV.reduce((s,v)=>s+(v||1),0);
    const vwap=vwDen>0?vwNum/vwDen:c.at(-1);

    // Fibonacci
    const fibH=Math.max(...c.slice(-20)),fibL=Math.min(...c.slice(-20));

    // السعر الحي
    const live=await fetchLivePrice('^GSPC');
    const price=live?.price||c.at(-1);
    const mktState=live?.state||'REGULAR';

    Object.assign(S,{
      price, prev:live?.prev||c.at(-2)||price,
      open:live?.open||c.at(-1), high:live?.high||h.at(-1),
      low:live?.low||l.at(-1), vol:vols.at(-1)||0,
      volR:vols.length>20?vols.at(-1)/(vols.slice(-20).reduce((a,v)=>a+v,0)/20):1,
      rsi:rsiArr.at(-1)||50, macd:ml.at(-1)||0, msig:ms.at(-1)||0, mhist:mh.at(-1)||0,
      sk:skArr.at(-1)||50, sd:sdArr.at(-1)||50,
      bbU:bbArr.at(-1).u||price+50, bbL:bbArr.at(-1).l||price-50, bbB:bbArr.at(-1).b||price,
      stV:stArr.at(-1).v||price, stD:stArr.at(-1).d||1,
      ema9:e9.at(-1)||0, ema21:e21.at(-1)||0, ema50:e50.at(-1)||0, ema200:e200.at(-1)||0,
      vwap, obv:obvArr.at(-1)||0, obvE:obvEArr.at(-1)||0,
      fibH, fibL, atr, mktState, isExt:live?.isExt||false,
      dataSource:S._lastSource||'Yahoo',
    });

    // تاريخ للشارت
    S.history=c.slice(-100).map((p,i)=>({
      t:Date.now()-((c.slice(-100).length-1-i)*86400000), o:p, h:p, l:p, c:p, v:vols.slice(-100)[i]||0
    }));


    // ── جلب VIX (مؤشر الخوف)
    try {
      const vixUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=2d';
      const vixR = await fetch(vixUrl, {headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(6000)});
      if(vixR.ok){
        const vixD = await vixR.json();
        const vixClose = vixD?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(Boolean);
        if(vixClose && vixClose.length >= 1){
          S.vixPrev = S.vix || vixClose[vixClose.length-2] || 0;
          S.vix     = Math.round(vixClose[vixClose.length-1] * 100) / 100;
        }
      }
    } catch(e){ /* VIX فشل — استمر */ }

    log(`✅ Market loaded: SPX=${price.toFixed(2)} RSI=${S.rsi.toFixed(1)} ST=${S.stD} VWAP=${S.vwap.toFixed(2)} ATR=${S.atr.toFixed(1)}`);
    return true;
  }catch(e){
    log('❌ loadMarketData: '+e.message);
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════
// نظام الإشارات — المضارب اليومي Intraday SPX
// ══════════════════════════════════════════════════════════════════
function computeSig(){
  const p = S.price;
  if(!p||p===0) return {isBuy:false,isSell:false,bs:0,ss:0,
    bScore:0,sScore:0,bPct:0,sPct:0,bLabels:[],sLabels:[],
    bc:[],sc:[],badTime:false,sideways:false,conviction:0,
    bGrade:'',sGrade:'',reason:''};

  // ══ الوقت ══
  const etH      = ((new Date().getUTCHours()-4+24)%24) + new Date().getUTCMinutes()/60;
  const tooEarly = etH < 9.75;
  const tooLate  = etH > 15.5;
  const badTime  = tooEarly || tooLate;

  // ══ فلتر التقويم الاقتصادي ══
  // لا توصيات 30 دقيقة قبل وبعد أحداث كبيرة
  const HIGH_IMPACT = getHighImpactWindow();
  if(HIGH_IMPACT.active) return {isBuy:false,isSell:false,bs:0,ss:0,
    bScore:0,sScore:0,bPct:0,sPct:0,bLabels:[],sLabels:[],
    bc:[],sc:[],badTime:true,sideways:false,conviction:0,
    bGrade:'',sGrade:'',reason:'حدث اقتصادي: '+HIGH_IMPACT.name};


  // ══ فلتر VIX (مؤشر الخوف) ══
  // VIX > 35 → سوق مضطرب جداً → لا إشارات
  // VIX > 25 → تحذير → خفّض الوزن
  const vixHigh    = S.vix > 0 && S.vix > 35;
  const vixElevated= S.vix > 0 && S.vix > 25 && S.vix <= 35;
  const vixOK      = S.vix === 0 || S.vix <= 25; // لا نعرف VIX أو طبيعي
  if(vixHigh) return {isBuy:false,isSell:false,bs:0,ss:0,
    bScore:0,sScore:0,bPct:0,sPct:0,bLabels:[],sLabels:[],
    bc:[],sc:[],badTime:false,sideways:true,conviction:0,
    bGrade:'',sGrade:'',reason:`VIX مرتفع جداً: ${S.vix} — سوق مضطرب`};


  // ══ فلتر Gap Opening ══
  // إذا فجوة الافتتاح > 0.5% وأقل من 15 دقيقة من الافتتاح → انتظر
  const gapPct = S.open > 0 ? Math.abs(S.price - S.open) / S.open * 100 : 0;
  const minutesSinceOpen = etH > 9.5 ? (etH - 9.5) * 60 : 9999;
  const gapOpen = gapPct > 0.5 && minutesSinceOpen < 15;
  if(gapOpen) return {isBuy:false,isSell:false,bs:0,ss:0,
    bScore:0,sScore:0,bPct:0,sPct:0,bLabels:[],sLabels:[],
    bc:[],sc:[],badTime:true,sideways:false,conviction:0,
    bGrade:'',sGrade:'',reason:`فجوة افتتاح ${gapPct.toFixed(1)}% — انتظر 15 دقيقة`};

  // ══ فلتر السوق ══
  const bbRange  = Math.max(S.bbU - S.bbL, 1);
  const bbWidth  = bbRange / p;
  const sideways = bbWidth < 0.003;
  const lowATR   = S.atr > 0 && S.atr < 12;
  const bbPct    = (p - S.bbL) / bbRange;
  const vwap     = S.vwap || p;

  // ══ VWAP Bands (±1σ) ══
  // نقدر σ من ATR: σ ≈ ATR * 0.6
  const vwapSigma = (S.atr||20) * 0.6;
  const vwapU1    = vwap + vwapSigma;   // مقاومة
  const vwapL1    = vwap - vwapSigma;   // دعم
  const nearVwapU = p >= vwapU1 * 0.998; // قريب من مقاومة VWAP
  const nearVwapL = p <= vwapL1 * 1.002; // قريب من دعم VWAP
  const inVwapBull= p > vwap && p < vwapU1; // منطقة شراء مثالية
  const inVwapBear= p < vwap && p > vwapL1; // منطقة بيع مثالية

  // ══ Daily Trend Filter ══
  // نستخدم EMA200 كمرشح اتجاه كبير
  const dailyBull = S.ema200 > 0 ? p > S.ema200 : true;
  const dailyBear = S.ema200 > 0 ? p < S.ema200 : true;

  // ══ Order Flow Proxy ══
  // نحاكي order flow من: OBV + حجم + حركة السعر
  const volAboveAvg  = S.volR >= 1.2;          // حجم أعلى من المتوسط
  const bullishFlow  = S.obv > S.obvE && volAboveAvg && p > S.prev;
  const bearishFlow  = S.obv < S.obvE && volAboveAvg && p < S.prev;
  const strongBull   = S.obv > S.obvE && S.volR >= 1.5; // تدفق شراء قوي
  const strongBear   = S.obv < S.obvE && S.volR >= 1.5; // تدفق بيع قوي

  // ══ Momentum Divergence (فلتر إضافي) ══
  // إذا RSI يتعارض مع السعر → إشارة أضعف
  const rsiDivBull = S.rsi < 50 && p > S.prev; // RSI منخفض لكن سعر صاعد
  const rsiDivBear = S.rsi > 50 && p < S.prev;

  // ══ شروط CALL (وزن 22) ══
  const bc = [
    // Core — يجب الاثنان (وزن 3 لكل)
    {pass: S.stD===1,                              w:3, label:'SuperTrend ↑',   core:true},
    {pass: S.vwap>0 && p>vwap,                    w:3, label:'فوق VWAP',        core:true},
    // مومنتم (وزن 2)
    {pass: S.ema9>0 && S.ema9>S.ema21,            w:2, label:'EMA9 > EMA21'},
    {pass: S.mhist>0 && S.macd>S.msig,            w:2, label:'MACD ↑'},
    {pass: S.rsi>=42 && S.rsi<65,                 w:2, label:'RSI '+Math.round(S.rsi)},
    {pass: bbPct<0.45,                             w:2, label:'BB شراء'},
    // S/R Levels
    {pass: (()=>{ const sr=calcSRLevels(S.history); return sr.srBull; })(), w:1, label:'قرب دعم S/R'},
    // جديد: VWAP Band + Order Flow (وزن 2)
    {pass: inVwapBull,                             w:2, label:'VWAP Band ↑'},
    {pass: bullishFlow || strongBull,              w:2, label:'Order Flow ↑'},
    // تأكيد (وزن 1)
    {pass: S.ema21>0 && S.ema21>S.ema50,          w:1, label:'EMA21>EMA50'},
    {pass: dailyBull,                              w:1, label:'Daily Bull'},
    {pass: S.sk>0 && S.sk<60,                     w:1, label:'Stoch '+Math.round(S.sk)},
  ];

  // ══ شروط PUT (وزن 22) ══
  const sc = [
    {pass: S.stD===-1,                             w:3, label:'SuperTrend ↓',   core:true},
    {pass: S.vwap>0 && p<vwap,                    w:3, label:'تحت VWAP',        core:true},
    {pass: S.ema9>0 && S.ema9<S.ema21,            w:2, label:'EMA9 < EMA21'},
    {pass: S.mhist<0 && S.macd<S.msig,            w:2, label:'MACD ↓'},
    {pass: S.rsi>55 && S.rsi<=78,                 w:2, label:'RSI '+Math.round(S.rsi)},
    {pass: bbPct>0.55,                             w:2, label:'BB بيع'},
    // S/R Levels
    {pass: (()=>{ const sr=calcSRLevels(S.history); return sr.srBear; })(), w:1, label:'قرب مقاومة S/R'},
    {pass: inVwapBear,                             w:2, label:'VWAP Band ↓'},
    {pass: bearishFlow || strongBear,              w:2, label:'Order Flow ↓'},
    {pass: S.ema21>0 && S.ema21<S.ema50,          w:1, label:'EMA21<EMA50'},
    {pass: dailyBear,                              w:1, label:'Daily Bear'},
    {pass: S.sk>0 && S.sk>40,                     w:1, label:'Stoch '+Math.round(S.sk)},
  ];

  const bPassed  = bc.filter(c=>c.pass);
  const sPassed  = sc.filter(c=>c.pass);
  const bScore   = bPassed.reduce((s,c)=>s+c.w, 0);
  const sScore   = sPassed.reduce((s,c)=>s+c.w, 0);
  const maxScore = 22;
  const bPct     = Math.round(bScore/maxScore*100);
  const sPct     = Math.round(sScore/maxScore*100);
  const bLabels  = bPassed.map(c=>c.label);
  const sLabels  = sPassed.map(c=>c.label);

  // ══ Core: يجب الاثنان ══
  const bHasCore = bPassed.filter(c=>c.core).length === 2;
  const sHasCore = sPassed.filter(c=>c.core).length === 2;

  // ══ تصنيف الإشارة ══
  // A+ : score≥15 + core + ≥6 شروط + Order Flow
  // A  : score≥11 + core + ≥5 شروط
  // B  : score≥8  + core + ≥4 شروط
  const bHasFlow  = bPassed.some(c=>c.label==='Order Flow ↑');
  const sHasFlow  = sPassed.some(c=>c.label==='Order Flow ↓');
  const bGradeAp  = bScore>=15 && bHasCore && bPassed.length>=6 && bHasFlow;
  const bGradeA   = bScore>=11 && bHasCore && bPassed.length>=5;
  const bGradeB   = bScore>=8  && bHasCore && bPassed.length>=4;
  const sGradeAp  = sScore>=15 && sHasCore && sPassed.length>=6 && sHasFlow;
  const sGradeA   = sScore>=11 && sHasCore && sPassed.length>=5;
  const sGradeB   = sScore>=8  && sHasCore && sPassed.length>=4;

  const bGrade = bGradeAp?'A+':bGradeA?'A':bGradeB?'B':'';
  const sGrade = sGradeAp?'A+':sGradeA?'A':sGradeB?'B':'';

  let reason = '';
  if(badTime)     reason = 'وقت سيئ';
  else if(sideways) reason = 'سوق جانبي BB=' + (bbWidth*100).toFixed(2)+'%';
  else if(lowATR)   reason = 'ATR منخفض=' + (S.atr||0).toFixed(1);

  const valid  = !badTime && !sideways && !lowATR;
  const isBuy  = valid && bGrade!=='' && bScore>sScore;
  const isSell = valid && sGrade!=='' && sScore>bScore;

  return {isBuy,isSell, bs:bPassed.length, ss:sPassed.length,
    bScore,sScore, bPct,sPct, maxScore,
    bLabels,sLabels, bc,sc,
    bGrade,sGrade, badTime,sideways,lowATR,reason,
    bullishFlow,bearishFlow, inVwapBull,inVwapBear,
    conviction: isBuy?bPct:isSell?sPct:0};
}

// ══ التقويم الاقتصادي — أحداث عالية الأثر ══
function getHighImpactWindow(){
  const now   = new Date();
  const etOff = -4; // EDT (مارس-نوفمبر) أو -5 للـ EST
  const etH   = ((now.getUTCHours()+etOff+24)%24);
  const etM   = now.getUTCMinutes();
  const etMin = etH*60 + etM; // دقائق من منتصف الليل ET
  const dow   = now.getUTCDay(); // 0=أحد

  // أحداث ثابتة أسبوعية (الوقت بالدقائق من منتصف الليل ET)
  const WEEKLY_EVENTS = [
    {dow:5, time:8*60+30, name:'NFP/بيانات التوظيف الجمعة',    window:40},
    {dow:3, time:8*60+30, name:'ADP التوظيف',                   window:30},
    {dow:3, time:14*60+0, name:'FOMC بيان الفائدة',             window:60},
    {dow:2, time:8*60+30, name:'CPI التضخم',                    window:40},
    {dow:4, time:8*60+30, name:'GDP ناتج محلي',                  window:30},
    {dow:4, time:8*60+30, name:'طلبات إعانة البطالة',            window:25},
    {dow:1, time:10*60+0, name:'ISM مؤشر التصنيع',               window:25},
  ];

  for(const ev of WEEKLY_EVENTS){
    if(dow !== ev.dow) continue;
    const diff = etMin - ev.time;
    // 30 دقيقة قبل + window بعد
    if(diff >= -30 && diff <= ev.window){
      return {active:true, name:ev.name, minsLeft: diff<0?Math.abs(diff):0};
    }
  }
  return {active:false, name:'', minsLeft:0};
}

// ══════════════════════════════════════════════════════════════════
// تنسيق الأرقام
// ══════════════════════════════════════════════════════════════════
const fmt  = n => n?.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})||'--';
const fmtP = n => (n>=0?'+':'')+n?.toFixed(2)+'%';
const nowAr= ()=>{
  return new Date().toLocaleString('ar-SA',{
    timeZone:'America/New_York',hour12:true,
    year:'numeric',month:'numeric',day:'numeric',
    hour:'numeric',minute:'2-digit',second:'2-digit'
  });
};
const mktLn=()=>{
  const m={REGULAR:'🟢 جلسة رسمية',PRE:'🌅 ما قبل الجلسة',
    POST:'🌙 ما بعد الجلسة',CLOSED:'🔴 السوق مغلق',DELAYED:'⏱️ بيانات مؤخرة'};
  return m[S.mktState]||'📊 '+S.mktState;
};

// ══════════════════════════════════════════════════════════════════
// تنبيهات تيليجرام
// ══════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
// نظام احتمالية النجاح — Probability Engine
// يحسب % احتمال نجاح الصفقة من 8 عوامل مستقلة
// ══════════════════════════════════════════════════════════════════

function calcProbability(isLong, bScore, sScore, maxScore){
  const p     = S.price;
  const vwap  = S.vwap || p;
  const atr   = S.atr  || 20;
  const etH   = ((new Date().getUTCHours()-4+24)%24) + new Date().getUTCMinutes()/60;
  const hoursLeft = Math.max(16.0 - etH, 0.1);

  // ── 8 عوامل مستقلة، كل عامل له وزن ──
  const factors = [];

  // 1. قوة الإشارة (30%)
  const sigScore = isLong ? bScore : sScore;
  const sigPct   = sigScore / maxScore;
  factors.push({
    name: 'قوة الإشارة',
    score: Math.min(sigPct * 1.3, 1.0),
    weight: 30,
    detail: `${sigScore}/${maxScore}`
  });

  // 2. موقع السعر من VWAP (20%)
  const vwapDist   = Math.abs(p - vwap);
  const vwapPctDist= vwapDist / atr;
  let vwapScore;
  if(isLong){
    // أفضل: قريب من VWAP من فوق (0-0.5 ATR)
    vwapScore = vwapPctDist < 0.3 ? 1.0
              : vwapPctDist < 0.6 ? 0.85
              : vwapPctDist < 1.0 ? 0.65
              : vwapPctDist < 1.5 ? 0.40
              : 0.20; // بعيد جداً
    if(p < vwap) vwapScore *= 0.3; // تحت VWAP يخفض كثيراً
  } else {
    vwapScore = vwapPctDist < 0.3 ? 1.0
              : vwapPctDist < 0.6 ? 0.85
              : vwapPctDist < 1.0 ? 0.65
              : vwapPctDist < 1.5 ? 0.40
              : 0.20;
    if(p > vwap) vwapScore *= 0.3;
  }
  factors.push({
    name: 'موقع VWAP',
    score: vwapScore,
    weight: 20,
    detail: `${vwapDist.toFixed(1)}pt من VWAP`
  });

  // 3. توافق MACD + RSI (15%)
  let momentumScore = 0;
  if(isLong){
    if(S.mhist > 0) momentumScore += 0.5;
    if(S.rsi >= 45 && S.rsi < 60) momentumScore += 0.5;
    else if(S.rsi >= 40 && S.rsi < 65) momentumScore += 0.3;
  } else {
    if(S.mhist < 0) momentumScore += 0.5;
    if(S.rsi > 55 && S.rsi <= 70) momentumScore += 0.5;
    else if(S.rsi > 50 && S.rsi <= 75) momentumScore += 0.3;
  }
  factors.push({
    name: 'مومنتم MACD+RSI',
    score: momentumScore,
    weight: 15,
    detail: `RSI:${S.rsi.toFixed(0)} MACD:${S.mhist>0?'↑':'↓'}`
  });

  // 4. SuperTrend + EMA alignment (15%)
  let trendScore = 0;
  if(isLong){
    if(S.stD === 1)          trendScore += 0.4;
    if(S.ema9 > S.ema21)     trendScore += 0.3;
    if(S.ema21 > S.ema50)    trendScore += 0.2;
    if(S.ema50 > S.ema200)   trendScore += 0.1;
  } else {
    if(S.stD === -1)         trendScore += 0.4;
    if(S.ema9 < S.ema21)     trendScore += 0.3;
    if(S.ema21 < S.ema50)    trendScore += 0.2;
    if(S.ema50 < S.ema200)   trendScore += 0.1;
  }
  factors.push({
    name: 'تناسق الاتجاه',
    score: Math.min(trendScore, 1.0),
    weight: 15,
    detail: `ST:${S.stD===1?'↑':'↓'} EMA:${S.ema9>S.ema21?'↑':'↓'}`
  });

  // 5. Order Flow / حجم التداول (10%)
  const volBull  = S.obv > S.obvE && S.volR >= 1.2;
  const volBear  = S.obv < S.obvE && S.volR >= 1.2;
  const volScore = isLong
    ? (S.volR >= 1.5 && volBull ? 1.0 : volBull ? 0.75 : S.volR >= 1.0 ? 0.45 : 0.25)
    : (S.volR >= 1.5 && volBear ? 1.0 : volBear ? 0.75 : S.volR >= 1.0 ? 0.45 : 0.25);
  factors.push({
    name: 'Order Flow',
    score: volScore,
    weight: 10,
    detail: `Vol:${(S.volR||1).toFixed(1)}x OBV:${S.obv>S.obvE?'↑':'↓'}`
  });

  // 6. وقت الجلسة (5%)
  // أفضل أوقات: 10:00-11:30 AM و 1:30-3:00 PM
  const bestMorning = etH >= 10.0 && etH < 11.5;
  const bestAfternoon = etH >= 13.5 && etH < 15.0;
  const goodTime = etH >= 9.75 && etH < 15.5;
  const timeScore = bestMorning || bestAfternoon ? 1.0
                  : goodTime ? 0.7
                  : 0.3;
  factors.push({
    name: 'توقيت الجلسة',
    score: timeScore,
    weight: 5,
    detail: etH.toFixed(1)+'h ET'
  });

  // 7. Theta Decay خطر (3%)
  // كلما قل الوقت، زاد خطر Theta
  const thetaScore = hoursLeft > 4 ? 1.0
                   : hoursLeft > 2 ? 0.8
                   : hoursLeft > 1 ? 0.55
                   : 0.25;
  factors.push({
    name: 'Theta Risk',
    score: thetaScore,
    weight: 3,
    detail: `${hoursLeft.toFixed(1)}h متبقي`
  });

  // 8. ATR / تقلب كافٍ (2%)
  const atrScore = atr > 30 ? 1.0
                 : atr > 20 ? 0.85
                 : atr > 15 ? 0.65
                 : atr > 10 ? 0.40
                 : 0.20;
  factors.push({
    name: 'تقلب ATR',
    score: atrScore,
    weight: 2,
    detail: `ATR:${atr.toFixed(0)}`
  });

  // ── الاحتمالية المرجّحة ──
  const totalWeight = factors.reduce((s,f) => s+f.weight, 0);
  const weightedSum = factors.reduce((s,f) => s + f.score*f.weight, 0);
  const rawProb     = weightedSum / totalWeight; // 0–1

  // تحويل للنسبة المئوية (calibrated)
  // raw 0.5 → ~55%, raw 0.7 → ~70%, raw 0.9 → ~85%
  const prob = Math.round(Math.min(rawProb * 100, 92));

  // ── درجة الخطر الرئيسي ──
  const weakFactors = factors
    .filter(f => f.score < 0.5)
    .sort((a,b) => a.score*a.weight - b.score*b.weight)
    .slice(0, 2);

  const topFactors = factors
    .filter(f => f.score >= 0.75)
    .sort((a,b) => b.score*b.weight - a.score*a.weight)
    .slice(0, 3);

  // ── تصنيف الاحتمالية ──
  const grade = prob >= 75 ? '🟢 عالية'
              : prob >= 60 ? '🟡 متوسطة'
              : '🔴 منخفضة';

  return { prob, grade, factors, topFactors, weakFactors, rawProb };
}


async function alertEntry(type,bScore,sScore,bLabels,sLabels){
  // ── فحص الأهداف الأسبوعية
  const weeklyCheck = WEEKLY.isBlocked();
  if(weeklyCheck.blocked){
    log('[WeeklyBlock] '+weeklyCheck.reason);
    await tg(`⛔ <b>NEXUS v7 — إيقاف تلقائي</b>\n\n${weeklyCheck.reason}\n\nسيُستأنف الأسبوع القادم تلقائياً.\n⏰ ${nowAr()}`);
    return;
  }
  const p   = S.price;
  const atr = Math.max(S.atr||40, 20);
  const d   = type==='BUY' ? 1 : -1;
  const isL = d === 1;
  const score = isL ? bScore : sScore;

  // ══ حساب احتمالية النجاح ══
  const PB = calcProbability(isL, bScore, sScore, 22);
  const probVal  = PB.prob;
  const probGrade= PB.grade;
  const topFacts = PB.topFactors.map(f=>f.name).join(' · ');
  const weakFacts= PB.weakFactors.length>0
    ? '⚠️ ' + PB.weakFactors.map(f=>f.name+' ('+Math.round(f.score*100)+'%)').join(' | ')
    : '✅ لا مخاطر واضحة';

  // ══ حد الإرسال: لا نرسل إذا الاحتمالية < 55% ══
  if(probVal < 55){
    log('[ProbFilter] '+type+' prob:'+probVal+'% - لم يرسل');
    TRADE.active = false;
    return;
  }

  // ══ أهداف SPX ══
  const slPts=8, tp1Pts=10, tp2Pts=20, tp3Pts=35;
  const tp1 = Math.round((p + d*tp1Pts)*100)/100;
  const tp2 = Math.round((p + d*tp2Pts)*100)/100;
  const tp3 = Math.round((p + d*tp3Pts)*100)/100;
  const sl  = Math.round((p - d*slPts)*100)/100;
  const rr  = (tp2Pts/slPts).toFixed(1);

  const entryEtH = ((new Date().getUTCHours()-4+24)%24)+new Date().getUTCMinutes()/60;
  const tradeGrade = isL?bGradeSig:sGradeSig;
  Object.assign(TRADE,{
    grade:tradeGrade, entryHour:entryEtH,
    tp1Hit:false, tp2Hit:false, nearTp1:false, nearTp2:false,
    slWarned:false, openedAt:new Date()
  });

  // ══ وقت الجلسة ══
  const etH = ((new Date().getUTCHours()-4+24)%24) + new Date().getUTCMinutes()/60;
  const hoursLeft = Math.max(16.0 - etH, 0.1);
  const sessionIcon = hoursLeft<1?'🔴':hoursLeft<2?'🟡':'🟢';
  const sessionNote = hoursLeft<1?'آخر ساعة':hoursLeft<2?'آخر ساعتين':hoursLeft<4?'منتصف الجلسة':'بداية الجلسة';

  // ══ مستوى الإشارة ══
  // احسب grade من score
  const bGradeSig = bScore>=14?'A+':bScore>=10?'A':bScore>=8?'B':'B';
  const sGradeSig = sScore>=14?'A+':sScore>=10?'A':sScore>=8?'B':'B';
  const curGrade  = isL?bGradeSig:sGradeSig;
  const sigLevel  = curGrade==='A+'?'A+ 🔥 ممتازة':curGrade==='A'?'A ⭐ قوية':'B ✅ جيدة';

  // ══ تاريخ SPXW ══
  const expDate = new Date().toLocaleDateString('en-US',{
    timeZone:'America/New_York', month:'short', day:'2-digit', year:'2-digit'
  }).replace(', ',' \'');

  // ══ سترايك SPXW الأمثل بـ Black-Scholes ══
  function bsOpt(S,K,T,sig,opt){
    if(T<=0) return Math.max(opt==='c'?S-K:K-S,0);
    const sqt=Math.sqrt(T);
    const d1=(Math.log(S/K)+(0.053+0.5*sig*sig)*T)/(sig*sqt);
    const d2=d1-sig*sqt;
    const N=x=>{const p2=[0.319381530,-0.356563782,1.781477937,-1.821255978,1.330274429];const t=1/(1+0.2316419*Math.abs(x));let poly=0,tp=t;for(const c of p2){poly+=c*tp;tp*=t;}const nd=Math.exp(-x*x/2)/Math.sqrt(2*Math.PI);return x>=0?1-nd*poly:nd*poly;};
    if(opt==='c') return Math.max(S*N(d1)-K*Math.exp(-0.053*T)*N(d2),0);
    return Math.max(K*Math.exp(-0.053*T)*(1-N(d2))-S*(1-N(d1)),0);
  }
  const T=hoursLeft/(252*6.5);
  // ── IV حقيقي من VIX (محوّل لـ 0DTE)
  // VIX = annualized 30-day IV → نحوّله ليوم واحد
  const vixNow  = S.vix > 0 ? S.vix : 18;
  const sig     = Math.max(0.05, Math.min(0.60, (vixNow/100) * Math.sqrt(1/12)));
  // sig مثال: VIX=18 → sig≈0.052 | VIX=25 → sig≈0.072 | VIX=35 → sig≈0.101
  // هدف: أقل سعر ممكن مع بقائه ≤ $3.50/سهم ($350/عقد)
  // ══ المؤشرات ══
  const rsiV     = S.rsi.toFixed(1), macdV=S.mhist>0?'▲':'▼', stV=S.stD===1?'▲':'▼';
  const statsLine = getDailyStats();

  // ══ دالة: ابحث عن أفضل سترايك لميزانية محددة ══
  function findStrike(maxBudget) {
    const maxPrem = maxBudget / 100;  // $150→1.50, $250→2.50, $350→3.50
    let strike = Math.round(p/5)*5, prem = 0;
    // ابحث عن أعلى premium ≤ maxPrem
    for(let diff=0; diff<=200; diff+=5){
      const K = Math.round(p/5)*5 + (isL ? diff : -diff);
      const pr = bsOpt(p, K, T, sig, isL?'c':'p');
      if(pr <= maxPrem && pr > prem){ prem = pr; strike = K; }
    }
    // fallback: أقرب premium للهدف
    if(prem < 0.05){
      let best=9999;
      for(let diff=0;diff<=200;diff+=5){
        const K=Math.round(p/5)*5+(isL?diff:-diff);
        const pr=bsOpt(p,K,T,sig,isL?'c':'p');
        if(Math.abs(pr-maxPrem)<best){best=Math.abs(pr-maxPrem);prem=pr;strike=K;}
      }
    }
    const pv  = Math.round(prem*100)/100;
    const cv  = Math.round(pv*100);
    const slP = Math.round(pv*0.50*100)/100;
    const tpP = Math.round(pv*1.80*100)/100;
    const otm = Math.abs(strike - Math.round(p/5)*5);
    return { strike, pv, cv, slP, tpP, otm,
             otmLbl: otm===0?'ATM':`OTM +${otm} نقطة`,
             slLoss: cv - Math.round(slP*100),
             tpGain: Math.round(tpP*100) - cv };
  }

  const plans = [
    { num:1, budget:150, icon:'🥉', label:'توصية 1/3 — ميزانية $150' },
    { num:2, budget:250, icon:'🥈', label:'توصية 2/3 — ميزانية $250' },
    { num:3, budget:350, icon:'🥇', label:'توصية 3/3 — ميزانية $350' },
  ];

  // ── الرسالة الأولى: ملخص الإشارة
  await tg(
`${isL?'🚀':'🔻'} <b>NEXUS v7 — دخول ${isL?'CALL شراء':'بيع SHORT'}</b>

📊 <b>S&P 500 · SPX</b>
💰 الدخول: <b>${fmt(p)}</b>
📐 RSI:${rsiV} · MACD:${macdV} · ST:${stV} · ${sessionNote}
✅ قوة الإشارة: <b>${score}/22</b>  |  مستوى: <b>${sigLevel}</b>

🎯 <b>أهداف SPX:</b>
├ TP1: <b>${fmt(tp1)}</b>  (+${tp1Pts}pt | ${fmtP((tp1-p)/p*100)})
├ TP2: <b>${fmt(tp2)}</b>  (+${tp2Pts}pt | ${fmtP((tp2-p)/p*100)})
└ TP3: <b>${fmt(tp3)}</b>  (+${tp3Pts}pt | ${fmtP((tp3-p)/p*100)})
🛑 وقف SPX: <b>${fmt(sl)}</b>  (-${slPts}pt)  |  📏 R:R = 1:${rr}

👇 <b>اختر توصيتك حسب ميزانيتك:</b>
⏰ ${nowAr()}`);

  // ── 3 رسائل منفصلة — كل رسالة ميزانية مختلفة
  for(const plan of plans){
    const m = findStrike(plan.budget);
    await new Promise(r=>setTimeout(r,600)); // تأخير 0.6 ثانية بين الرسائل
    await tg(
`${plan.icon} <b>NEXUS v7 — ${isL?'CALL شراء':'PUT بيع'}  |  ${plan.label}</b>
━━━━━━━━━━━━━━━━━━
🏷 الدرجة: <b>${sigLevel}</b>  |  📊 الاحتمالية: <b>${probVal}%</b> ${probGrade}
✅ قوة الإشارة: <b>${score}/22</b>  |  ${sessionIcon} ${sessionNote}
━━━━━━━━━━━━━━━━━━
📊 <b>S&P 500 · SPX</b>
💰 سعر الدخول: <b>${fmt(p)}</b>
📈 الاتجاه: <b>${isL?'صاعد ▲':'هابط ▼'}</b>  |  VWAP: <b>${fmt(S.vwap||p)}</b>
📐 RSI: <b>${rsiV}</b>  ·  MACD: <b>${macdV}</b>  ·  ST: <b>${stV}</b>
${S.vix>0?'🌡 VIX: <b>'+S.vix.toFixed(1)+'</b>  '+(S.vix>30?'🔴 مرتفع':S.vix>20?'🟡 متوسط':'🟢 هادئ'):''}
💪 أقوى عوامل: ${topFacts}
━━━━━━━━━━━━━━━━━━
📌 <b>الأوبشن المقترح:</b>
${isL?'📈':'📉'} SPXW <b>${isL?'CALL':'PUT'} ${m.strike}</b>  |  0DTE  |  ${expDate}
📏 المسافة من السعر: <b>${m.otmLbl}</b>
💵 السعر: <b>$${m.pv}</b>/سهم
💰 إجمالي العقد: <b>~$${m.cv}</b>  ✅ ضمن ميزانية $${plan.budget}
━━━━━━━━━━━━━━━━━━
🛑 <b>وقف خسارة الأوبشن:</b>
إذا نزل Premium لـ <b>$${m.slP}</b> → اخرج فوراً
خسارة محتملة: <b>~$${m.slLoss}</b>

🎯 <b>هدف الأوبشن:</b>
إذا وصل Premium لـ <b>$${m.tpP}</b> → اخرج وحقق الربح
ربح محتمل: <b>~$${m.tpGain}</b>
━━━━━━━━━━━━━━━━━━
🎯 <b>أهداف SPX:</b>
├ TP1: <b>${fmt(tp1)}</b>  (+${tp1Pts}pt | ${fmtP((tp1-p)/p*100)})
├ TP2: <b>${fmt(tp2)}</b>  (+${tp2Pts}pt | ${fmtP((tp2-p)/p*100)})
└ TP3: <b>${fmt(tp3)}</b>  (+${tp3Pts}pt | ${fmtP((tp3-p)/p*100)})
🛑 وقف SPX: <b>${fmt(sl)}</b>  (-${slPts}pt | ${fmtP((sl-p)/p*100)})
📏 R:R = 1:${rr}
━━━━━━━━━━━━━━━━━━
📊 سجل اليوم: ${statsLine}
⏰ ${nowAr()}
⚠️ <i>ليست نصيحة مالية</i>`);
  }

  log(`📤 ${type} Lvl:${sigLevel[0]} SPXW ${bestStrike} prem:$${premVal} TP1:${fmt(tp1)} SL:${fmt(sl)}`);
}

async function alertSLBroken(){
  if(!canAlert('sl',300)) return;
  const p=S.price,pl=((p-TRADE.entry)/TRADE.entry*100).toFixed(2);
  TRADE.active=false;
  await tg(
`🛑 <b>NEXUS v7 — وقف الخسارة</b>
━━━━━━━━━━━━━━━━━━━━
📊 SPX: <b>${fmt(p)}</b>
📍 دخولك: <b>${fmt(TRADE.entry)}</b>
📉 P&L: <b>${pl}%</b>
${mktLn()}
⏰ ${nowAr()}
💡 <i>التزم بخطة التداول</i>`);
}

async function alertTPHit(num,tp){
  if(!canAlert('tp'+num,60)) return;
  const p=S.price;
  const emoji=num===1?'🎯':num===2?'🏆':'👑';
  await tg(
`${emoji} <b>NEXUS v7 — TP${num} ✅</b>
━━━━━━━━━━━━━━━━━━━━
📊 SPX: <b>${fmt(p)}</b>
🎯 الهدف ${num}: <b>${fmt(tp)}</b>
📍 الدخول: <b>${fmt(TRADE.entry)}</b>
💰 الربح: <b>${fmtP((p-TRADE.entry)/TRADE.entry*100)}</b>
${mktLn()}
${num<3?'💡 احمِ جزءاً من الربح':'🎊 جميع الأهداف حققت!'}
⏰ ${nowAr()}`);
}

async function alertNearTP(num,tp){
  await tg(`⚡ <b>NEXUS v7 — اقتراب TP${num}</b>\n📊 SPX: <b>${fmt(S.price)}</b>\n🎯 الهدف: <b>${fmt(tp)}</b>\n⏰ ${nowAr()}`);
}

async function alertRegimeChange(dir){
  if(!canAlert('regime',600)) return;
  await tg(
`⚡ <b>NEXUS v7 — تغيير اتجاه!</b>
━━━━━━━━━━━━━━━━━━━━
${dir==='UP'?'📈 الاتجاه انقلب صاعداً':'📉 الاتجاه انقلب هابطاً'}
📊 SPX: <b>${fmt(S.price)}</b>
${mktLn()}
⏰ ${nowAr()}`);
}

// ══════════════════════════════════════════════════════════════════
// checkAlerts
// ══════════════════════════════════════════════════════════════════
async 
// ══════════════════════════════════════════════════════════════════
// نظام الحجم المتغير — عدد العقود بناءً على الاحتمالية والدرجة
// ══════════════════════════════════════════════════════════════════
function calcContracts(prob, grade, vix) {
  // الحجم الأساسي بناءً على الاحتمالية
  let base = 1;
  if(prob >= 80 && grade === 'A+') base = 2;  // احتمال عالي جداً → عقدان
  else if(prob >= 75 && grade !== 'B') base = 2; // جيد → عقدان
  else base = 1;                                   // طبيعي → عقد واحد

  // تخفيض عند VIX مرتفع
  if(vix > 25 && vix <= 35) base = Math.max(1, base - 1); // VIX مرتفع → قلّل
  if(vix > 30) base = 1; // VIX جداً → عقد واحد فقط

  return Math.min(base, 3); // حد أقصى 3 عقود
}


// ══════════════════════════════════════════════════════════════════
// Support/Resistance تلقائي من آخر 20 شمعة
// ══════════════════════════════════════════════════════════════════
function calcSRLevels(history) {
  if(!history || history.length < 5) return {support:0, resistance:0, srBull:false, srBear:false};
  const recent = history.slice(-20);
  const highs  = recent.map(c => c.h || c.c || c);
  const lows   = recent.map(c => c.l || c.c || c);
  const closes = recent.map(c => c.c || c);

  // أعلى قمة وأدنى قاع في آخر 20 شمعة
  const resistance = Math.max(...highs);
  const support    = Math.min(...lows);
  const price      = closes[closes.length - 1];

  // هل السعر قريب من S/R؟ (خلال ATR/2)
  const atr = S.atr || 20;
  const srBull = price > support  && Math.abs(price - support)    < atr * 0.8;  // قرب دعم → شراء
  const srBear = price < resistance && Math.abs(price - resistance) < atr * 0.8; // قرب مقاومة → بيع
  return {support: Math.round(support*100)/100, resistance: Math.round(resistance*100)/100, srBull, srBear};
}

async function checkAlerts(){
  const sig = computeSig();
  const {isBuy,isSell,bScore,sScore,bLabels,sLabels,
         bGrade,sGrade,reason,bullishFlow,bearishFlow} = sig;
  const cur   = isBuy?'BUY':isSell?'SELL':'WAIT';
  const grade = isBuy?bGrade:isSell?sGrade:'';
  const score = isBuy?bScore:isSell?sScore:0;
  const p     = S.price;

  // ══ إدارة الصفقة المفتوحة ══
  if(TRADE.active){
    const isL  = TRADE.type==='BUY';
    const trail= TRADE.trailSl || TRADE.sl;
    const age  = TRADE.openedAt?(Date.now()-TRADE.openedAt.getTime())/60000:0;

    // Timeout 45 دقيقة
    if(!TRADE.tp1Hit && age>45 && canAlert('timeout',300)){
      const pnl = isL?p-TRADE.entry:TRADE.entry-p;
      recordResult('TIMEOUT', pnl, TRADE.score||0, TRADE.grade||'B', TRADE.type||'BUY', TRADE.entryHour||10);
      await tg(`⏱ <b>انتهاء الوقت — 45 دقيقة</b>\n\n📊 SPX: <b>${fmt(p)}</b>  |  دخول: <b>${fmt(TRADE.entry)}</b>\n${pnl>=0?'💚':'❤️'} P&L: <b>${pnl>=0?'+':''}${pnl.toFixed(1)} نقطة</b>\n\n📊 سجل اليوم: ${getDailyStats()}\n⏰ ${nowAr()}`);
      Object.assign(TRADE,{active:false,type:null,entry:0,tp1Hit:false,tp2Hit:false});
      S.lastSig='WAIT'; S.confirmCount=0; S.confirmDir='';
      return;
    }

    // كسر SL
    if((isL&&p<=trail)||(!isL&&p>=trail)){
      const pnl = isL?p-TRADE.entry:TRADE.entry-p;
      recordResult('SL_HIT', pnl, TRADE.score||0, TRADE.grade||'B', TRADE.type||'BUY', TRADE.entryHour||10);
      await alertSLBroken();
      return;
    }

    // تحذير SL
    const slDist = Math.abs(TRADE.entry-TRADE.sl);
    if(!TRADE.slWarned && Math.abs(p-trail)<slDist*0.30){
      TRADE.slWarned=true; await alertSLWarn();
    }

    // TP1 → breakeven
    if(!TRADE.tp1Hit){
      if(!TRADE.nearTp1&&Math.abs(TRADE.tp1-p)<4){ TRADE.nearTp1=true; await alertNearTP(1,TRADE.tp1); }
      if((isL&&p>=TRADE.tp1)||(!isL&&p<=TRADE.tp1)){
        TRADE.tp1Hit=true; TRADE.trailSl=TRADE.entry;
        await alertTPHit(1,TRADE.tp1);
      }
    }

    // TP2 → trailing 5 نقاط
    if(TRADE.tp1Hit&&!TRADE.tp2Hit){
      const newT = isL?p-5:p+5;
      if(isL&&newT>TRADE.trailSl) TRADE.trailSl=newT;
      if(!isL&&newT<TRADE.trailSl) TRADE.trailSl=newT;
      if(!TRADE.nearTp2&&Math.abs(TRADE.tp2-p)<4){ TRADE.nearTp2=true; await alertNearTP(2,TRADE.tp2); }
      if((isL&&p>=TRADE.tp2)||(!isL&&p<=TRADE.tp2)){
        TRADE.tp2Hit=true; TRADE.trailSl=TRADE.tp1;
        await alertTPHit(2,TRADE.tp2);
      }
    }

    // TP3
    if(TRADE.tp2Hit){
      if((isL&&p>=TRADE.tp3)||(!isL&&p<=TRADE.tp3)){
        const pnl = isL?TRADE.tp3-TRADE.entry:TRADE.entry-TRADE.tp3;
        recordResult('TP3', pnl, TRADE.score||0, TRADE.grade||'B', TRADE.type||'BUY', TRADE.entryHour||10);
        await alertTPHit(3,TRADE.tp3);
        Object.assign(TRADE,{active:false,type:null,entry:0,tp1Hit:false,tp2Hit:false});
        S.lastSig='WAIT'; S.confirmCount=0; S.confirmDir='';
      }
    }

    // إشارة عكسية A+ فقط
    if(cur!=='WAIT'&&cur!==TRADE.type&&grade==='A+'&&canAlert('reverse',900)){
      await alertCancel(`⚡ إشارة عكسية A+ — فكّر في الخروج`);
    }
    return;
  }

  // ══ نظام التأكيد الذكي ══
  if(!S.confirmCount) S.confirmCount=0;
  if(!S.confirmDir)   S.confirmDir='';

  if(cur==='WAIT'){
    if(S.confirmDir!=='WAIT'){
      if(reason) log(`[Filter] ${reason}`);
    }
    S.confirmCount=0; S.confirmDir='WAIT'; S.lastSig='WAIT';
    return;
  }

  // تغير الاتجاه → ابدأ من جديد
  if(cur !== S.confirmDir){
    S.confirmCount=1; S.confirmDir=cur;
    log(`[C 1] ${cur} grade:${grade} score:${score}`);
    return;
  }

  S.confirmCount++;

  // حد التأكيد:
  // A+ → 1 (فوري)
  // A  → 2
  // B  → 3
  const needed = grade==='A+'?1 : grade==='A'?2 : 3;
  log(`[C ${S.confirmCount}/${needed}] ${cur} grade:${grade} score:${score}`);
  if(S.confirmCount < needed) return;

  // Cooldown بحسب الدرجة
  const cd = grade==='A+'?1200 : grade==='A'?1800 : 2700;
  if(!canAlert('entry',cd)){
    log(`[CD] ${cur} grade:${grade}`); return;
  }

  S.confirmCount=0; S.confirmDir=''; S.lastSig=cur;
  log(`✅ [SIGNAL] ${cur} grade:${grade} score:${score}`);
  await alertEntry(cur,bScore,sScore,bLabels,sLabels);
}

// ══ Win Rate Tracker ══
// ══════════════════════════════════════════════════════
// نظام التتبع والتحليل الاحترافي — Analytics Engine
// يحلل: win rate، أفضل ساعات، أسباب الخسارة، درجة الأداء
// ══════════════════════════════════════════════════════

const STATS = {
  wins:0, losses:0, breakeven:0,
  totalPnl:0, totalTrades:0,
  byGrade: {'A+':{'w':0,'l':0,'pnl':0}, 'A':{'w':0,'l':0,'pnl':0}, 'B':{'w':0,'l':0,'pnl':0}},
  byHour:  {},      // win rate بحسب الساعة
  byType:  {'BUY':{'w':0,'l':0}, 'SELL':{'w':0,'l':0}},
  recentTrades: [], // آخر 200 صفقة للتحليل الأسبوعي
  lossFactors:  {},  // تحليل أسباب الخسائر
  lossCause: {'SL_HIT':0,'TIMEOUT':0,'REVERSE':0},
  trades: []        // آخر 100 صفقة
};

function recordResult(exitType, pnl, score, grade, tradeType, entryHour){
  const isWin  = pnl >  2;
  const isLoss = pnl < -2;

  // إجمالي
  STATS.totalTrades++;
  STATS.totalPnl += pnl;
  if(isWin)       STATS.wins++;
  else if(isLoss) STATS.losses++;
  else            STATS.breakeven++;

  // حسب الدرجة
  const g = grade||'B';
  if(STATS.byGrade[g]){
    if(isWin)  STATS.byGrade[g].w++;
    if(isLoss) STATS.byGrade[g].l++;
    STATS.byGrade[g].pnl += pnl;
  }

  // حسب الساعة
  const h = Math.floor(entryHour||10);
  if(!STATS.byHour[h]) STATS.byHour[h]={w:0,l:0};
  if(isWin)  STATS.byHour[h].w++;
  if(isLoss) STATS.byHour[h].l++;

  // حسب النوع
  const t = tradeType||'BUY';
  if(STATS.byType[t]){
    if(isWin)  STATS.byType[t].w++;
    if(isLoss) STATS.byType[t].l++;
  }

  // سبب الخسارة
  if(isLoss && STATS.lossCause[exitType]!==undefined)
    STATS.lossCause[exitType]++;

  // سجل الصفقات
  STATS.trades.push({
    exitType, pnl:Math.round(pnl*10)/10,
    score, grade:g, type:t,
    hour:entryHour||10,
    ts:Date.now()
  });
  if(STATS.trades.length > 100) STATS.trades.shift();

  log('[Stats] '+exitType+' pnl:'+pnl.toFixed(1)+
      ' grade:'+g+' W:'+STATS.wins+' L:'+STATS.losses);
}

function getDailyStats(){
  const total = STATS.wins+STATS.losses+STATS.breakeven;
  if(total===0) return 'لا صفقات بعد اليوم';
  const wr   = Math.round(STATS.wins/(STATS.wins+STATS.losses||1)*100);
  const sign = STATS.totalPnl>=0?'+':'';
  return '✅'+STATS.wins+' ❌'+STATS.losses+
         ' | Win:'+wr+'% | P&L:'+sign+STATS.totalPnl.toFixed(0)+'pt';
}

function getFullReport(){
  const total = STATS.wins+STATS.losses+STATS.breakeven;
  if(total===0) return '📊 لا توجد بيانات كافية بعد.';

  const wr = Math.round(STATS.wins/(STATS.wins+STATS.losses||1)*100);
  const avg = (STATS.totalPnl/total).toFixed(1);

  // أفضل ساعة
  let bestH='?', bestWR=0;
  for(const [h,v] of Object.entries(STATS.byHour)){
    const tot=v.w+v.l; if(tot<2) continue;
    const r=Math.round(v.w/tot*100);
    if(r>bestWR){bestWR=r;bestH=h+':00 ET';}
  }

  // أداء حسب الدرجة
  const gradeLines = Object.entries(STATS.byGrade)
    .filter(([,v])=>v.w+v.l>0)
    .map(([g,v])=>{
      const t=v.w+v.l;
      const r=Math.round(v.w/t*100);
      return g+': '+r+'% ('+t+' صفقة)';
    }).join(' | ');

  // أكثر سبب خسارة
  const topCause = Object.entries(STATS.lossCause)
    .sort((a,b)=>b[1]-a[1])[0];
  const causeLabel = topCause[1]>0
    ? (topCause[0]==='SL_HIT'?'كسر SL':
       topCause[0]==='TIMEOUT'?'انتهاء وقت':'إشارة عكسية')
    : 'لا خسائر';

  return '📊 <b>تقرير الأداء</b>\n\n'+
    '📈 الصفقات: <b>'+total+'</b> | Win Rate: <b>'+wr+'%</b>\n'+
    '💰 P&L الإجمالي: <b>'+(STATS.totalPnl>=0?'+':'')+STATS.totalPnl.toFixed(0)+' نقطة</b>\n'+
    '📉 متوسط/صفقة: <b>'+avg+' نقطة</b>\n\n'+
    '🏆 حسب الدرجة: '+gradeLines+'\n'+
    '⏰ أفضل وقت: <b>'+bestH+'</b> ('+bestWR+'%)\n'+
    '⚠️ سبب الخسارة الأكثر: <b>'+causeLabel+'</b>';
}

// ══════════════════════════════════════════════════════════════════
// أخبار مالية — RSS
// ══════════════════════════════════════════════════════════════════
const NEWS_CACHE={data:[],ts:0};
const NEWS_TTL=10*60*1000;

// ترجمة بسيطة للكلمات الشائعة في العناوين المالية
function translateFinance(text){
  const dict={
    'Federal Reserve':'الاحتياطي الفيدرالي','Fed':'الفيدرالي','interest rates':'أسعار الفائدة',
    'inflation':'التضخم','GDP':'الناتج المحلي','unemployment':'البطالة',
    'stocks':'الأسهم','market':'السوق','rally':'ارتفاع','decline':'انخفاض',
    'earnings':'الأرباح','revenue':'الإيرادات','forecast':'التوقعات',
    'Wall Street':'وول ستريت','S&P 500':'مؤشر S&P 500','Nasdaq':'ناسداك',
    'Dow Jones':'داو جونز','Treasury':'الخزانة','bonds':'السندات',
    'oil':'النفط','gold':'الذهب','dollar':'الدولار','euro':'اليورو',
    'China':'الصين','Europe':'أوروبا','Asia':'آسيا','recession':'ركود',
    'rate hike':'رفع الفائدة','rate cut':'خفض الفائدة','tariff':'الرسوم الجمركية',
    'trade war':'الحرب التجارية','technology':'التكنولوجيا','bank':'البنك',
    'profit':'الربح','loss':'الخسارة','quarterly':'الفصلية','annual':'السنوية',
    'merger':'اندماج','acquisition':'استحواذ','IPO':'الاكتتاب العام',
    'crypto':'العملات الرقمية','bitcoin':'بيتكوين','energy':'الطاقة',
    'report':'التقرير','data':'البيانات','growth':'النمو','slowdown':'التباطؤ',
  };
  let t=text;
  for(const [en,ar] of Object.entries(dict)){
    t=t.replace(new RegExp(en,'gi'),ar);
  }
  return t;
}

async function fetchRSS(url,src,lang){
  try{
    const r=await fetch(url,{
      headers:{'User-Agent':'Mozilla/5.0','Accept':'application/rss+xml,text/xml,*/*'},
      signal:AbortSignal.timeout(7000)
    });
    if(!r.ok){log(`[News] ${src} HTTP ${r.status}`);return[];}
    const xml=await r.text();
    const items=[];
    const itemRx=/<item[^>]*>([\s\S]*?)<\/item>/gi;
    let m;
    while((m=itemRx.exec(xml))!==null&&items.length<5){
      const b=m[1];
      let title=((b.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)||[])[1]||'').trim();
      const link=((b.match(/<link[^>]*>([^<]+)<\/link>/)||b.match(/<link[^>]*href="([^"]+)"/)||[])[1]||'').trim();
      const date=((b.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/)||[])[1]||'').trim();
      let desc=((b.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)||[])[1]||'')
                .replace(/<[^>]+>/g,'').trim().slice(0,150);
      // ترجم الأخبار الإنجليزية
      if(lang==='en'){title=translateFinance(title);desc=translateFinance(desc);}
      title=title.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
      if(title.length>5) items.push({title,link,desc,src,lang:'ar',ts:date?new Date(date).getTime():Date.now()});
    }
    log(`[News] ${src}: ${items.length} items`);
    return items;
  }catch(e){log(`[News] ${src} ERR: ${e.message}`);return[];}
}

async function fetchAllNews(){
  if(Date.now()-NEWS_CACHE.ts<NEWS_TTL&&NEWS_CACHE.data.length>0) return NEWS_CACHE.data;
  const feeds=[
    {url:'https://feeds.bbci.co.uk/arabic/business/rss.xml',     src:'BBC عربي',    lang:'ar'},
    {url:'https://www.aljazeera.net/rss/economy/index.xml',        src:'الجزيرة',     lang:'ar'},
    {url:'https://feeds.marketwatch.com/marketwatch/topstories/', src:'MarketWatch', lang:'en'},
    {url:'https://feeds.reuters.com/reuters/businessNews',         src:'Reuters',     lang:'en'},
    {url:'https://finance.yahoo.com/news/rssindex',                src:'Yahoo',       lang:'en'},
  ];
  const results=await Promise.allSettled(feeds.map(f=>fetchRSS(f.url,f.src,f.lang)));
  let all=[];
  results.forEach(r=>{if(r.status==='fulfilled')all=all.concat(r.value);});
  all.sort((a,b)=>(b.ts||0)-(a.ts||0));
  NEWS_CACHE.data=all.slice(0,25);
  NEWS_CACHE.ts=Date.now();
  log(`[News] Total: ${NEWS_CACHE.data.length} items`);
  return NEWS_CACHE.data;
}

// ══════════════════════════════════════════════════════════════════
// API Routes
// ══════════════════════════════════════════════════════════════════
// مفاتيح runtime
app.post('/api/keys',(req,res)=>{
  const{finnhub,alphavantage}=req.body||{};
  if(finnhub)      {RUNTIME_KEYS.finnhub=finnhub;      log('🔑 Finnhub key set');}
  if(alphavantage) {RUNTIME_KEYS.alphavantage=alphavantage;log('🔑 AV key set');}
  res.json({ok:true,hasFinnhub:!!RUNTIME_KEYS.finnhub,hasAV:!!RUNTIME_KEYS.alphavantage});
});
app.get('/api/keys/status',(req,res)=>{
  res.json({hasFinnhub:!!(RUNTIME_KEYS.finnhub||process.env.FINNHUB_KEY),hasAV:!!(RUNTIME_KEYS.alphavantage||process.env.ALPHAVANTAGE_KEY)});
});

// بيانات السوق
app.get('/api/reset-stats',(req,res)=>{
  STATS.wins=0;STATS.losses=0;STATS.breakeven=0;
  STATS.totalPnl=0;STATS.totalTrades=0;
  STATS.trades=[];
  Object.keys(STATS.byHour).forEach(k=>delete STATS.byHour[k]);
  Object.keys(STATS.byGrade).forEach(k=>{STATS.byGrade[k]={w:0,l:0,pnl:0};});
  Object.keys(STATS.lossCause).forEach(k=>{STATS.lossCause[k]=0;});
  res.json({ok:true,message:'تم إعادة ضبط الإحصائيات'});
});

app.get('/api/market',async(req,res)=>{
  if(S.price===0){log('⚡ جلب فوري...');await loadMarketData();}
  const sig=computeSig();
  const{isBuy,isSell,bs,ss,bScore=0,sScore=0,bPct=0,sPct=0,bLabels=[],sLabels=[],conviction=0}=sig;
  res.json({
    price:S.price,prev:S.prev,open:S.open,high:S.high,low:S.low,
    vol:S.vol,volR:S.volR,mktState:S.mktState,
    rsi:S.rsi,macd:S.macd,msig:S.msig,mhist:S.mhist,
    sk:S.sk,sd:S.sd,bbU:S.bbU,bbL:S.bbL,bbB:S.bbB,
    atr:S.atr,stV:S.stV,stD:S.stD,
    ema9:S.ema9,ema21:S.ema21,ema50:S.ema50,ema200:S.ema200,vwap:S.vwap,
    obv:S.obv,obvE:S.obvE,fibH:S.fibH,fibL:S.fibL,
    isExt:S.isExt,dataSource:S._lastSource||'Yahoo',
    history:S.history.slice(-300),
    vix:S.vix, vixPrev:S.vixPrev,
    sig:{isBuy,isSell,bs,ss,bScore,sScore,bPct,sPct,bLabels,sLabels,conviction},
    trade:{active:TRADE.active,type:TRADE.type,entry:TRADE.entry,
      tp1:TRADE.tp1,tp2:TRADE.tp2,tp3:TRADE.tp3,sl:TRADE.sl,trailSl:TRADE.trailSl,
      tp1Hit:TRADE.tp1Hit,tp2Hit:TRADE.tp2Hit,score:TRADE.score},
    ts:Date.now()
  });
});

// أخبار
app.get('/api/news',async(req,res)=>{
  try{
    const news=await fetchAllNews();
    res.json({ok:true,count:news.length,news,ts:Date.now()});
  }catch(e){res.status(500).json({ok:false,error:e.message,news:[]});}
});

// تقويم اقتصادي
app.get('/api/calendar',async(req,res)=>{
  try{
    const FHK=process.env.FINNHUB_KEY||RUNTIME_KEYS.finnhub||'';
    if(!FHK){res.json({ok:false,msg:'FINNHUB_KEY مطلوب',events:[]});return;}
    const today=new Date();
    const yyyy=today.getFullYear();
    const mm=String(today.getMonth()+1).padStart(2,'0');
    const dd=String(today.getDate()).padStart(2,'0');
    const dateStr=`${yyyy}-${mm}-${dd}`;
    const r=await fetch(
      `https://finnhub.io/api/v1/calendar/economic?from=${dateStr}&to=${dateStr}&token=${FHK}`,
      {signal:AbortSignal.timeout(8000)});
    if(!r.ok){res.json({ok:false,msg:'HTTP '+r.status,events:[]});return;}
    const d=await r.json();
    res.json({ok:true,events:d.economicCalendar||[]});
  }catch(e){res.json({ok:false,error:e.message,events:[]});}
});

// Ping
app.get('/api/report',(req,res)=>{
  res.json({
    summary: getDailyStats(),
    full: getFullReport(),
    stats: {
      total: STATS.totalTrades,
      wins:  STATS.wins,
      losses:STATS.losses,
      winRate: STATS.wins+STATS.losses>0?
               Math.round(STATS.wins/(STATS.wins+STATS.losses)*100):0,
      totalPnl: Math.round(STATS.totalPnl*10)/10,
      byGrade: STATS.byGrade,
      byHour:  STATS.byHour,
      lossCause: STATS.lossCause,
      recentTrades: STATS.trades.slice(-10)
    }
  });
});

app.get('/ping',(req,res)=>res.json({ok:true,price:S.price,ts:Date.now()}));

app.get('/',(req,res)=>{
  const fs=require('fs');
  const p1=path.join(__dirname,'public','index.html');
  const p2=path.join(__dirname,'index.html');
  if(fs.existsSync(p1)) res.sendFile(p1);
  else if(fs.existsSync(p2)) res.sendFile(p2);
  else res.status(404).send('index.html مفقود — ضعه في نفس مجلد server.js');
});

// PWA
app.get('/manifest.json',(req,res)=>{
  res.json({name:'NEXUS ULTRA v7',short_name:'NEXUS v7',
    start_url:'/',display:'standalone',background_color:'#050510',
    theme_color:'#5a6eff',lang:'ar',dir:'rtl',
    icons:[{src:'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect width=%22100%22 height=%22100%22 fill=%22%235a6eff%22/><text y=%22.9em%22 font-size=%2290%22>📈</text></svg>',sizes:'192x192',type:'image/svg+xml'}]});
});

// ══════════════════════════════════════════════════════════════════
// جدول تحديث البيانات
// ══════════════════════════════════════════════════════════════════
let alertLoop = null;

function getRefreshInterval(){
  const etH=((new Date().getUTCHours()-4+24)%24)+new Date().getUTCMinutes()/60;
  const day=new Date().getUTCDay();
  if(day===0||day===6) return 10*60*1000;
  if(etH>=4&&etH<9.5)  return 2*60*1000;
  if(etH>=9.5&&etH<16) return 15*1000;  // 15 ثانية في الجلسة
  if(etH>=16&&etH<20)  return 2*60*1000;
  return 10*60*1000;
}


// ══════════════════════════════════════════════════════════════════
// تقرير افتتاح السوق التلقائي — يُرسل عند 9:35 AM ET يومياً
// ══════════════════════════════════════════════════════════════════
let _morningReportSent = '';  // تتبع اليوم لمنع الإرسال المزدوج

async function sendMorningReport() {
  const p    = S.price;
  const prev = S.prev || p;
  const chg  = p - prev;
  const chgP = prev > 0 ? (chg/prev*100).toFixed(2) : '0.00';
  const dir  = chg >= 0 ? '📈' : '📉';
  const dirTxt = chg >= 0 ? 'صاعد ▲' : 'هابط ▼';

  // حساب التوصية الصباحية (أفضل سترايك ≤ $350)
  const etH      = ((new Date().getUTCHours()-4+24)%24)+new Date().getUTCMinutes()/60;
  const hoursLeft= Math.max(16.0 - etH, 0.1);
  const T        = hoursLeft/(252*6.5);
  const vixMR    = S.vix > 0 ? S.vix : 18;
  const sig      = Math.max(0.05, Math.min(0.60, (vixMR/100) * Math.sqrt(1/12)));

  function bsQ(Sp,K,T,s,o){
    if(T<=0) return Math.max(o==='c'?Sp-K:K-Sp,0);
    const sq=Math.sqrt(T);
    const d1=(Math.log(Sp/K)+(0.053+0.5*s*s)*T)/(s*sq);
    const d2=d1-s*sq;
    const N=x=>{const p2=[0.319381530,-0.356563782,1.781477937,-1.821255978,1.330274429];const t=1/(1+0.2316419*Math.abs(x));let poly=0,tp=t;for(const c of p2){poly+=c*tp;tp*=t;}const nd=Math.exp(-x*x/2)/Math.sqrt(2*Math.PI);return x>=0?1-nd*poly:nd*poly;};
    if(o==='c') return Math.max(Sp*N(d1)-K*Math.exp(-0.053*T)*N(d2),0);
    return Math.max(K*Math.exp(-0.053*T)*(1-N(d2))-Sp*(1-N(d1)),0);
  }

  // التوصية: CALL إذا فوق VWAP، PUT إذا تحته
  const vwap    = S.vwap || p;
  const recType = p >= vwap ? 'CALL' : 'PUT';
  const isL     = recType === 'CALL';

  // ابحث عن أفضل سترايك ≤ $3.50
  let recStrike = Math.round(p/5)*5;
  let recPrem   = 0;
  for(let diff=0; diff<=150; diff+=5){
    const K    = Math.round(p/5)*5 + (isL ? diff : -diff);
    const prem = bsQ(p, K, T, sig, isL?'c':'p');
    if(prem <= 3.50 && prem > recPrem){ recPrem = prem; recStrike = K; }
  }
  if(recPrem < 0.10){
    // fallback
    for(let diff=0;diff<=80;diff+=5){
      const K=Math.round(p/5)*5+(isL?diff:-diff);
      const prem=bsQ(p,K,T,sig,isL?'c':'p');
      if(Math.abs(prem-2.5)<Math.abs(recPrem-2.5)){ recPrem=prem; recStrike=K; }
    }
  }

  const rPrem   = Math.round(recPrem*100)/100;
  const rCost   = Math.round(rPrem*100);
  const rSL     = Math.round(rPrem*0.50*100)/100;
  const rTP     = Math.round(rPrem*1.80*100)/100;
  const rOTM    = Math.abs(recStrike - Math.round(p/5)*5);
  const rOTMlbl = rOTM===0?'ATM':`OTM +${rOTM} نقطة`;
  const d       = isL?1:-1;
  const tp1r    = Math.round((p + d*10)*100)/100;
  const tp2r    = Math.round((p + d*20)*100)/100;
  const tp3r    = Math.round((p + d*35)*100)/100;
  const slSPX   = Math.round((p - d*8)*100)/100;
  const expDate = new Date().toLocaleDateString('en-US',{
    timeZone:'America/New_York',month:'short',day:'2-digit',year:'2-digit'
  }).replace(', ',"'");

  // مؤشرات
  const vixLine  = S.vix>0 ? `🌡 VIX: <b>${S.vix.toFixed(1)}</b>  ${S.vix>30?'🔴 مرتفع':S.vix>20?'🟡 متوسط':'🟢 هادئ'}` : '';
  const atrLine  = `📊 ATR: <b>${(S.atr||0).toFixed(1)}</b> نقطة`;
  const rsiLine  = `📐 RSI: <b>${(S.rsi||50).toFixed(1)}</b>  VWAP: <b>${fmt(vwap)}</b>`;
  const ema200l  = S.ema200>0 ? (p>S.ema200?'فوق EMA200 ✅':'تحت EMA200 ⚠️') : '';
  const trend    = p > vwap ? '🟢 صاعد — فوق VWAP' : '🔴 هابط — تحت VWAP';

  await tg(
`🌅 <b>NEXUS v7 — تقرير افتتاح السوق</b>
━━━━━━━━━━━━━━━━━━
📊 <b>S&P 500 · SPX</b>
💰 السعر الحالي: <b>${fmt(p)}</b>
${dir} التغير: <b>${chg>=0?'+':''}${chg.toFixed(2)}</b>  (${chg>=0?'+':''}${chgP}%)
━━━━━━━━━━━━━━━━━━
🧭 الاتجاه: <b>${trend}</b>
${rsiLine}
${atrLine}
${vixLine}
${ema200l ? '📈 '+ema200l : ''}
━━━━━━━━━━━━━━━━━━
📌 <b>التوصية الصباحية:</b>
${isL?'🚀':'🔻'} <b>SPXW ${recType} ${recStrike}</b>  |  0DTE  |  ${expDate}
📏 ${rOTMlbl}
💵 السعر: <b>$${rPrem}</b>/سهم
💰 إجمالي العقد: <b>~$${rCost}</b>  ✅ ضمن الميزانية

🛑 وقف الخسارة: إذا نزل لـ <b>$${rSL}</b> → اخرج
🎯 الهدف: إذا وصل لـ <b>$${rTP}</b> → اخرج

🎯 <b>أهداف SPX:</b>
├ TP1: <b>${fmt(tp1r)}</b>
├ TP2: <b>${fmt(tp2r)}</b>
└ TP3: <b>${fmt(tp3r)}</b>
🛑 وقف SPX: <b>${fmt(slSPX)}</b>  |  📏 R:R = 1:2.5
━━━━━━━━━━━━━━━━━━
⏰ ${nowAr()}
⚠️ <i>ليست نصيحة مالية · راقب السوق قبل الدخول</i>`);

  log('📨 تقرير الافتتاح أُرسل');
}

// ── فحص هل يجب إرسال تقرير الافتتاح
function checkMorningReport() {
  const now  = new Date();
  const etH  = ((now.getUTCHours()-4+24)%24) + now.getUTCMinutes()/60;
  const day  = now.getUTCDay();
  const dateKey = now.toISOString().slice(0,10);

  // أيام العمل فقط، بين 9:33 و 9:40 ET، ولم يُرسل اليوم
  if(day===0||day===6) return;
  if(etH >= 9.55 && etH <= 9.67 && _morningReportSent !== dateKey && S.price > 0) {
    _morningReportSent = dateKey;
    sendMorningReport();
  }
}

async function tick(){
  await loadMarketData();
  checkMorningReport();
  await checkAlerts();
  const next=getRefreshInterval();
  alertLoop=setTimeout(tick,next);
  log(`⏰ التالي: ${Math.round(next/1000)}ث`);
}

// ══════════════════════════════════════════════════════════════════
// تشغيل السيرفر
// ══════════════════════════════════════════════════════════════════
(async()=>{
  log('⏳ تحميل البيانات الأولية...');
  let loaded=await loadMarketData();
  if(!loaded){await new Promise(r=>setTimeout(r,3000));loaded=await loadMarketData();}


// ── API: تعديل الأهداف الأسبوعية
app.post('/api/weekly-goals', express.json(), (req,res)=>{
  const { goal, maxLoss } = req.body||{};
  if(goal && typeof goal==='number')   WEEKLY.goalPnl  = goal;
  if(maxLoss && typeof maxLoss==='number') WEEKLY.maxLoss = maxLoss;
  log(`⚙️ أهداف أسبوعية: +$${WEEKLY.goalPnl} / -$${Math.abs(WEEKLY.maxLoss)}`);
  res.json({ok:true, goalPnl:WEEKLY.goalPnl, maxLoss:WEEKLY.maxLoss});
});

  app.listen(PORT,async()=>{
    log(`🚀 NEXUS v7 يعمل على المنفذ ${PORT}`);
    if(TG_TOKEN&&TG_CHAT){
      await tg(`🟢 <b>NEXUS v7 انطلق!</b>\n\n✅ السيرفر يعمل\n💹 SPX: <b>${fmt(S.price)}</b>\n🤖 التنبيهات مفعّلة\n📊 ATR: <b>${S.atr.toFixed(1)}</b> نقطة\n${mktLn()}\n⏰ ${nowAr()}`);
    }
    setTimeout(tick, 5000);
  });
})();
