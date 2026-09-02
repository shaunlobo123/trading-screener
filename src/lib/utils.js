export const numberText = (value, digits = 2) => {
  if (value === '' || value === null || value === undefined) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });
};

export const percentText = (value, digits = 2) => {
  if (value === '' || value === null || value === undefined) return '—';
  return `${numberText(value, digits)}%`;
};

export const volumeText = (value) => {
  if (value === '' || value === null || value === undefined) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString('en-GB');
};

export const dollarVolumeText = (value) => {
  if (value === '' || value === null || value === undefined) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
};

export const atrPercent = (row) => {
  if (row?.atr === '' || row?.atr == null || row?.close === '' || row?.close == null) return null;
  const atr = Number(row?.atr);
  const currentPrice = Number(row?.close);
  if (!Number.isFinite(atr) || !(currentPrice > 0)) return null;
  return (atr / currentPrice) * 100;
};

export const remainingAtrPercent = (row) => {
  const pct = atrPercent(row);
  if (row?.pct_up === '' || row?.pct_up == null) return null;
  const pctUp = Number(row?.pct_up);
  if (pct == null || !Number.isFinite(pctUp)) return null;
  return pct - Math.abs(pctUp);
};

export const riskSizedQuantity = (riskPerTrade, entry, stop) => {
  const risk = Number(riskPerTrade);
  const e = Number(entry);
  const s = Number(stop);
  if (!Number.isFinite(risk) || !Number.isFinite(e) || !Number.isFinite(s) || e <= s || risk <= 0) return 0;
  return Math.floor(risk / (e - s));
};

export const calendarToday = () => new Date().toISOString().slice(0, 10);

export const formatDate = (d) => {
  if (!d) return '';
  return String(d).slice(0, 10);
};

export const blindSymbolText = (value) => {
  const s = String(value || '');
  if (!s) return '';
  if (s.length === 1) return `${s}...`;
  return `${s[0]}...${s[s.length - 1]}`;
};

// Candle helpers
export const simpleMovingAverage = (candles, period) => {
  let rolling = 0;
  return candles.reduce((acc, c, i) => {
    rolling += c.close;
    if (i >= period) rolling -= candles[i - period].close;
    if (i >= period - 1) acc.push({ time: c.time, value: rolling / period });
    return acc;
  }, []);
};
