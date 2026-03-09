// ═══════════════════════════════════════════════════════════════════
//  NEXUS ULTRA v7 — Server
//  ✅ الداشبورد الكامل على /
//  ✅ تنبيهات تيليجرام تلقائية (8 أنواع)
//  ✅ أسعار حية: جلسة رسمية + Pre-Market + After-Hours
//  ✅ Self-ping (لا ينام على Render المجاني)
//  ✅ تحديث ذكي: 30ث رسمي، 2د Pre/After، 10د ليل
// ═══════════════════════════════════════════════════════════════════

const express = require('express');
const path    = require('path');
const app     = express();
app.use(express.json());

// ── CORS headers — يسمح للـ browser بالوصول للـ API
app.use((req,res,next)=>{
  res.header('Access-Control-Allow-Origin','*');
  res.header('Access-Control-Allow-Headers','Content-Type');
  res.header('Cache-Control','no-cache, no-store, must-revalidate');
  next();
});

// ── fetch polyfill — يعمل مع Node 16 و 18 و 20+
if (!globalThis.fetch) {
  try {
    const nodeFetch = require('node-fetch');
    globalThis.fetch = nodeFetch.default || nodeFetch;
    globalThis.Headers = nodeFetch.Headers;
    console.log('[INFO] node-fetch loaded as polyfill');
  } catch(e) {
    console.error('[WARN] node-fetch not found, fetch may not work:', e.message);
  }
}

// ── الداشبورد الكامل من مجلد public
// الداشبورد مباشرة من نفس مجلد السيرفر
app.use(express.static(__dirname));

