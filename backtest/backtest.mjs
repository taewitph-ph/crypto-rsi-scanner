// Backtest ของ RSI Divergence Scanner: ใช้กฎเดียวกับ index.html
// รัน: node backtest/backtest.mjs [topN] [tfs]   เช่น node backtest/backtest.mjs 200 4h,1d
// ผลลัพธ์: backtest/result.json และ backtest/report.md
import fs from 'node:fs';
import path from 'node:path';

const TOP_N = +(process.argv[2] || 200);
const TFS = (process.argv[3] || '4h,1d').split(',');
const HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];
const STABLE = new Set(['USDC','FDUSD','TUSD','BUSD','DAI','USDP','EUR','EURI','AEUR','PAXG','XUSD','USD1','USDE','USDS','BFUSD']);
const CFG = { rsiLen: 14, pivL: 5, pivR: 3, maxAge: 12 };
const MIN_RSI_DIFF = 1.0;
const BARS = 1000;

// ---------- API ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(p) {
  let err;
  for (const h of HOSTS) {
    for (let k = 0; k < 3; k++) {
      try {
        const r = await fetch(h + p);
        if (r.status === 429 || r.status === 418) { await sleep(5000); continue; }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
      } catch (e) { err = e; await sleep(500); }
    }
  }
  throw err;
}
async function klines(symbol, tf, limit = BARS) {
  const raw = await api(`/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`);
  return raw.map(k => ({ t: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], vol: +k[7] }));
}

// ---------- indicators (เหมือน index.html) ----------
function rsi(closes, len) {
  const out = new Array(closes.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i <= len && i < closes.length; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) gain += d; else loss -= d; }
  gain /= len; loss /= len;
  if (closes.length > len) out[len] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = len + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (len - 1) + Math.max(d, 0)) / len; loss = (loss * (len - 1) + Math.max(-d, 0)) / len;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}
