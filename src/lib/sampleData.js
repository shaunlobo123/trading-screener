// Sample universe & candles for offline demo
// Generated from real logic shape - synthetic but uses same field names as screener
// Daily candles: { date: 'YYYY-MM-DD', open, high, low, close, volume }

function genCandles(startPrice, days, dateEnd, volatility = 0.015) {
  const candles = [];
  let price = startPrice;
  const end = new Date(dateEnd + 'T00:00:00Z');
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    const dt = d.toISOString().slice(0, 10);
    // walk
    const change = (Math.random() - 0.48) * volatility * price;
    price = Math.max(1, price + change);
    const open = price * (1 + (Math.random() - 0.5) * 0.006);
    const close = price;
    const high = Math.max(open, close) * (1 + Math.random() * 0.012);
    const low = Math.min(open, close) * (1 - Math.random() * 0.012);
    const vol = Math.floor(500000 + Math.random() * 2000000);
    candles.push({ date: dt, open: Number(open.toFixed(2)), high: Number(high.toFixed(2)), low: Number(low.toFixed(2)), close: Number(close.toFixed(2)), volume: vol });
    price = close;
  }
  return candles;
}

function makeMomentumStock(symbol, startPrice, boost) {
  // Force 1/3/6m >20% by trending up strongly over 6m
  const candles = genCandles(startPrice, 180, '2024-06-14', 0.018);
  // apply boost to last 90 days to ensure >20%
  for (let i = 120; i < candles.length; i++) {
    const f = 1 + (boost * (i - 120)) / 60 * 0.015;
    candles[i].close = Number((candles[i].close * f).toFixed(2));
    candles[i].open = Number((candles[i].open * f).toFixed(2));
    candles[i].high = Number((candles[i].high * f).toFixed(2));
    candles[i].low = Number((candles[i].low * f).toFixed(2));
  }
  // ensure adr >4.5: make high/low spread ~6%
  for (let i = candles.length - 20; i < candles.length; i++) {
    candles[i].high = Number((candles[i].close * 1.06).toFixed(2));
    candles[i].low = Number((candles[i].close * 0.985).toFixed(2));
  }
  return candles;
}

function makePatternStock(symbol, startPrice) {
  const candles = genCandles(startPrice, 180, '2024-06-14', 0.012);
  // Force pattern: last 2 months red, current green above prev high
  // We manipulate monthly rollup indirectly via daily closes
  // Simplify: ensure last 40 days uptrend after 2 months down
  for (let i = 140; i < 160; i++) {
    candles[i].close = Number((candles[i].close * 0.92).toFixed(2));
    candles[i].open = Number((candles[i].open * 0.97).toFixed(2));
  }
  for (let i = 160; i < candles.length; i++) {
    candles[i].close = Number((candles[i].close * 1.08).toFixed(2));
    candles[i].open = Number((candles[i].open * 0.99).toFixed(2));
    candles[i].high = Number((Math.max(candles[i].open, candles[i].close) * 1.04).toFixed(2));
  }
  return candles;
}

export const SAMPLE_UNIVERSE = {
  'AGIO': makeMomentumStock('AGIO', 24, 1.8),
  'ALAR': makeMomentumStock('ALAR', 8, 3.2),
  'AMSC': makeMomentumStock('AMSC', 11, 2.1),
  'ANF': makeMomentumStock('ANF', 85, 1.5),
  'ARM': makeMomentumStock('ARM', 70, 1.6),
  'ASTS': makeMomentumStock('ASTS', 2.5, 4),
  'XYZ': genCandles(100, 180, '2024-06-14'),
  'DEMO': genCandles(45, 180, '2024-06-14'),
  'PAT1': makePatternStock('PAT1', 50),
  'PAT2': makePatternStock('PAT2', 120),
  'PAT3': makePatternStock('PAT3', 30),
  'MOMO': makeMomentumStock('MOMO', 60, 2.0),
};

// Also generate a second date universe for 2024-06-13 to show date sensitivity
export const SAMPLE_DATES = ['2024-06-10','2024-06-11','2024-06-12','2024-06-13','2024-06-14'];

export function getSampleCandles(symbol) {
  return SAMPLE_UNIVERSE[symbol] || null;
}

export function getSampleSymbols() { return Object.keys(SAMPLE_UNIVERSE); }