// ── PWA routes
app.get('/manifest.json',(req,res)=>{
  res.setHeader('Content-Type','application/manifest+json');
  res.sendFile(path.join(__dirname,'manifest.json'));
});
app.get('/sw.js',(req,res)=>{
  res.setHeader('Content-Type','application/javascript');
  res.setHeader('Service-Worker-Allowed','/');
  res.sendFile(path.join(__dirname,'sw.js'));
});
// PWA icons placeholder
app.get('/icon-:size.png',(req,res)=>{
  // إرجاع SVG كـ PNG (بدون مكتبة صور)
  const size=parseInt(req.params.size)||192;
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" rx="${size*0.15}" fill="#03030c"/>
    <circle cx="${size/2}" cy="${size*0.4}" r="${size*0.25}" fill="none" stroke="#5a6eff" stroke-width="${size*0.04}"/>
    <path d="M ${size*0.35} ${size*0.4} L ${size*0.45} ${size*0.5} L ${size*0.65} ${size*0.3}" 
          stroke="#22c55e" stroke-width="${size*0.05}" fill="none" stroke-linecap="round"/>
    <rect x="${size*0.25}" y="${size*0.65}" width="${size*0.5}" height="${size*0.04}" rx="${size*0.02}" fill="#5a6eff"/>
    <rect x="${size*0.3}" y="${size*0.73}" width="${size*0.4}" height="${size*0.03}" rx="${size*0.015}" fill="#333"/>
  </svg>`;
  res.setHeader('Content-Type','image/svg+xml');
  res.send(svg);
});

// ── إعدادات (من Render Environment Variables)
const TG_TOKEN = process.env.TG_TOKEN || '';
const TG_CHAT  = process.env.TG_CHAT  || '';
const PORT     = process.env.PORT     || 3000;

// ── Log
const log = msg => console.log(`[${new Date().toISOString()}] ${msg}`);

// ══════════════════════════════════════════
//  حالة السوق
// ══════════════════════════════════════════
const S = {
  price:0, prev:0, open:0, high:0, low:0, vol:0, volR:1,
  rsi:50, macd:0, msig:0, mhist:0, sk:50, sd:50,
  bbU:0, bbL:0, bbB:0, atr:30, stV:0, stD:1,
  ema21:0, ema50:0, ema200:0, obv:0, obvE:0,
  fibH:0, fibL:0, history:[],
  mktState:'REGULAR', isExt:false, dataSource:'Yahoo', lastSig:'WAIT', lastScore:0, ema9:0, vwap:0,
};

// ── حالة الصفقة
const TRADE = {
  active:false, type:null, entry:0, atr:0,
  tp1:0, tp2:0, tp3:0, sl:0, trailSl:0, score:0,
  tp1Hit:false, tp2Hit:false,
  nearTp1:false, nearTp2:false, slWarned:false,
  openedAt:null,
};

// ── Cooldown
const CD = {};
const canAlert = (k,s=120) => {
  const n=Date.now();
  if(CD[k]&&(n-CD[k])<s*1000) return false;
  CD[k]=n; return true;
};

// ── Formatters
const fmt   = (n,d=2) => typeof n==='number'&&!isNaN(n) ? n.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}) : '--';
const fmtP  = n => typeof n==='number'&&!isNaN(n) ? ((n>=0?'+':'')+n.toFixed(2)+'%') : '--';
const nowAr = () => new Date().toLocaleString('ar-SA',{timeZone:'Asia/Riyadh'});
const mktLn = () => `📐 RSI:${S.rsi.toFixed(1)} · MACD:${S.macd>S.msig?'▲':'▼'} · ST:${S.stD===1?'▲صاعد':'▼هابط'} · ${S.mktState}`;

// ══════════════════════════════════════════
//  رياضيات المؤشرات
// ══════════════════════════════════════════
function ema(d,n){
  if(d.length<n) return [d.at(-1)||0];
  const k=2/(n+1); let e=d.slice(0,n).reduce((a,b)=>a+b)/n;
  const r=[e];
  for(let i=n;i<d.length;i++){e=d[i]*k+e*(1-k);r.push(e);}
  return r;
}
function calcRSI(c,n=14){
  if(c.length<n+2) return [50];
  let ag=0,al=0;
  for(let i=1;i<=n;i++){const d=c[i]-c[i-1];d>0?ag+=d:al-=d;}
  ag/=n; al/=n;
  const r=[];
  for(let i=n+1;i<c.length;i++){
    const d=c[i]-c[i-1];
    ag=(ag*(n-1)+Math.max(d,0))/n;
    al=(al*(n-1)+Math.max(-d,0))/n;
    r.push(al===0?100:100-(100/(1+ag/al)));
  }
  return r.length?r:[50];
}
function calcMACD(c){
  const e12=ema(c,12),e26=ema(c,26),n=Math.min(e12.length,e26.length);
  const ml=e12.slice(-n).map((v,i)=>v-e26[e26.length-n+i]);
  const sl=ema(ml,9);
  return {macd:ml.at(-1)||0, signal:sl.at(-1)||0, hist:(ml.at(-1)||0)-(sl.at(-1)||0)};
}
function calcBB(c,n=20,m=2){
  const s=c.slice(-n), mean=s.reduce((a,b)=>a+b)/n;
  const std=Math.sqrt(s.reduce((a,b)=>a+(b-mean)**2,0)/n);
  return {upper:mean+m*std, lower:mean-m*std, basis:mean};
}
function calcATR(h,l,c,n=14){
  if(c.length<2) return 20;
  const tr=[];
  for(let i=1;i<Math.min(c.length,h.length,l.length);i++)
    tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));
  return tr.slice(-n).reduce((a,b)=>a+b,0)/Math.min(n,tr.length)||20;
}
function calcStoch(c){
  const r=calcRSI(c); if(r.length<14) return {k:50,d:50};
  const n=14,ka=[];
  for(let i=n;i<r.length;i++){
    const sl=r.slice(i-n,i),hi=Math.max(...sl),lo=Math.min(...sl);
    ka.push(hi===lo?50:(r[i]-lo)/(hi-lo)*100);
  }
  if(!ka.length) return {k:50,d:50};
  const sm=(a,n)=>a.map((_,i)=>i<n-1?null:a.slice(i-n+1,i+1).reduce((x,y)=>x+y)/n).filter(v=>v!==null);
  const K=sm(ka,3),D=sm(K,3);
  return {k:K.at(-1)??50, d:D.at(-1)??50};
}
function calcST(h,l,c,n=10,f=3){
  if(c.length<n+2) return {val:c.at(-1)||0, dir:1};
  const tr=[];
  for(let i=1;i<c.length;i++)
    tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));
  let atv=tr.slice(0,n).reduce((a,b)=>a+b)/n,dir=1,pu=0,pl=0;
  for(let i=n;i<c.length;i++){
    atv=(atv*(n-1)+tr[i-1])/n;
    const hl=(h[i]+l[i])/2,up=hl+f*atv,dn=hl-f*atv;
    const nu=up<pu||c[i-1]>pu?up:pu, nl=dn>pl||c[i-1]<pl?dn:pl;
    dir=c[i]>nu?1:c[i]<nl?-1:dir;
    pu=nu; pl=nl;
  }
  return {val:dir===1?pl:pu, dir};
}

// ══════════════════════════════════════════
//  حساب الإشارة
// ══════════════════════════════════════════
function computeSig(){
  const p = S.price;
  if(!p || p===0) return {isBuy:false,isSell:false,bs:0,ss:0,bScore:0,sScore:0,bPct:0,sPct:0,bLabels:[],sLabels:[],conviction:0};

  // ══════════════════════════════════════════════════════
  // نظام إشارات Intraday SPX — مؤشرات موزونة احترافياً
  // المجموع الأقصى = 15 نقطة
  // ══════════════════════════════════════════════════════

  // ─── شروط الشراء CALL ───────────────────────────────
  const bc = [
    // SuperTrend صاعد — الأقوى (وزن 3)
    { pass: S.stD === 1,
      w:3, label:'SuperTrend↑' },

    // السعر فوق VWAP — مهم جداً للإنترادي (وزن 3)
    { pass: S.vwap>0 && p > S.vwap,
      w:3, label:'P>VWAP' },

    // EMA9 فوق EMA21 — زخم قصير المدى (وزن 2)
    { pass: S.ema9>0 && S.ema9 > S.ema21,
      w:2, label:'EMA9>EMA21' },

    // MACD تقاطع صاعد — تأكيد الزخم (وزن 2)
    { pass: S.macd > S.msig && S.mhist > 0,
      w:2, label:'MACD↑' },

    // RSI مناسب للشراء 40-65 (ليس في ذروة شراء) (وزن 2)
    { pass: S.rsi >= 40 && S.rsi <= 65,
      w:2, label:'RSI_zone' },

    // Bollinger — السعر في النصف السفلي (وزن 2)
    { pass: S.bbB>0 && p < S.bbB,
      w:2, label:'P<BB_mid' },

    // EMA21 > EMA50 — اتجاه عام صاعد (وزن 1)
    { pass: S.ema21 > S.ema50,
      w:1, label:'EMA21>50' },
  ];

  // ─── شروط البيع PUT ────────────────────────────────
  const sc = [
    // SuperTrend هابط — الأقوى (وزن 3)
    { pass: S.stD === -1,
      w:3, label:'SuperTrend↓' },

    // السعر تحت VWAP — مهم جداً للإنترادي (وزن 3)
    { pass: S.vwap>0 && p < S.vwap,
      w:3, label:'P<VWAP' },

    // EMA9 تحت EMA21 — زخم هابط (وزن 2)
    { pass: S.ema9>0 && S.ema9 < S.ema21,
      w:2, label:'EMA9<EMA21' },

    // MACD تقاطع هابط — تأكيد الزخم (وزن 2)
    { pass: S.macd < S.msig && S.mhist < 0,
      w:2, label:'MACD↓' },

    // RSI في منطقة البيع 55-80 (وزن 2)
    { pass: S.rsi >= 55 && S.rsi <= 80,
      w:2, label:'RSI_zone' },

    // Bollinger — السعر في النصف العلوي (وزن 2)
    { pass: S.bbB>0 && p > S.bbB,
      w:2, label:'P>BB_mid' },

    // EMA21 < EMA50 — اتجاه عام هابط (وزن 1)
    { pass: S.ema21 < S.ema50,
      w:1, label:'EMA21<50' },
  ];

  // ─── حساب النقاط ────────────────────────────────────
  const bPassed = bc.filter(c=>c.pass);
  const sPassed = sc.filter(c=>c.pass);
  const bScore  = bPassed.reduce((s,c)=>s+c.w, 0);
  const sScore  = sPassed.reduce((s,c)=>s+c.w, 0);
  const bCount  = bPassed.length;
  const sCount  = sPassed.length;
  const maxScore= 15;
  const bPct    = Math.round(bScore/maxScore*100);
  const sPct    = Math.round(sScore/maxScore*100);
  const bLabels = bPassed.map(c=>c.label);
  const sLabels = sPassed.map(c=>c.label);

  // ─── شرط الإشارة ────────────────────────────────────
  // يجب: نقاط >= 7 (من 15) + شروط >= 3 + أقوى من الاتجاه المعاكس
  // SuperTrend أو VWAP يجب أن يكون من الشروط المتحققة
  const bHasCore = bPassed.some(c=>c.label==='SuperTrend↑'||c.label==='P>VWAP');
  const sHasCore = sPassed.some(c=>c.label==='SuperTrend↓'||c.label==='P<VWAP');

  const isBuy  = bScore>=7 && bCount>=3 && bScore>sScore && bHasCore;
  const isSell = sScore>=7 && sCount>=3 && sScore>bScore && sHasCore;

  return {
    isBuy, isSell,
    bs:bCount, ss:sCount,
    bScore, sScore, bPct, sPct, maxScore,
    bLabels, sLabels,
    conviction: isBuy ? bPct : isSell ? sPct : 0
  };
}

// ══════════════════════════════════════════
//  جلب الأسعار — Yahoo Finance
//  يشمل: رسمي + Pre-Market + After-Hours
// ══════════════════════════════════════════
const YH  = 'https://query1.finance.yahoo.com';
const YH2 = 'https://query2.finance.yahoo.com';
const UA  = {
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept':'application/json',
  'Accept-Language':'en-US,en;q=0.9',
};

// ── جلب السعر الحي — يجرب 3 endpoints مختلفة
async function fetchLivePrice(sym) {
  const hdrs = {'User-Agent':'Mozilla/5.0','Accept':'application/json'};
  const symFH = sym==='^GSPC' ? 'SPX' : sym.replace('^','');
  const symAV = sym==='^GSPC' ? 'SPY' : sym.replace('^','');
  const encoded = encodeURIComponent(sym);

  // 1. Finnhub — الأفضل للـ Pre/After (رمز SPX بدون ^)
  const FINNHUB_KEY = process.env.FINNHUB_KEY || RUNTIME_KEYS.finnhub || '';
  if(FINNHUB_KEY) {
    try {
      const r = await fetch(
        'https://finnhub.io/api/v1/quote?symbol='+symFH+'&token='+FINNHUB_KEY,
        {signal:AbortSignal.timeout(5000)}
      );
      if(r.ok) {
        const d = await r.json();
        if(d && d.c && d.c > 0) {
          const price=d.c, prev=d.pc||d.c, chg=price-prev, pct=prev?chg/prev*100:0;
          const now=new Date();
          const etH=((now.getUTCHours()-4+24)%24)+now.getUTCMinutes()/60;
          const day=now.getUTCDay();
          let state='CLOSED', isExt=false;
          if(day>=1&&day<=5){
            if(etH>=4&&etH<9.5)   {state='PRE';     isExt=true;}
            else if(etH>=9.5&&etH<16){state='REGULAR';isExt=false;}
            else if(etH>=16&&etH<20) {state='POST';   isExt=true;}
          }
          log('[Finnhub OK] SPX='+price.toFixed(2)+' state='+state);
          return {price,isExt,state,change:chg,changePct:pct,
                  high:d.h||price,low:d.l||price,open:d.o||price,prev,source:'Finnhub'};
        }
        log('[Finnhub] empty response: '+JSON.stringify(d));
      } else { log('[Finnhub] HTTP '+r.status); }
    } catch(e){ log('[Finnhub ERR] '+e.message); }
  } else {
    log('[Finnhub] FINNHUB_KEY missing — add to Render env vars');
  }

  // 2. Yahoo Finance v7 — Pre/After مدعوم
  for(const base of ['https://query1.finance.yahoo.com','https://query2.finance.yahoo.com']) {
    try {
      const fields='regularMarketPrice,preMarketPrice,postMarketPrice,marketState,regularMarketDayHigh,regularMarketDayLow,regularMarketOpen,regularMarketPreviousClose,regularMarketChange,regularMarketChangePercent,preMarketChange,preMarketChangePercent,postMarketChange,postMarketChangePercent';
      const r=await fetch(base+'/v7/finance/quote?symbols='+encoded+'&fields='+fields,
        {headers:hdrs,signal:AbortSignal.timeout(6000)});
      if(!r.ok) continue;
      const qt=(await r.json())?.quoteResponse?.result?.[0];
      if(!qt) continue;
      const state=qt.marketState||'REGULAR';
      const isPre=state==='PRE'||state==='PREPRE';
      const isPost=state==='POST'||state==='POSTPOST';
      let price=qt.regularMarketPrice,chg=qt.regularMarketChange||0,pct=qt.regularMarketChangePercent||0;
      if(isPre&&qt.preMarketPrice)   {price=qt.preMarketPrice;  chg=qt.preMarketChange||0; pct=qt.preMarketChangePercent||0;}
      if(isPost&&qt.postMarketPrice) {price=qt.postMarketPrice; chg=qt.postMarketChange||0;pct=qt.postMarketChangePercent||0;}
      if(!price) continue;
      log('[Yahoo v7 OK] SPX='+price.toFixed(2)+' state='+state);
      return {price,isExt:isPre||isPost,state,change:chg,changePct:pct,
              high:qt.regularMarketDayHigh||price,low:qt.regularMarketDayLow||price,
              open:qt.regularMarketOpen||price,prev:qt.regularMarketPreviousClose||price,source:'Yahoo_v7'};
    } catch(e){ log('[Yahoo v7 ERR] '+e.message); }
  }

  // 3. Yahoo v8 chart meta
  try {
    const r=await fetch('https://query2.finance.yahoo.com/v8/finance/chart/'+encoded+'?interval=1m&range=1d',
      {headers:hdrs,signal:AbortSignal.timeout(6000)});
    if(r.ok){
      const meta=(await r.json())?.chart?.result?.[0]?.meta;
      if(meta?.regularMarketPrice){
        const state=meta.marketState||'REGULAR';
        const isPre=state==='PRE', isPost=state==='POST'||state==='POSTPOST';
        let price=meta.regularMarketPrice;
        if(isPre&&meta.preMarketPrice)   price=meta.preMarketPrice;
        if(isPost&&meta.postMarketPrice) price=meta.postMarketPrice;
        const prev=meta.previousClose||price;
        log('[Yahoo v8 OK] SPX='+price.toFixed(2)+' state='+state);
        return {price,isExt:isPre||isPost,state,
                change:price-prev,changePct:prev?(price-prev)/prev*100:0,
                high:meta.regularMarketDayHigh||price,low:meta.regularMarketDayLow||price,
                open:meta.regularMarketOpen||price,prev,source:'Yahoo_v8'};
      }
    }
  } catch(e){ log('[Yahoo v8 ERR] '+e.message); }

  // 4. Alpha Vantage
  const AV_KEY=process.env.ALPHAVANTAGE_KEY||RUNTIME_KEYS.alphavantage||'';
  if(AV_KEY){
    try{
      const r=await fetch('https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol='+symAV+'&apikey='+AV_KEY,
        {signal:AbortSignal.timeout(8000)});
      if(r.ok){
        const q=(await r.json())?.['Global Quote'];
        if(q&&q['05. price']){
          const mult=sym==='^GSPC'?10:1;
          const price=parseFloat(q['05. price'])*mult;
          const prev=parseFloat(q['08. previous close'])*mult;
          log('[AlphaVantage OK] '+symAV+'='+price.toFixed(2));
          return {price,isExt:false,state:'REGULAR',
                  change:parseFloat(q['09. change'])*mult,
                  changePct:parseFloat(q['10. change percent']),
                  high:parseFloat(q['03. high'])*mult||price,
                  low:parseFloat(q['04. low'])*mult||price,
                  open:parseFloat(q['02. open'])*mult||price,
                  prev,source:'AlphaVantage'};
        }
      }
    }catch(e){log('[AlphaVantage ERR] '+e.message);}
  }

  // 5. Stooq — آخر ملجأ (15 دقيقة مؤخر)
  try{
    const r=await fetch('https://stooq.com/q/l/?s=^spx&f=sd2t2ohlcv&h&e=json',
      {signal:AbortSignal.timeout(7000)});
    if(r.ok){
      const row=(await r.json())?.symbols?.[0];
      if(row&&row.close>0){
        const price=row.close, prev=row.open||price;
        log('[Stooq OK] SPX='+price.toFixed(2)+' (15min delayed)');
        return {price,isExt:false,state:'DELAYED',
                change:price-prev,changePct:prev?(price-prev)/prev*100:0,
                high:row.high||price,low:row.low||price,open:row.open||price,prev,source:'Stooq_15min'};
      }
    }
  }catch(e){log('[Stooq ERR] '+e.message);}

  log('ALL SOURCES FAILED');
  return null;
}

async function fetchHist(sym){
  // يجرب query1 ثم query2
  for(const base of [YH, YH2]) {
    try {
      const r = await fetch(`${base}/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=300d`,{headers:UA});
      if(r.ok) {
        const d = await r.json();
        const result = d?.chart?.result?.[0];
        if(result) return result;
      }
    } catch(e){ log(`fetchHist ${base} failed: ${e.message}`); }
  }
  return null;
}

async function loadMarketData(){
  try{
    // ── جلب تاريخي (للمؤشرات)
    const hist = await fetchHist('^GSPC');
    if(!hist) throw new Error('Yahoo Finance لم يرجع بيانات — تحقق من الاتصال');
    const q    = hist.indicators.quote[0];
    const closes = q.close.filter(Boolean);
    const highs  = q.high.filter(Boolean);
    const lows   = q.low.filter(Boolean);
    const vols   = q.volume.filter(Boolean);
    const m      = hist.meta;

    // ── السعر الحي حسب حالة السوق (يشمل Pre/After-Hours)
    let livePrice = m.regularMarketPrice || closes.at(-1);
    let mktState  = 'REGULAR';
    let mktLabel  = '🟢 رسمي';
    try{
      const qt = await fetchLivePrice('^GSPC');
      if(qt){
        mktState = qt.marketState || 'REGULAR';
        // أولوية: Pre-Market → After-Hours → Regular
        if((mktState==='PRE'||mktState==='PREPRE') && qt.preMarketPrice) {
          livePrice = qt.preMarketPrice;
          mktLabel  = '🌅 Pre-Market';
        } else if((mktState==='POST'||mktState==='POSTPOST') && qt.postMarketPrice) {
          livePrice = qt.postMarketPrice;
          mktLabel  = '🌙 After-Hours';
        } else if(mktState==='CLOSED') {
          // السوق مغلق — استخدم آخر سعر رسمي
          livePrice = qt.regularMarketPrice || m.regularMarketPrice || closes.at(-1);
          mktLabel  = '🔴 مغلق';
        } else if(mktState==='CLOSED') {
          livePrice = qt.regularMarketPrice || m.regularMarketPrice || closes.at(-1);
          mktLabel  = '🔴 مغلق';
        } else {
          livePrice = qt.regularMarketPrice || livePrice;
          mktLabel  = '🟢 رسمي';
        }
        // تحديث High/Low من البيانات الحية
        if(qt.regularMarketDayHigh) S.high = qt.regularMarketDayHigh;
        if(qt.regularMarketDayLow)  S.low  = qt.regularMarketDayLow;
        if(qt.regularMarketOpen)    S.open = qt.regularMarketOpen;
        if(qt.regularMarketPreviousClose) S.prev = qt.regularMarketPreviousClose;
      }
    }catch(e){ log('fetchLivePrice error: '+e.message); }

    // ── تعبئة S
    S.price    = livePrice;
    S.prev     = m.previousClose || closes.at(-2) || closes.at(-1);
    S.open     = m.regularMarketOpen   || S.prev;
    S.high     = m.regularMarketDayHigh|| S.price;
    S.low      = m.regularMarketDayLow || S.price;
    S.vol      = vols.at(-1) || 0;
    S.mktState  = mktState;
    S.isExt     = (mktState==='PRE'||mktState==='PREPRE'||mktState==='POST'||mktState==='POSTPOST');
    S.dataSource= qt?.source || 'Yahoo';
    S.history  = closes;

    const c=closes.slice(-300), h=highs.slice(-300), l=lows.slice(-300);
    const rv=calcRSI(c);   S.rsi=rv.at(-1)||50;
    const mv=calcMACD(c);  S.macd=mv.macd; S.msig=mv.signal; S.mhist=mv.hist;
    const sv=calcStoch(c); S.sk=sv.k; S.sd=sv.d;
    const bv=calcBB(c);    S.bbU=bv.upper; S.bbL=bv.lower; S.bbB=bv.basis;
    S.atr = calcATR(h,l,c);
    const st=calcST(highs.slice(-100),lows.slice(-100),closes.slice(-100));
    S.stV=st.val; S.stD=st.dir;
    const e9=ema(c,9),e21=ema(c,21),e50=ema(c,50),e200=ema(c,200);
    S.ema9=e9.at(-1)||0; S.ema21=e21.at(-1)||0; S.ema50=e50.at(-1)||0; S.ema200=e200.at(-1)||0;
    // VWAP تقريبي من اليومي (السعر × الحجم / الحجم الكلي آخر 20 شمعة)
    const vwSlice=20, vwC=closes.slice(-vwSlice), vwV=vols.slice(-vwSlice);
    const vwNum=vwC.reduce((s,p,i)=>s+p*(vwV[i]||1),0);
    const vwDen=vwV.reduce((s,v)=>s+(v||1),0);
    S.vwap = vwDen>0 ? vwNum/vwDen : S.price;
    const vAvg=vols.slice(-21,-1).reduce((a,b)=>a+b,0)/20||1;
    S.volR=(vols.at(-1)||0)/vAvg;
    let obv=0; const oa=[];
    for(let i=1;i<Math.min(closes.length,vols.length);i++){
      obv+=closes[i]>closes[i-1]?vols[i]:closes[i]<closes[i-1]?-vols[i]:0;
      oa.push(obv);
    }
    const oe=ema(oa,21); S.obv=oa.at(-1)||0; S.obvE=oe.at(-1)||0;
    S.fibH=Math.max(...highs.slice(-100)); S.fibL=Math.min(...lows.slice(-100));

    log(`📊 SPX:${S.price.toFixed(2)} RSI:${S.rsi.toFixed(1)} ST:${S.stD===1?'▲':'▼'} [${mktState}] ${mktLabel}`);
    return true;
  }catch(e){
    log(`❌ fetchError: ${e.message}`);
    return false;
  }
}

// ══════════════════════════════════════════
//  إرسال تيليجرام
// ══════════════════════════════════════════
async function tg(text){
  if(!TG_TOKEN||!TG_CHAT){ log('⚠️ TG غير مضبوط'); return; }
  try{
    const r=await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({chat_id:TG_CHAT,text,parse_mode:'HTML'})
    });
    const d=await r.json();
    d.ok ? log('✅ TG sent') : log(`❌ TG: ${d.description}`);
  }catch(e){ log(`❌ TG err: ${e.message}`); }
}

// ══════════════════════════════════════════
//  8 أنواع التنبيهات
// ══════════════════════════════════════════

// 1 ── دخول
async function alertEntry(type,score){
  const p=S.price,atr=S.atr,d=type==='BUY'?1:-1,isL=d===1;
  const tp1=p+d*atr, tp2=p+d*atr*2, tp3=p+d*atr*3.5, sl=p-d*atr*0.7;
  Object.assign(TRADE,{active:true,type,entry:p,atr,tp1,tp2,tp3,sl,trailSl:sl,score,
    tp1Hit:false,tp2Hit:false,nearTp1:false,nearTp2:false,slWarned:false,openedAt:new Date()});
  await tg(
`${isL?'🚀':'🔻'} <b>NEXUS v7 — دخول ${isL?'LONG شراء':'SHORT بيع'}</b>

📊 <b>S&P 500 · SPX</b>
💰 الدخول: <b>${fmt(p)}</b>
${mktLn()}
✅ قوة الإشارة: <b>${score}/7</b>

🎯 <b>الأهداف:</b>
├ TP1: <b>${fmt(tp1)}</b> (${fmtP((tp1-p)/p*100)})
├ TP2: <b>${fmt(tp2)}</b> (${fmtP((tp2-p)/p*100)})
└ TP3: <b>${fmt(tp3)}</b> (${fmtP((tp3-p)/p*100)})

🛑 وقف: <b>${fmt(sl)}</b> (${fmtP((sl-p)/p*100)})
📏 R:R = 1:${(Math.abs(tp2-p)/Math.abs(sl-p)).toFixed(1)}
⏰ ${nowAr()}
⚠️ <i>ليست نصيحة مالية</i>`);
  log(`📤 Entry ${type}@${fmt(p)} score${score}`);
}

// 2 ── إلغاء
async function alertCancel(reason){
  if(!canAlert('cancel',300)) return;
  const p=S.price;
  await tg(
`⛔ <b>NEXUS v7 — إلغاء</b>

🔄 <b>${reason}</b>
📊 SPX: <b>${fmt(p)}</b>
${TRADE.active?`📍 دخولك: <b>${fmt(TRADE.entry)}</b> · P&L: <b>${fmtP((p-TRADE.entry)/TRADE.entry*100)}</b>`:''}
${mktLn()}
⏰ ${nowAr()}`);
}

// 3 ── اقتراب هدف
async function alertNearTP(n,tp){
  if(!canAlert('nearTP'+n,180)) return;
  const p=S.price,d=TRADE.type==='BUY'?1:-1;
  const pnl=(p-TRADE.entry)*d;
  await tg(
`🔔 <b>NEXUS v7 — اقتراب الهدف ${n}</b>

📊 SPX: <b>${fmt(p)}</b> → <b>${fmt(tp)}</b>
📍 باقي: <b>${Math.abs(tp-p).toFixed(1)} نقطة</b>
💹 P&L: <b>${fmtP(pnl/TRADE.entry*100)}</b>
💡 حرّك SL إلى نقطة التعادل
⏰ ${nowAr()}`);
}

// 4 ── اختراق هدف
async function alertTPHit(n,tp){
  if(!canAlert('tpHit'+n, n<3?600:900)) return;
  const p=S.price,d=TRADE.type==='BUY'?1:-1;
  const pnl=(p-TRADE.entry)*d;
  if(n===1) TRADE.trailSl=TRADE.entry;
  if(n===2) TRADE.trailSl=TRADE.tp1;
  const advice=n===1?'احجز 40% · SL إلى التعادل':n===2?'احجز 35% إضافية (75%) · SL فوق TP1':'احجز الكل 🎉';
  const next=n===1?TRADE.tp2:n===2?TRADE.tp3:null;
  await tg(
`${n===1?'🎯':n===2?'🏆':'🔥'} <b>NEXUS v7 — الهدف ${n} ✅</b>

📊 SPX: <b>${fmt(p)}</b> تجاوز <b>${fmt(tp)}</b>
💹 الربح: <b>+${fmtP(pnl/TRADE.entry*100)}</b>
⏱ ${TRADE.openedAt?Math.round((Date.now()-TRADE.openedAt)/60000)+' دقيقة':'--'}

💡 <b>${advice}</b>
${next?`📍 التالي: <b>${fmt(next)}</b>`:'🏁 <b>كل الأهداف!</b>'}
⏰ ${nowAr()}`);
}

// 5 ── تحصيل ربح
async function alertTakeProfit(reason){
  if(!canAlert('tp',240)) return;
  const p=S.price,d=TRADE.type==='BUY'?1:-1;
  const pnl=(p-TRADE.entry)*d;
  await tg(
`💰 <b>NEXUS v7 — تحصيل الربح</b>

📌 <b>${reason}</b>
📊 SPX: <b>${fmt(p)}</b> (دخول: ${fmt(TRADE.entry)})
💹 <b>${fmtP(pnl/TRADE.entry*100)}</b>
⏱ ${TRADE.openedAt?Math.round((Date.now()-TRADE.openedAt)/60000)+' دقيقة':'--'}
✅ أغلق وانتظر إشارة جديدة
⏰ ${nowAr()}`);
}

// 6 ── كسر وقف الخسارة
async function alertSLBroken(){
  if(!canAlert('sl',600)) return;
  const p=S.price,d=TRADE.type==='BUY'?1:-1;
  const loss=(p-TRADE.entry)*d;
  TRADE.active=false;
  await tg(
`🚨 <b>NEXUS v7 — كُسر وقف الخسارة!</b>

📊 SPX: <b>${fmt(p)}</b> كسر <b>${fmt(TRADE.trailSl||TRADE.sl)}</b>
💸 خسارة: <b>${fmtP(loss/TRADE.entry*100)}</b>
⏱ ${TRADE.openedAt?Math.round((Date.now()-TRADE.openedAt)/60000)+' دقيقة':'--'}

🛑 <b>أغلق فوراً — لا تتردد!</b>
⏰ ${nowAr()}`);
}

// 7 ── خروج
async function alertExit(reason){
  if(!canAlert('exit',300)) return;
  const p=S.price,d=TRADE.type==='BUY'?1:-1;
  const pnl=(p-TRADE.entry)*d;
  TRADE.active=false;
  await tg(
`${pnl>0?'✅':'⚠️'} <b>NEXUS v7 — خروج</b>

📌 <b>${reason}</b>
📊 SPX: <b>${fmt(p)}</b> (دخول: ${fmt(TRADE.entry)})
💹 <b>${fmtP(pnl/TRADE.entry*100)}</b>
⏱ ${TRADE.openedAt?Math.round((Date.now()-TRADE.openedAt)/60000)+' دقيقة':'--'}
⏸ انتظر الإشارة التالية
⏰ ${nowAr()}`);
}

// 8 ── إعادة دخول
async function alertReEntry(type,score,reason){
  if(!canAlert('reEntry',300)) return;
  const p=S.price,atr=S.atr,d=type==='BUY'?1:-1,isL=d===1;
  const tp1=p+d*atr, tp2=p+d*atr*2, sl=p-d*atr*0.7;
  Object.assign(TRADE,{active:true,type,entry:p,atr,tp1,tp2,tp3:p+d*atr*3.5,sl,trailSl:sl,
    score,tp1Hit:false,tp2Hit:false,nearTp1:false,nearTp2:false,slWarned:false,openedAt:new Date()});
  await tg(
`🔁 <b>NEXUS v7 — إعادة دخول ${isL?'LONG':'SHORT'}</b>

📌 <b>${reason}</b>
📊 SPX: <b>${fmt(p)}</b>
✅ قوة: <b>${score}/7</b>
🎯 TP1: <b>${fmt(tp1)}</b> · TP2: <b>${fmt(tp2)}</b>
🛑 SL: <b>${fmt(sl)}</b>
⏰ ${nowAr()}`);
}

// ══════════════════════════════════════════
//  المراقبة الذكية
// ══════════════════════════════════════════
async function checkAlerts(){
  const {isBuy,isSell,bs,ss,bScore,sScore,bPct,sPct,bLabels,sLabels,conviction}=computeSig();
  const cur=isBuy?'BUY':isSell?'SELL':'WAIT';
  const score=isBuy?bScore:isSell?sScore:0;
  const p=S.price, prev=S.lastSig;

  if(TRADE.active){
    const isL=TRADE.type==='BUY', d=isL?1:-1;
    const asl=TRADE.trailSl||TRADE.sl;

    // SL كُسر
    if((isL&&p<=asl)||(!isL&&p>=asl)){ await alertSLBroken(); return; }

    // اقتراب SL
    const slLeft=Math.abs(p-asl), slDist=Math.abs(TRADE.entry-TRADE.sl);
    if(!TRADE.slWarned&&slLeft<slDist*0.25){
      TRADE.slWarned=true;
      if(canAlert('slWarn',120))
        await tg(`⚠️ <b>NEXUS v7 — تحذير SL</b>\n\nSPX: <b>${fmt(p)}</b>\n🛑 الوقف: <b>${fmt(asl)}</b>\nمتبقي: <b>${slLeft.toFixed(1)} نقطة</b>\n⏰ ${nowAr()}`);
    }

    // TP1
    const tp1Dist=Math.abs(TRADE.tp1-TRADE.entry);
    if(!TRADE.nearTp1&&!TRADE.tp1Hit&&Math.abs(TRADE.tp1-p)<tp1Dist*0.25){TRADE.nearTp1=true;await alertNearTP(1,TRADE.tp1);}
    if(!TRADE.tp1Hit&&((isL&&p>=TRADE.tp1)||(!isL&&p<=TRADE.tp1))){TRADE.tp1Hit=true;await alertTPHit(1,TRADE.tp1);}

    // TP2
    if(TRADE.tp1Hit){
      const tp2Dist=Math.abs(TRADE.tp2-TRADE.tp1);
      if(!TRADE.nearTp2&&!TRADE.tp2Hit&&Math.abs(TRADE.tp2-p)<tp2Dist*0.25){TRADE.nearTp2=true;await alertNearTP(2,TRADE.tp2);}
      if(!TRADE.tp2Hit&&((isL&&p>=TRADE.tp2)||(!isL&&p<=TRADE.tp2))){TRADE.tp2Hit=true;await alertTPHit(2,TRADE.tp2);}
    }

    // TP3
    if(TRADE.tp2Hit&&((isL&&p>=TRADE.tp3)||(!isL&&p<=TRADE.tp3))&&canAlert('tp3',900))
      await alertTPHit(3,TRADE.tp3);

    // انعكاس
    if(cur!=='WAIT'&&cur!==TRADE.type){
      await alertCancel(`انعكاس إلى ${cur==='BUY'?'شراء 🟢':'بيع 🔴'}`);
      if(TRADE.tp1Hit) await alertTakeProfit('انعكاس بعد TP1');
      else await alertExit('انعكاس قبل الأهداف');
    }

    // ضعف بعد TP1
    if(cur===TRADE.type&&score<=2&&TRADE.tp1Hit&&canAlert('weak',300))
      await alertTakeProfit(`ضعف الإشارة (${score}/7)`);

  } else {
    // دخول جديد
    if((isBuy||isSell)&&cur!==prev&&score>=3&&(!TRADE.type||TRADE.type!==cur))
      await alertEntry(cur,score);

    // إعادة دخول
    if((isBuy||isSell)&&TRADE.type&&cur===TRADE.type&&score>=4){
      const since=TRADE.openedAt?(Date.now()-TRADE.openedAt)/60000:999;
      if(since>5&&canAlert('reEntry',240))
        await alertReEntry(cur,score,`عودة إشارة ${cur==='BUY'?'الشراء':'البيع'} (${score}/7)`);
    }
  }

  S.lastSig=cur; S.lastScore=score;
}

// ══════════════════════════════════════════
//  تحديث ذكي حسب الوقت
// ══════════════════════════════════════════
function getInterval(){
  const et=new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
  const m=et.getHours()*60+et.getMinutes(), wd=et.getDay();
  if(wd===0||wd===6)             return 15*60*1000; // عطلة
  if(m>=570&&m<960)              return 30*1000;    // رسمي 9:30-4م
  if((m>=240&&m<570)||(m>=960&&m<1200)) return 2*60*1000; // Pre/After
  return 10*60*1000; // ليل
}

// ══════════════════════════════════════════
//  الحلقة الرئيسية
// ══════════════════════════════════════════
async function mainLoop(){
  log('🔄 جلب البيانات...');
  if(await loadMarketData()) await checkAlerts();
  const iv=getInterval();
  log(`⏱ التالي: ${Math.round(iv/1000)}ث`);
  setTimeout(mainLoop,iv);
}

// ══════════════════════════════════════════
//  منع السبات — Self-Ping كل 14 دقيقة
// ══════════════════════════════════════════
function keepAlive(){
  const url=process.env.RENDER_EXTERNAL_URL;
  if(!url){ log('💤 RENDER_EXTERNAL_URL غير موجود — self-ping معطّل'); return; }
  setInterval(async()=>{
    try{
      const r=await fetch(`${url}/ping`);
      const d=await r.json();
      log(`💓 ping ✅ uptime:${d.uptime}`);
    }catch(e){ log(`💓 ping ⚠️ ${e.message}`); }
  }, 14*60*1000);
  log(`💓 Self-ping → ${url}/ping`);
}

// ══════════════════════════════════════════
//  API Endpoints
// ══════════════════════════════════════════

// البيانات الحية للداشبورد
app.get('/api/market',(req,res)=>{
  const {isBuy,isSell,bs,ss}=computeSig();
  res.json({
    price:S.price, prev:S.prev, open:S.open, high:S.high, low:S.low,
    vol:S.vol, volR:S.volR, mktState:S.mktState,
    rsi:S.rsi, macd:S.macd, msig:S.msig, mhist:S.mhist,
    sk:S.sk, sd:S.sd, bbU:S.bbU, bbL:S.bbL, bbB:S.bbB,
    atr:S.atr, stV:S.stV, stD:S.stD,
    ema9:S.ema9, ema21:S.ema21, ema50:S.ema50, ema200:S.ema200, vwap:S.vwap,
    obv:S.obv, obvE:S.obvE, fibH:S.fibH, fibL:S.fibL,
    isExt:S.isExt||false, dataSource:S.dataSource||'Yahoo',
    history:S.history.slice(-300),
    sig:{isBuy,isSell,bs,ss,bScore,sScore,bPct,sPct,bLabels,sLabels,conviction},
    trade:{
      active:TRADE.active, type:TRADE.type, entry:TRADE.entry,
      tp1:TRADE.tp1, tp2:TRADE.tp2, tp3:TRADE.tp3,
      sl:TRADE.sl, trailSl:TRADE.trailSl,
      tp1Hit:TRADE.tp1Hit, tp2Hit:TRADE.tp2Hit, score:TRADE.score,
      since:TRADE.openedAt?Math.round((Date.now()-TRADE.openedAt)/60000):0,
    },
    updatedAt:new Date().toISOString(),
    dataSource:S.dataSource||'Yahoo',
  });
});

// ── استقبال مفاتيح API من الداشبورد وحفظها في السيرفر
// بدلاً من Render env vars — المفاتيح تُرسَل مرة واحدة وتبقى في الذاكرة
const RUNTIME_KEYS = { finnhub: '', alphavantage: '' };

app.post('/api/keys',(req,res)=>{
  const {finnhub, alphavantage} = req.body || {};
  if(finnhub)      { RUNTIME_KEYS.finnhub      = finnhub;      log('🔑 Finnhub key received'); }
  if(alphavantage) { RUNTIME_KEYS.alphavantage  = alphavantage; log('🔑 AlphaVantage key received'); }
  res.json({ok:true, hasFinnhub:!!RUNTIME_KEYS.finnhub, hasAV:!!RUNTIME_KEYS.alphavantage});
});

app.get('/api/keys/status',(req,res)=>{
  res.json({
    hasFinnhub:    !!RUNTIME_KEYS.finnhub      || !!process.env.FINNHUB_KEY,
    hasAV:         !!RUNTIME_KEYS.alphavantage  || !!process.env.ALPHAVANTAGE_KEY,
    source:        'runtime'
  });
});

// Keep-alive ping
// ══ أخبار مالية حية — 5 مصادر عربية وإنجليزية ══
const NEWS_CACHE = { data:[], ts:0 };
const NEWS_TTL   = 10 * 60 * 1000; // 10 دقائق

async function fetchRSS(url, src, lang) {
  try {
    const r = await fetch(url, {
      headers: {'User-Agent':'Mozilla/5.0','Accept':'application/rss+xml,text/xml,*/*'},
      signal: AbortSignal.timeout(7000)
    });
    if(!r.ok) { log(`[News] ${src} HTTP ${r.status}`); return []; }
    const xml = await r.text();
    // parse RSS items
    const items = [];
    const itemRx = /<item[^>]*>([\s\S]*?)<\/item>/gi;
    let m;
    while((m = itemRx.exec(xml)) !== null && items.length < 5) {
      const block = m[1];
      const title = (block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1]?.trim() || '';
      const link  = (block.match(/<link[^>]*>([^<]+)<\/link>/)  || block.match(/<link[^>]*href="([^"]+)"/)  || [])[1]?.trim() || '';
      const date  = (block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/) || block.match(/<dc:date[^>]*>([\s\S]*?)<\/dc:date>/) || [])[1]?.trim() || '';
      const desc  = ((block.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/) || [])[1] || '')
                    .replace(/<[^>]+>/g,'').trim().slice(0,120);
      if(title.length > 5) {
        items.push({ title, link, date, desc, src, lang,
          ts: date ? new Date(date).getTime() : Date.now() });
      }
    }
    log(`[News] ${src}: ${items.length} items`);
    return items;
  } catch(e) { log(`[News] ${src} ERR: ${e.message}`); return []; }
}

async function fetchAllNews() {
  if(Date.now() - NEWS_CACHE.ts < NEWS_TTL && NEWS_CACHE.data.length > 0)
    return NEWS_CACHE.data;

  const feeds = [
    // ══ مصادر عربية حصراً ══
    { url:'https://www.argaam.com/ar/rss/feeds/1',                              src:'أرقام',        lang:'ar' },
    { url:'https://arabic.cnbc.com/id/100727362/device/rss/rss.html',           src:'CNBC عربية',   lang:'ar' },
    { url:'https://arabic.reuters.com/rssFeed/businessNews',                     src:'رويترز عربي',  lang:'ar' },
    { url:'https://www.alarabiya.net/alandalus/rss.xml',                         src:'العربية',      lang:'ar' },
    { url:'https://www.mubasher.info/news/rss?topics=markets',                   src:'مباشر',        lang:'ar' },
    { url:'https://al-ain.com/rss/economy',                                      src:'العين الاقتصادي', lang:'ar' },
    { url:'https://www.alborsanews.com/feed',                                    src:'البورصة نيوز',  lang:'ar' },
  ];

  const results = await Promise.allSettled(
    feeds.map(f => fetchRSS(f.url, f.src, f.lang))
  );

  let all = [];
  results.forEach(r => { if(r.status==='fulfilled') all = all.concat(r.value); });
  // ترتيب حسب التاريخ (الأحدث أولاً)
  all.sort((a,b) => (b.ts||0) - (a.ts||0));

  NEWS_CACHE.data = all.slice(0, 30);
  NEWS_CACHE.ts   = Date.now();
  log(`[News] Total: ${NEWS_CACHE.data.length} items from ${feeds.length} sources`);
  return NEWS_CACHE.data;
}

// ── API endpoint للأخبار
app.get('/api/news', async(req,res) => {
  try {
    const news = await fetchAllNews();
    res.json({ ok:true, count:news.length, news, ts:Date.now() });
  } catch(e) {
    res.status(500).json({ ok:false, error:e.message, news:[] });
  }
});

// ── API endpoint للتقويم الاقتصادي (Finnhub إذا وُجد المفتاح)
app.get('/api/calendar', async(req,res) => {
  try {
    const FHK = process.env.FINNHUB_KEY || RUNTIME_KEYS.finnhub || '';
    if(!FHK) { res.json({ok:false, msg:'FINNHUB_KEY مطلوب', events:[]}); return; }
    const today = new Date().toISOString().split('T')[0];
    const r = await fetch(
      `https://finnhub.io/api/v1/calendar/economic?from=${today}&to=${today}&token=${FHK}`,
      {signal:AbortSignal.timeout(6000)}
    );
    if(!r.ok) { res.json({ok:false, msg:'HTTP '+r.status, events:[]}); return; }
    const d = await r.json();
    res.json({ok:true, events: d.economicCalendar || []});
  } catch(e) {
    res.json({ok:false, error:e.message, events:[]});
  }
});