function atr(kl, len = 14) {
  const out = new Array(kl.length).fill(null); let sum = 0, prev = null;
  for (let i = 0; i < kl.length; i++) {
    const k = kl[i];
    const tr = i === 0 ? k.high - k.low : Math.max(k.high - k.low, Math.abs(k.high - kl[i - 1].close), Math.abs(k.low - kl[i - 1].close));
    if (i < len) { sum += tr; if (i === len - 1) prev = sum / len; } else prev = (prev * (len - 1) + tr) / len;
    if (i >= len - 1) out[i] = prev;
  }
  return out;
}
function ema(vals, len) {
  const out = new Array(vals.length).fill(null); const k = 2 / (len + 1); let e = null, sum = 0;
  for (let i = 0; i < vals.length; i++) {
    if (i < len) { sum += vals[i]; if (i === len - 1) { e = sum / len; out[i] = e; } continue; }
    e = vals[i] * k + e * (1 - k); out[i] = e;
  }
  return out;
}
function adx(kl, len = 14) {
  const n = kl.length, out = new Array(n).fill(null);
  if (n < len * 2 + 1) return out;
  const tr = [], pdm = [], mdm = [];
  for (let i = 1; i < n; i++) {
    const h = kl[i].high, l = kl[i].low, ph = kl[i - 1].high, pl = kl[i - 1].low, pc = kl[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph, dn = pl - l;
    pdm.push(up > dn && up > 0 ? up : 0); mdm.push(dn > up && dn > 0 ? dn : 0);
  }
  let str = 0, spdm = 0, smdm = 0;
  for (let i = 0; i < len; i++) { str += tr[i]; spdm += pdm[i]; smdm += mdm[i]; }
  const dx = [];
  const pushDx = () => { const pdi = 100 * spdm / str, mdi = 100 * smdm / str; dx.push(pdi + mdi === 0 ? 0 : 100 * Math.abs(pdi - mdi) / (pdi + mdi)); };
  pushDx();
  for (let i = len; i < tr.length; i++) {
    str = str - str / len + tr[i]; spdm = spdm - spdm / len + pdm[i]; smdm = smdm - smdm / len + mdm[i]; pushDx();
  }
  // dx[j] ตรงกับ kl index j + len
  let a = null, s = 0;
  for (let j = 0; j < dx.length; j++) {
    if (j < len) { s += dx[j]; if (j === len - 1) { a = s / len; out[j + len] = a; } continue; }
    a = (a * (len - 1) + dx[j]) / len; out[j + len] = a;
  }
  return out;
}
function pivots(arr, L, R, isLow) {
  const idx = [];
  for (let i = L; i < arr.length - R; i++) {
    let ok = true;
    for (let j = i - L; j <= i + R && ok; j++) { if (j === i) continue; if (isLow ? arr[j] < arr[i] : arr[j] > arr[i]) ok = false; }
    if (ok) idx.push(i);
  }
  return idx;
}
function rsiExtreme(r, i, w, bullish, hi) {
  const lo = Math.max(0, i - w), up = Math.min(hi, i + w); let best = -1;
  for (let j = lo; j <= up; j++) { if (r[j] == null) continue; if (best < 0 || (bullish ? r[j] < r[best] : r[j] > r[best])) best = j; }
  return best;
}
function isDiv(price, r, a, b, ra, rb, bullish) {
  if (ra < 0 || rb < 0) return false;
  const priceDiv = bullish ? price[b] < price[a] : price[b] > price[a];
  const rsiDiv = bullish ? r[rb] - r[ra] >= MIN_RSI_DIFF : r[ra] - r[rb] >= MIN_RSI_DIFF;
  return priceDiv && rsiDiv;
}

// ---------- signal generation แบบเดินไปทีละแท่ง (ไม่มองอนาคต) ----------
// คืน list ของ {t, dir, mode:'conf'|'form', confirmed, points:[{i,price}], rsiMin/Max}
function signals(kl, r, bullish) {
  const n = kl.length, price = bullish ? kl.map(k => k.low) : kl.map(k => k.high);
  const piv = pivots(price, CFG.pivL, CFG.pivR, bullish);
  const rIdx = piv.map(i => rsiExtreme(r, i, CFG.pivR, bullish, n - 1)); // window i±R ≤ i+R = เวลายืนยัน pivot พอดี
  const out = []; const fired = new Set();
  for (let t = CFG.rsiLen + CFG.pivL + CFG.pivR + 5; t < n; t++) {
    // pivot ที่ยืนยันแล้ว ณ เวลา t
    let m = 0; while (m < piv.length && piv[m] + CFG.pivR <= t) m++;
    if (m < 1) continue;
    const lastK = m - 1, last = piv[lastK], lastR = rIdx[lastK];
    // นับ chain ยืนยัน
    let count = 0; const chain = [lastK];
    for (let k = lastK; k > 0; k--) { if (isDiv(price, r, piv[k - 1], piv[k], rIdx[k - 1], rIdx[k], bullish)) { count++; chain.unshift(k - 1); } else break; }
    // forming ณ เวลา t
    let forming = -1;
    { let cand = -1; for (let i = last + 1; i <= t; i++) if (cand < 0 || (bullish ? price[i] < price[cand] : price[i] > price[cand])) cand = i;
      if (cand >= 0 && t - cand <= CFG.pivR) { const cR = rsiExtreme(r, cand, CFG.pivR, bullish, t); if (isDiv(price, r, last, cand, lastR, cR, bullish)) forming = cand; } }
    const pts = chain.map(k => ({ i: piv[k], price: price[piv[k]], rsi: r[rIdx[k]] }));
    const rsiExt = bullish ? Math.min(...pts.map(p => p.rsi)) : Math.max(...pts.map(p => p.rsi));
    // เหตุการณ์ 1: chain ยืนยันครบ (ยิงครั้งเดียวต่อ last pivot) ต้องอายุไม่เกิน maxAge
    if (count >= 1 && t - last <= CFG.maxAge) {
      const key = `c|${last}`;
      if (!fired.has(key)) { fired.add(key); out.push({ t, dir: bullish ? 'bull' : 'bear', mode: 'conf', confirmed: count, points: pts, rsiExt }); }
    }
    // เหตุการณ์ 2: forming (ยิงครั้งเดียวต่อ last pivot)
    if (forming >= 0 && count >= 1) {
      const key = `f|${last}`;
      if (!fired.has(key)) { fired.add(key); out.push({ t, dir: bullish ? 'bull' : 'bear', mode: 'form', confirmed: count, points: [...pts, { i: forming, price: price[forming], rsi: null }], rsiExt }); }
    }
  }
  return out;
}

// ---------- trade plan (เหมือน makePlan) ----------
function plan(kl, atrArr, bullish, pts, t) {
  const highs = kl.map(k => k.high), lows = kl.map(k => k.low);
  const entry = kl[t].close, a = atrArr[t] || entry * 0.01;
  const lastPt = pts[pts.length - 1], prevPt = pts.length >= 2 ? pts[pts.length - 2] : null;
  const sl = bullish ? lastPt.price - 0.5 * a : lastPt.price + 0.5 * a;
  const risk = bullish ? entry - sl : sl - entry;
  if (risk <= 0) return null;
  const rangeExt = (from, to, arr, isMax) => { let v = null; for (let i = from; i <= to; i++) v = v == null ? arr[i] : (isMax ? Math.max(v, arr[i]) : Math.min(v, arr[i])); return v; };
  let tp1 = null;
  if (prevPt) { const c = bullish ? rangeExt(prevPt.i, lastPt.i, highs, true) : rangeExt(prevPt.i, lastPt.i, lows, false); if (c != null && (bullish ? c > entry : c < entry)) tp1 = c; }
  if (tp1 == null && pts.length >= 3) { const c = bullish ? rangeExt(pts[0].i, lastPt.i, highs, true) : rangeExt(pts[0].i, lastPt.i, lows, false); if (c != null && (bullish ? c > entry : c < entry)) tp1 = c; }
  const tp2 = bullish ? entry + 2 * risk : entry - 2 * risk;
  return { entry, sl, tp1, tp2, risk, rr1: tp1 == null ? null : (bullish ? tp1 - entry : entry - tp1) / risk };
}

// ---------- simulate exit ----------
// คืน R ของไม้ (null = ยังไม่จบตอนหมดข้อมูล)
function simulate(kl, from, bullish, entry, sl, tp, mode) {
  const risk = bullish ? entry - sl : sl - entry;
  const hit = (k, lvl, above) => above ? k.high >= lvl : k.low <= lvl;
  if (mode !== 'partial') {
    for (let i = from; i < kl.length; i++) {
      const k = kl[i];
      if (bullish) { if (k.low <= sl) return -1; if (k.high >= tp) return (tp - entry) / risk; }
      else { if (k.high >= sl) return -1; if (k.low <= tp) return (entry - tp) / risk; }
    }
    return null;
  }
  // partial: ครึ่งแรกปิดที่ 1R แล้วเลื่อน SL ไปทุน ครึ่งหลังไป 2R
  const r1 = bullish ? entry + risk : entry - risk, r2 = bullish ? entry + 2 * risk : entry - 2 * risk;
  let stage = 0, curSl = sl;
  for (let i = from; i < kl.length; i++) {
    const k = kl[i];
    if (bullish) {
      if (k.low <= curSl) return stage === 0 ? -1 : 0.5;
      if (stage === 0 && k.high >= r1) { stage = 1; curSl = entry; if (k.high >= r2) return 1.5; continue; }
      if (stage === 1 && k.high >= r2) return 1.5;
    } else {
      if (k.high >= curSl) return stage === 0 ? -1 : 0.5;
      if (stage === 0 && k.low <= r1) { stage = 1; curSl = entry; if (k.low <= r2) return 1.5; continue; }
      if (stage === 1 && k.low <= r2) return 1.5;
    }
  }
  return null;
}

// ---------- main ----------
async function main() {
  console.log(`โหลดรายชื่อเหรียญ Top ${TOP_N} ...`);
  const [info, tickers] = await Promise.all([api('/api/v3/exchangeInfo?permissions=SPOT'), api('/api/v3/ticker/24hr')]);
  const tk = {}; for (const t of tickers) tk[t.symbol] = t;
  const symbols = info.symbols
    .filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING' && s.isSpotTradingAllowed && !STABLE.has(s.baseAsset) && !/(UP|DOWN|BULL|BEAR)$/.test(s.baseAsset))
    .map(s => ({ symbol: s.symbol, vol: +(tk[s.symbol]?.quoteVolume || 0) }))
    .sort((a, b) => b.vol - a.vol).slice(0, TOP_N);

  console.log('โหลด BTC daily ...');
  const btcD = await klines('BTCUSDT', '1d');
  const btcEma50 = ema(btcD.map(k => k.close), 50);
  const btcState = t => { // 1 = BTC เหนือ EMA50 (ใช้แท่งวันที่ปิดแล้ว), -1 = ใต้, 0 = ไม่รู้
    let j = -1; for (let i = 0; i < btcD.length; i++) { if (btcD[i].t + 86400000 <= t) j = i; else break; }
    if (j < 0 || btcEma50[j] == null) return 0; return btcD[j].close > btcEma50[j] ? 1 : -1;
  };

  const trades = []; // {symbol, tf, dir, mode, confirmed, rank, trend, btc, adx, confirmNext, rsiZone, rr1, R_tp1, R_2r, R_partial, entryT}
  let done = 0;
  const queue = symbols.map((s, i) => ({ ...s, rank: i + 1 }));
  async function worker() {
    while (queue.length) {
      const s = queue.shift();
      try {
        const daily = await klines(s.symbol, '1d');
        const dEma200 = ema(daily.map(k => k.close), 200);
        const trendAt = t => { let j = -1; for (let i = 0; i < daily.length; i++) { if (daily[i].t + 86400000 <= t) j = i; else break; }
          if (j < 0 || dEma200[j] == null) return 0; return daily[j].close > dEma200[j] ? 1 : -1; };
        for (const tf of TFS) {
          const kl = tf === '1d' ? daily : await klines(s.symbol, tf);
          if (kl.length < 300) continue;
          const closes = kl.map(k => k.close), r = rsi(closes, CFG.rsiLen), a = atr(kl, 14), ad = adx(kl, 14);
          for (const bullish of [true, false]) {
            const sigs = signals(kl, r, bullish);
            for (const sg of sigs) {
              if (sg.t < 250 || sg.t >= kl.length - 2) continue;
              const pl = plan(kl, a, bullish, sg.points, sg.t);
              if (!pl) continue;
              const tp1 = pl.tp1 ?? pl.tp2;
              const R_tp1 = simulate(kl, sg.t + 1, bullish, pl.entry, pl.sl, tp1, 'tp');
              const R_2r = simulate(kl, sg.t + 1, bullish, pl.entry, pl.sl, pl.tp2, 'tp');
              const R_partial = simulate(kl, sg.t + 1, bullish, pl.entry, pl.sl, pl.tp2, 'partial');
              // เข้าแท่งถัดไปถ้าปิดยืนยันทิศ (confirm candle) ใช้ SL/TP เดิม
              let R_confirm = 'skip';
              const nk = kl[sg.t + 1];
              const confirmed = bullish ? nk.close > kl[sg.t].close : nk.close < kl[sg.t].close;
              if (confirmed) {
                const e2 = nk.close, risk2 = bullish ? e2 - pl.sl : pl.sl - e2;
                if (risk2 > 0) { const tp2b = bullish ? e2 + 2 * risk2 : e2 - 2 * risk2; R_confirm = simulate(kl, sg.t + 2, bullish, e2, pl.sl, tp2b, 'tp'); }
              }
              // หาแท่งที่ไม้จบเพื่อกัน overlap (ใช้ผล 2R)
              let endI = kl.length; for (let i = sg.t + 1; i < kl.length; i++) { const k = kl[i]; if (bullish ? (k.low <= pl.sl || k.high >= pl.tp2) : (k.high >= pl.sl || k.low <= pl.tp2)) { endI = i; break; } }
              trades.push({ symbol: s.symbol, tf, dir: bullish ? 'bull' : 'bear', mode: sg.mode, confirmed: sg.confirmed, rank: s.rank,
                trend: trendAt(kl[sg.t].t), btc: btcState(kl[sg.t].t), adx: ad[sg.t], rsiExt: sg.rsiExt, rr1: pl.rr1, slPct: pl.risk / pl.entry * 100,
                R_tp1, R_2r, R_partial, R_confirm, entryT: kl[sg.t].t, t: sg.t, endI });
            }
          }
        }
      } catch (e) { console.log('ข้าม', s.symbol, e.message); }
      done++; if (done % 20 === 0) console.log(`  ${done}/${symbols.length} เหรียญ · ${trades.length} ไม้`);
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  fs.mkdirSync(path.join('backtest'), { recursive: true });
  fs.writeFileSync(path.join('backtest', 'result.json'), JSON.stringify({ generated: new Date().toISOString(), topN: TOP_N, tfs: TFS, cfg: CFG, trades }, null, 0));
  console.log(`เสร็จ: ${trades.length} ไม้ → backtest/result.json`);
  report(trades);
}

// ---------- report ----------
// ไม้ละครั้งต่อเหรียญ/TF/ทิศ: ข้ามสัญญาณที่เกิดระหว่างไม้ก่อนหน้ายังเปิดอยู่ (คิดแยกตามชุดที่ประเมิน)
function dedupe(list) {
  const groups = {};
  for (const t of list) (groups[`${t.symbol}|${t.tf}|${t.dir}`] ||= []).push(t);
  const out = [];
  for (const g of Object.values(groups)) { g.sort((a, b) => a.t - b.t); let busy = -1; for (const t of g) { if (t.t <= busy) continue; busy = t.endI; out.push(t); } }
  return out;
}
function stats(list, key) {
  const rs = dedupe(list).map(t => t[key]).filter(v => typeof v === 'number');
  const n = rs.length; if (!n) return { n: 0 };
  const wins = rs.filter(v => v > 0).length, sum = rs.reduce((a, b) => a + b, 0);
  const gp = rs.filter(v => v > 0).reduce((a, b) => a + b, 0), gl = -rs.filter(v => v <= 0).reduce((a, b) => a + b, 0);
  let eq = 0, peak = 0, dd = 0; for (const v of rs) { eq += v; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return { n, win: wins / n * 100, avgR: sum / n, pf: gl === 0 ? Infinity : gp / gl, dd };
}
const f1 = v => v == null ? '-' : v.toFixed(1), f2 = v => v == null ? '-' : (v === Infinity ? '∞' : v.toFixed(2));
function row(name, list, key) { const s = stats(list, key); return s.n ? `| ${name} | ${s.n} | ${f1(s.win)}% | ${f2(s.avgR)} | ${f2(s.pf)} | ${f1(s.dd)} |` : `| ${name} | 0 | - | - | - | - |`; }
const HEAD = '| ชุด | ไม้ | win rate | R เฉลี่ย | profit factor | max DD (R) |\n|---|---|---|---|---|---|';

function report(trades) {
  const L = [];
  L.push(`# ผล backtest RSI Divergence (${new Date().toLocaleDateString('th-TH')})`);
  L.push(`ข้อมูล: ${TFS.join(', ')} × Top ${TOP_N} เหรียญ × ${BARS} แท่งล่าสุด · กฎ: RSI ${CFG.rsiLen}, pivot ${CFG.pivL}/${CFG.pivR}, SL = จุดท้าย ± 0.5 ATR · ยังไม่หักค่าธรรมเนียม (ราว 0.05 ถึง 0.1R ต่อไม้)`);
  L.push('');
  // ชุดสัญญาณพื้นฐาน
  const S = {
    'A. 1 ลูกยืนยัน (ทุกสัญญาณ)': trades.filter(t => t.mode === 'conf'),
    'B. 2 ลูกยืนยันขึ้นไป': trades.filter(t => t.mode === 'conf' && t.confirmed >= 2),
    'C. 1 ยืนยัน + กำลังเกิด (ค่าเริ่มต้นแอพ)': trades.filter(t => t.mode === 'form'),
    'D. B รวม C (แอพตอนนี้ minDiv=2)': trades.filter(t => (t.mode === 'conf' && t.confirmed >= 2) || t.mode === 'form'),
  };
  for (const exitKey of [['R_2r', 'ออกที่ 2R (TP2)'], ['R_tp1', 'ออกที่ TP1 (แนวรับ/ต้าน)'], ['R_partial', 'ครึ่งที่ 1R + เลื่อน SL ทุน + ครึ่งที่ 2R']]) {
    L.push(`## วิธีออก: ${exitKey[1]}`); L.push(HEAD);
    for (const [name, list] of Object.entries(S)) L.push(row(name, list, exitKey[0]));
    L.push('');
  }
  // ตัวกรอง ใช้ชุด D (แอพตอนนี้) และออก 2R
  const base = S['D. B รวม C (แอพตอนนี้ minDiv=2)'];
  const F = {
    'ไม่กรอง': t => true,
    'เทรนด์ Day (EMA200) ทิศเดียวกับสัญญาณ': t => (t.dir === 'bull' && t.trend === 1) || (t.dir === 'bear' && t.trend === -1),
    'สวนเทรนด์ Day': t => (t.dir === 'bull' && t.trend === -1) || (t.dir === 'bear' && t.trend === 1),
    'ADX < 25 (ตลาดแกว่ง)': t => t.adx != null && t.adx < 25,
    'ADX ≥ 25 (ตลาดเทรนด์)': t => t.adx != null && t.adx >= 25,
    'BTC Day ทิศเดียวกัน (EMA50)': t => (t.dir === 'bull' && t.btc === 1) || (t.dir === 'bear' && t.btc === -1),
    'RSI ถึงโซน (bull ≤35 / bear ≥65)': t => (t.dir === 'bull' && t.rsiExt <= 35) || (t.dir === 'bear' && t.rsiExt >= 65),
    'Top 100 เหรียญ (volume สูง)': t => t.rank <= 100,
    'SL ห่างไม่เกิน 5%': t => t.slPct <= 5,
    'เฉพาะ Bullish': t => t.dir === 'bull',
    'เฉพาะ Bearish': t => t.dir === 'bear',
    'เฉพาะ 4h': t => t.tf === '4h',
    'เฉพาะ Day': t => t.tf === '1d',
    'เทรนด์ + ADX<25': t => F['เทรนด์ Day (EMA200) ทิศเดียวกับสัญญาณ'](t) && F['ADX < 25 (ตลาดแกว่ง)'](t),
    'เทรนด์ + BTC': t => F['เทรนด์ Day (EMA200) ทิศเดียวกับสัญญาณ'](t) && F['BTC Day ทิศเดียวกัน (EMA50)'](t),
    'เทรนด์ + RSI โซน': t => F['เทรนด์ Day (EMA200) ทิศเดียวกับสัญญาณ'](t) && F['RSI ถึงโซน (bull ≤35 / bear ≥65)'](t),
    'เทรนด์ + BTC + ADX<25 + SL≤5%': t => F['เทรนด์ + BTC'](t) && F['ADX < 25 (ตลาดแกว่ง)'](t) && F['SL ห่างไม่เกิน 5%'](t),
  };
  for (const [exitKey, label] of [['R_2r', 'ออกที่ 2R'], ['R_partial', 'ครึ่ง 1R + ครึ่ง 2R'], ['R_tp1', 'ออกที่ TP1']]) {
    L.push(`## ตัวกรอง (ชุด D, ${label})`); L.push(HEAD);
    for (const [name, fn] of Object.entries(F)) L.push(row(name, base.filter(fn), exitKey));
    L.push('');
  }
  // confirm candle
  L.push('## รอแท่งยืนยัน 1 แท่งก่อนเข้า (ชุด D, ออก 2R จากราคาเข้าใหม่)'); L.push(HEAD);
  L.push(row('เข้าทันที (เทียบ)', base, 'R_2r'));
  L.push(row('รอแท่งยืนยัน (เฉพาะไม้ที่ได้เข้า)', base.filter(t => t.R_confirm !== 'skip'), 'R_confirm'));
  L.push(`| (สัญญาณที่ถูกข้ามเพราะแท่งถัดไปไม่ยืนยัน) | ${dedupe(base).filter(t => t.R_confirm === 'skip').length} | | | | |`);
  L.push('');
  // by TF x dir
  L.push('## แยก TF × ทิศ (ชุด D, ออก 2R)'); L.push(HEAD);
  for (const tf of TFS) for (const dir of ['bull', 'bear']) L.push(row(`${tf} ${dir}`, base.filter(t => t.tf === tf && t.dir === dir), 'R_2r'));
  L.push('');
  L.push('## RR ถึง TP1 กับผลจริง (ชุด D, ออกที่ TP1)'); L.push(HEAD);
  L.push(row('ไม่มี TP1 (ใช้ 2R)', base.filter(t => t.rr1 == null), 'R_tp1'));
  L.push(row('RR1 < 1', base.filter(t => t.rr1 != null && t.rr1 < 1), 'R_tp1'));
  L.push(row('RR1 1 ถึง 2', base.filter(t => t.rr1 != null && t.rr1 >= 1 && t.rr1 < 2), 'R_tp1'));
  L.push(row('RR1 ≥ 2', base.filter(t => t.rr1 != null && t.rr1 >= 2), 'R_tp1'));
  fs.writeFileSync(path.join('backtest', 'report.md'), L.join('\n'));
  console.log(L.join('\n'));
}

main().catch(e => { console.error(e); process.exit(1); });
