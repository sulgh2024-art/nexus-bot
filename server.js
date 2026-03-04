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
  const p=S.price;
  if(!p||p===0) return {isBuy:false,isSell:false,bs:0,ss:0,bScore:0,sScore:0,
    bPct:0,sPct:0,bLabels:[],sLabels:[],conviction:0,bc:[],sc:[]};

  const atr=S.atr||20;
  const vwap=S.vwap||p;
  const bbRange=(S.bbU-S.bbL)||atr*2;
  const bbPct=bbRange>0?(p-S.bbL)/bbRange:0.5;

  const bc=[
    {pass:S.stD===1,         w:3, label:'SuperTrend ↑'},
    {pass:vwap>0&&p>vwap*1.0005, w:3, label:'فوق VWAP'},
    {pass:S.ema9>0&&S.ema9>S.ema21, w:2, label:'EMA9 > EMA21'},
    {pass:S.macd>S.msig&&S.mhist>0, w:2, label:'MACD ↑'},
    {pass:S.rsi>=40&&S.rsi<68, w:2, label:'RSI '+Math.round(S.rsi)},
    {pass:bbPct<0.5,          w:2, label:'BB منطقة شراء'},
    {pass:S.ema21>S.ema50,    w:1, label:'EMA21 > EMA50'},
  ];
  const sc=[
    {pass:S.stD===-1,         w:3, label:'SuperTrend ↓'},
    {pass:vwap>0&&p<vwap*0.9995, w:3, label:'تحت VWAP'},
    {pass:S.ema9>0&&S.ema9<S.ema21, w:2, label:'EMA9 < EMA21'},
    {pass:S.macd<S.msig&&S.mhist<0, w:2, label:'MACD ↓'},
    {pass:S.rsi>55&&S.rsi<=80, w:2, label:'RSI '+Math.round(S.rsi)},
    {pass:bbPct>0.5,           w:2, label:'BB منطقة بيع'},
    {pass:S.ema21<S.ema50,     w:1, label:'EMA21 < EMA50'},
  ];

  const bPassed=bc.filter(c=>c.pass),sPassed=sc.filter(c=>c.pass);
  const bScore=bPassed.reduce((s,c)=>s+c.w,0),sScore=sPassed.reduce((s,c)=>s+c.w,0);
  const bCount=bPassed.length,sCount=sPassed.length;
  const maxScore=15;
  const bPct=Math.round(bScore/maxScore*100),sPct=Math.round(sScore/maxScore*100);
  const bLabels=bPassed.map(c=>c.label),sLabels=sPassed.map(c=>c.label);
  const bHasCore=bPassed.some(c=>c.label==='SuperTrend ↑'||c.label==='فوق VWAP');
  const sHasCore=sPassed.some(c=>c.label==='SuperTrend ↓'||c.label==='تحت VWAP');
  const isBuy =bScore>=6&&bCount>=3&&bScore>sScore&&bHasCore;
  const isSell=sScore>=6&&sCount>=3&&sScore>bScore&&sHasCore;

  return{isBuy,isSell,bs:bCount,ss:sCount,bScore,sScore,bPct,sPct,maxScore,
    bLabels,sLabels,bc,sc,conviction:isBuy?bPct:isSell?sPct:Math.max(bPct,sPct)};
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
async function alertEntry(type,bScore,sScore,bLabels,sLabels){
  const p   = S.price;
  const atr = Math.max(S.atr||40, 20);
  const d   = type==='BUY' ? 1 : -1;
  const isL = d === 1;
  const score = isL ? bScore : sScore;

  // ══ أهداف SPX ══
  const slPts=8, tp1Pts=10, tp2Pts=20, tp3Pts=35;
  const tp1 = Math.round((p + d*tp1Pts)*100)/100;
  const tp2 = Math.round((p + d*tp2Pts)*100)/100;
  const tp3 = Math.round((p + d*tp3Pts)*100)/100;
  const sl  = Math.round((p - d*slPts)*100)/100;
  const rr  = (tp2Pts/slPts).toFixed(1);

  Object.assign(TRADE,{
    active:true, type, entry:p, atr, tp1, tp2, tp3, sl, trailSl:sl, score,
    tp1Hit:false, tp2Hit:false, nearTp1:false, nearTp2:false,
    slWarned:false, openedAt:new Date()
  });

  // ══ وقت الجلسة ══
  const etH = ((new Date().getUTCHours()-4+24)%24) + new Date().getUTCMinutes()/60;
  const hoursLeft = Math.max(16.0 - etH, 0.1);
  const sessionIcon = hoursLeft<1?'🔴':hoursLeft<2?'🟡':'🟢';
  const sessionNote = hoursLeft<1?'آخر ساعة ⚠️':hoursLeft<2?'آخر ساعتين':hoursLeft<4?'منتصف الجلسة':'بداية الجلسة';

  // تاريخ انتهاء SPXW
  const expDate = new Date().toLocaleDateString('en-US',{
    timeZone:'America/New_York', month:'short', day:'2-digit', year:'2-digit'
  }).replace(', ',' \'');

  // ══ حساب السترايك الأمثل بـ Black-Scholes (IV=9% واقعي) ══
  function bsOpt(S,K,T,sig,opt){
    if(T<=0) return Math.max(opt==='c'?S-K:K-S, 0);
    const sqt=Math.sqrt(T);
    const d1=(Math.log(S/K)+(0.053+0.5*sig*sig)*T)/(sig*sqt);
    const d2=d1-sig*sqt;
    const N=x=>{
      const p=[0.319381530,-0.356563782,1.781477937,-1.821255978,1.330274429];
      const t=1/(1+0.2316419*Math.abs(x));
      let poly=0, tp=t;
      for(const c of p){poly+=c*tp;tp*=t;}
      const nd=Math.exp(-x*x/2)/Math.sqrt(2*Math.PI);
      return x>=0?1-nd*poly:nd*poly;
    };
    if(opt==='c') return Math.max(S*N(d1)-K*Math.exp(-0.053*T)*N(d2), 0);
    return Math.max(K*Math.exp(-0.053*T)*(1-N(d2))-S*(1-N(d1)), 0);
  }

  // ابحث عن السترايك الذي يعطي premium أقرب لـ $6.50
  const T   = hoursLeft/(252*6.5);
  const sig = 0.09; // IV واقعي لـ SPX
  const TARGET_PREM = 6.50;
  let bestStrike = Math.round(p/5)*5;
  let bestDiff   = 9999;
  let bestPrem   = 0;
  for(let diff=0; diff<=80; diff+=5){
    const K = Math.round(p/5)*5 + (isL ? diff : -diff);
    const prem = bsOpt(p, K, T, sig, isL?'c':'p');
    if(Math.abs(prem - TARGET_PREM) < bestDiff){
      bestDiff   = Math.abs(prem - TARGET_PREM);
      bestStrike = K;
      bestPrem   = prem;
    }
  }
  const premVal  = Math.round(bestPrem*100)/100;
  const costVal  = Math.round(premVal*100);
  const slPrem   = Math.round(premVal*0.50*100)/100;  // وقف -50%
  const slCost   = Math.round(slPrem*100);
  const tgtPrem  = Math.round(premVal*1.80*100)/100;  // هدف +80%
  const tgtCost  = Math.round(tgtPrem*100);
  const otmDist  = Math.abs(bestStrike - Math.round(p/5)*5);

  // ══ المؤشرات ══
  const rsiV  = S.rsi.toFixed(1);
  const macdV = S.mhist>0?'▲':'▼';
  const stV   = S.stD===1?'▲':'▼';
  const vwapLine = S.vwap>0?`\n📊 VWAP: <b>${fmt(S.vwap)}</b>`:'';

  await tg(
`${isL?'🚀':'🔻'} <b>NEXUS v7 — ${isL?'CALL شراء':'PUT بيع'}</b>
${sessionIcon} ${sessionNote}  |  ATR: <b>${atr.toFixed(0)}</b> نقطة

━━━━━━━━━━━━━━━━━━
📊 <b>SPX</b>  💰 <b>${fmt(p)}</b>${vwapLine}
📐 RSI:<b>${rsiV}</b>  MACD:<b>${macdV}</b>  ST:<b>${stV}</b>  ${S.mktState}
✅ قوة الإشارة: <b>${score}/15</b>

━━━━━━━━━━━━━━━━━━
${isL?'📈':'📉'} <b>SPXW ${isL?'CALL':'PUT'} ${bestStrike}</b>  |  0DTE  |  ${expDate}
💵 Premium: <b>$${premVal}</b>/سهم  (~<b>$${costVal}</b>/عقد)
   ${otmDist===0?'📍 ATM (في السعر)':'📍 OTM '+otmDist+' نقطة من السعر'}

🛑 اخرج إذا نزل Premium → <b>$${slPrem}</b>  (-50% = -$${costVal-slCost})
🎯 اخرج إذا وصل Premium → <b>$${tgtPrem}</b>  (+80% = +$${tgtCost-costVal})

━━━━━━━━━━━━━━━━━━
🎯 <b>أهداف SPX:</b>
├ TP1  <b>${fmt(tp1)}</b>  ${fmtP((tp1-p)/p*100)}  (+${tp1Pts} نقطة)
├ TP2  <b>${fmt(tp2)}</b>  ${fmtP((tp2-p)/p*100)}  (+${tp2Pts} نقطة)
└ TP3  <b>${fmt(tp3)}</b>  ${fmtP((tp3-p)/p*100)}  (+${tp3Pts} نقطة)

🛑 وقف SPX: <b>${fmt(sl)}</b>  ${fmtP((sl-p)/p*100)}  (-${slPts} نقطة)
📏 R:R = 1:${rr}
━━━━━━━━━━━━━━━━━━
⏰ ${nowAr()}
⚠️ <i>ليست نصيحة مالية</i>`);

  log(`📤 ${type} SPXW ${bestStrike} ${isL?'CALL':'PUT'} prem:$${premVal} cost:$${costVal} TP1:${fmt(tp1)} SL:${fmt(sl)}`);
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
async function checkAlerts(){
  const sig=computeSig();
  const{isBuy,isSell,bs,ss,bScore,sScore,bPct,sPct,bLabels,sLabels,conviction}=sig;
  const cur=isBuy?'BUY':isSell?'SELL':'WAIT';
  const score=isBuy?bScore:isSell?sScore:0;
  const p=S.price, prev=S.lastSig;

  if(TRADE.active){
    const isL=TRADE.type==='BUY',d=isL?1:-1;
    const asl=TRADE.trailSl||TRADE.sl;
    if((isL&&p<=asl)||(!isL&&p>=asl)){await alertSLBroken();return;}
    const slLeft=Math.abs(p-asl),slDist=Math.abs(TRADE.entry-TRADE.sl);
    if(!TRADE.slWarned&&slLeft<slDist*0.25){
      TRADE.slWarned=true;
      if(canAlert('slWarn',120))
        await tg(`⚠️ <b>NEXUS v7 — تحذير</b>\nSPX قريب من وقف الخسارة!\nSPX: <b>${fmt(p)}</b> | SL: <b>${fmt(asl)}</b>\n⏰ ${nowAr()}`);
    }
    if(!TRADE.tp1Hit&&((isL&&p>=TRADE.tp1)||(!isL&&p<=TRADE.tp1))){TRADE.tp1Hit=true;await alertTPHit(1,TRADE.tp1);}
    if(TRADE.tp1Hit&&!TRADE.tp2Hit&&((isL&&p>=TRADE.tp2)||(!isL&&p<=TRADE.tp2))){TRADE.tp2Hit=true;await alertTPHit(2,TRADE.tp2);}
    if(TRADE.tp2Hit&&((isL&&p>=TRADE.tp3)||(!isL&&p<=TRADE.tp3))){TRADE.active=false;await alertTPHit(3,TRADE.tp3);}
    // Trailing SL
    if(TRADE.tp1Hit){
      const newSl=isL?Math.max(TRADE.trailSl,p-S.atr*0.5):Math.min(TRADE.trailSl,p+S.atr*0.5);
      TRADE.trailSl=newSl;
    }
    return;
  }

  // إشارة جديدة
  if(cur!=='WAIT'&&cur!==prev&&score>=6&&canAlert('entry',300)){
    S.lastSig=cur; S.lastScore=score;
    await alertEntry(cur,score);
  }

  // تغيير اتجاه SuperTrend
  if(S.stD===1&&prev==='SELL')  await alertRegimeChange('UP');
  if(S.stD===-1&&prev==='BUY') await alertRegimeChange('DOWN');
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
  if(etH>=9.5&&etH<16) return 30*1000;
  if(etH>=16&&etH<20)  return 2*60*1000;
  return 10*60*1000;
}

async function tick(){
  await loadMarketData();
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

  app.listen(PORT,async()=>{
    log(`🚀 NEXUS v7 يعمل على المنفذ ${PORT}`);
    if(TG_TOKEN&&TG_CHAT){
      await tg(`🟢 <b>NEXUS v7 انطلق!</b>\n\n✅ السيرفر يعمل\n💹 SPX: <b>${fmt(S.price)}</b>\n🤖 التنبيهات مفعّلة\n📊 ATR: <b>${S.atr.toFixed(1)}</b> نقطة\n${mktLn()}\n⏰ ${nowAr()}`);
    }
    setTimeout(tick, 5000);
  });
})();