app.get('/ping',(req,res)=>res.json({
  status:'ok', price:S.price, sig:S.lastSig,
  trade:TRADE.active, uptime:Math.round(process.uptime())+'s'
}));

// ══════════════════════════════════════════
//  بدء التشغيل
// ══════════════════════════════════════════
// ── تحميل البيانات أولاً ثم بدء السيرفر
(async()=>{
  log('⏳ تحميل البيانات الأولية...');
  // محاولتان قبل البدء
  let loaded = await loadMarketData();
  if(!loaded) {
    log('⚠️ المحاولة الأولى فشلت — إعادة المحاولة...');
    await new Promise(r=>setTimeout(r,3000));
    loaded = await loadMarketData();
  }
  log(loaded ? `✅ البيانات جاهزة — SPX: ${S.price.toFixed(2)}` : '⚠️ سيتم المحاولة لاحقاً');

  app.listen(PORT,async()=>{
    log(`🚀 NEXUS v7 Server — port ${PORT}`);
    log(`TG_TOKEN: ${TG_TOKEN?'✅':'❌ مفقود — أضفه في Render'}`);
    log(`TG_CHAT:  ${TG_CHAT ?'✅':'❌ مفقود — أضفه في Render'}`);
    log(`SPX price: ${S.price > 0 ? S.price.toFixed(2)+' ✅' : 'لم يُحمَّل بعد ⏳'}`);
    keepAlive();
    if(TG_TOKEN&&TG_CHAT)
      await tg(`🟢 <b>NEXUS v7 انطلق!</b>\n\n✅ السيرفر يعمل\n💹 SPX: ${S.price.toFixed(2)}\n🤖 التنبيهات مفعّلة\n⏰ ${nowAr()}`);
    // mainLoop يبدأ بعد تحميل البيانات مباشرة
    setTimeout(mainLoop, loaded ? 30000 : 5000);
  });
})();
