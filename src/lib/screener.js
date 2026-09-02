// Native port of backend/screener.js — PURE math, no pg, runs on-device
// Frozen algorithm — identical to backend — see trading/AGENTS.md §0
export const MIN_MOMENTUM_ADR = 4.5;

export function asOf(candles, date) {
  return candles.filter((c) => c.date <= date);
}

function isRed(c) { return c.close < c.open; }
function isGreen(c) { return c.close > c.open; }

export function rollupToMonthly(dailyCandles) {
  const byMonth = new Map();
  for (const c of dailyCandles) {
    const key = c.date.slice(0, 7);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(c);
  }
  const months = [...byMonth.keys()].sort();
  return months.map((key) => {
    const rows = byMonth.get(key);
    return {
      date: rows[rows.length - 1].date,
      open: rows[0].open,
      close: rows[rows.length - 1].close,
      high: Math.max(...rows.map((r) => r.high)),
      low: Math.min(...rows.map((r) => r.low)),
    };
  });
}

export function pctChangeOverMonths(dailyCandles, date, months) {
  const rows = asOf(dailyCandles, date);
  if (rows.length === 0) return null;
  const current = rows[rows.length - 1].close;
  const target = new Date(date + 'T00:00:00Z');
  target.setUTCMonth(target.getUTCMonth() - months);
  const targetDate = target.toISOString().slice(0, 10);
  const past = rows.filter((c) => c.date <= targetDate);
  if (past.length === 0) return null;
  const pastClose = past[past.length - 1].close;
  if (!pastClose) return null;
  return ((current - pastClose) / pastClose) * 100;
}

export function calendarMonthsAgo(date, months) {
  const d = new Date(date + 'T00:00:00Z');
  const originalDay = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(originalDay, lastDay));
  return d.toISOString().slice(0, 10);
}

export function wilderATR(candles, period = 14) {
  if (candles.length < period) return null;
  const trs = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) atr = ((atr * (period - 1)) + trs[i]) / period;
  return atr;
}

export function adr(candles, period = 20) {
  if (candles.length < period) return null;
  const recent = candles.slice(-period);
  if (recent.some((c) => !c.low || c.low <= 0)) return null;
  const avg = recent.reduce((s, c) => s + (c.high / c.low), 0) / period;
  return (avg - 1) * 100;
}

export function pctFromLowestLow(candles, date, months) {
  const start = calendarMonthsAgo(date, months);
  const win = candles.filter((c) => c.date >= start && c.date <= date);
  if (!win.length) return null;
  const lowest = Math.min(...win.map((c) => c.low));
  const cur = candles[candles.length - 1]?.close;
  if (!lowest || cur == null) return null;
  return ((cur - lowest) / lowest) * 100;
}

function round(v, d = 2) { return v == null || !Number.isFinite(v) ? '' : Number(v.toFixed(d)); }

export function calculateCandleMetrics(dailyCandles, date) {
  const candles = asOf(dailyCandles, date);
  if (!candles.length) return null;
  const cur = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const dollarUp = prev ? cur.close - prev.close : null;
  const pctUp = prev?.close ? (dollarUp / prev.close) * 100 : null;
  const atr = wilderATR(candles, 14);
  const sl = atr != null && dollarUp != null ? atr - Math.abs(dollarUp) : null;
  return {
    close: cur.close,
    pct_up: round(pctUp, 2),
    dollar_up: round(dollarUp, 4),
    atr: round(atr, 4),
    sl: round(sl, 4),
    adr: round(adr(candles, 20), 2),
    pct_from_low_1mth: round(pctFromLowestLow(candles, date, 1), 2),
    pct_from_low_3mth: round(pctFromLowestLow(candles, date, 3), 2),
    pct_from_low_6mth: round(pctFromLowestLow(candles, date, 6), 2),
    volume: cur.volume,
    dollar_volume: round(cur.close * cur.volume, 2),
  };
}

// relaxed=true => norgate young universe: ANY computable >20%
export function passesMomentum(daily, date, relaxed = false) {
  const p1 = pctChangeOverMonths(daily, date, 1);
  const p3 = pctChangeOverMonths(daily, date, 3);
  const p6 = pctChangeOverMonths(daily, date, 6);
  if (relaxed) {
    const avail = [p1, p3, p6].filter((v) => v != null);
    if (!avail.length) return null;
    return avail.some((v) => v > 20) ? { p1, p3, p6 } : null;
  }
  if (p1 == null || p3 == null || p6 == null) return null;
  return (p1 > 20 && p3 > 20 && p6 > 20) ? { p1, p3, p6 } : null;
}

export function passesPattern(monthly) {
  if (monthly.length < 3) return null;
  const last = monthly[monthly.length - 1];
  const prev1 = monthly[monthly.length - 2];
  const prev2 = monthly[monthly.length - 3];
  const passes = isRed(prev2) && isRed(prev1) && isGreen(last) && last.close > prev1.high;
  return passes ? { prev1High: prev1.high, lastClose: last.close } : null;
}

// Run both screens over a universe map: { symbol: dailyCandles[] }
export function runScreens(universe, date, { relaxedMomentum = false } = {}) {
  const momentum = [];
  const pattern = [];
  for (const [symbol, daily] of Object.entries(universe)) {
    if (!daily?.length) continue;
    const metrics = calculateCandleMetrics(daily, date);
    if (!metrics) continue;

    const mom = passesMomentum(daily, date, relaxedMomentum);
    if (mom && Number(metrics.adr) > MIN_MOMENTUM_ADR) {
      const txt = (v) => (v == null ? '' : v.toFixed(1));
      momentum.push({
        symbol,
        ...metrics,
        pct_1mth: txt(mom.p1),
        pct_3mth: txt(mom.p3),
        pct_6mth: txt(mom.p6),
      });
    }

    const monthly = rollupToMonthly(asOf(daily, date));
    const pat = passesPattern(monthly);
    if (pat) {
      pattern.push({
        symbol,
        ...metrics,
        prev_month_high: pat.prev1High,
        this_month_close: pat.lastClose,
      });
    }
  }
  momentum.sort((a, b) => a.symbol.localeCompare(b.symbol));
  pattern.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { momentum, pattern };
}
