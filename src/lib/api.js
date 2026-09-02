import * as SecureStore from 'expo-secure-store';
import { API_URL } from './config';

const TOKEN_KEY = 'screenerAuthToken';
let memoryToken = null;
let customApiUrl = null;

export const getApiUrl = () => customApiUrl || API_URL;
export const setApiUrl = (url) => { customApiUrl = url ? String(url).replace(/\/$/, '') : null; };

export const getToken = async () => {
  if (memoryToken) return memoryToken;
  try {
    const t = await SecureStore.getItemAsync(TOKEN_KEY);
    memoryToken = t;
    return t;
  } catch { return memoryToken; }
};

export const saveToken = async (token) => {
  memoryToken = token || null;
  try {
    if (token) await SecureStore.setItemAsync(TOKEN_KEY, token);
    else await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {}
};

export const authTokenSync = () => memoryToken || '';

export const apiFetch = async (path, init = {}) => {
  const token = await getToken();
  const headers = new Headers(init.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type') && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  const base = getApiUrl();
  const url = path.startsWith('http') ? path : `${base}${path}`;
  const response = await fetch(url, { ...init, headers });
  if (response.status === 401 && token) {
    await saveToken('');
  }
  return response;
};

export const apiJson = async (path, init = {}) => {
  const res = await apiFetch(path, init);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error || data?.msg || `HTTP ${res.status}: ${text?.slice(0,120) || 'network error'}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
};

export const login = (username, password) => apiJson('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ username, password }),
});
export const fetchMe = () => apiJson('/api/auth/me');
export const updateProfile = (patch) => apiJson('/api/profile', { method: 'PATCH', body: JSON.stringify(patch) });
export const fetchScreenerDates = (dataset) => apiJson(`/api/screener/dates?dataset=${encodeURIComponent(dataset || 'av')}`);
export const fetchScreenerResults = (market, screen, date, dataset) =>
  apiJson(`/api/screener/results/${encodeURIComponent(market)}/${encodeURIComponent(screen)}/${encodeURIComponent(date)}?dataset=${encodeURIComponent(dataset || 'av')}`);
export const generateScreener = (date, dataset) => apiJson(`/api/screener/generate/${encodeURIComponent(date)}`, { method: 'POST', body: JSON.stringify({ dataset: dataset || 'av' }) });
export const fetchCandles = (market, symbol, date, period, dataset, opts = {}) => {
  const params = new URLSearchParams({ date, period: period || 'daily', dataset: dataset || 'av' });
  if (opts.live) params.set('live', '1');
  if (opts.full) params.set('full', '1');
  if (opts.reviewEnd) params.set('reviewEnd', opts.reviewEnd);
  if (opts.reviewStart) params.set('reviewStart', opts.reviewStart);
  return apiJson(`/api/screener/candles/${encodeURIComponent(market)}/${encodeURIComponent(symbol)}?${params.toString()}`);
};
export const fetchTradingDate = (market, direction, date, dataset) =>
  apiJson(`/api/screener/trading-date/${encodeURIComponent(market)}/${encodeURIComponent(direction)}/${encodeURIComponent(date)}?dataset=${encodeURIComponent(dataset || 'av')}`);
export const fetchEarliestDate = (market, dataset) =>
  apiJson(`/api/screener/trading-date/${encodeURIComponent(market)}/earliest?dataset=${encodeURIComponent(dataset || 'av')}`);
export const fetchPaperState = (mode, dataset) => {
  const p = new URLSearchParams();
  if (mode) p.set('mode', mode);
  if (dataset) p.set('dataset', dataset);
  const q = p.toString() ? `?${p.toString()}` : '';
  return apiJson(`/api/paper/state${q}`);
};
export const placeOrder = (payload) => apiJson('/api/paper/orders', { method: 'POST', body: JSON.stringify(payload) });
export const advanceSession = (payload) => apiJson('/api/paper/advance', { method: 'POST', body: JSON.stringify(payload || {}) });
export const resetSession = (mode, dataset) => apiJson('/api/paper/reset', { method: 'POST', body: JSON.stringify({ mode, dataset }) });
export const updateOrderStop = (id, stop_price) => apiJson(`/api/paper/orders/${id}/stop`, { method: 'PATCH', body: JSON.stringify({ stop_price }) });
export const updateOrderEntry = (id, entry) => apiJson(`/api/paper/orders/${id}/entry`, { method: 'PATCH', body: JSON.stringify(entry) });
export const updateOrderQuantity = (id, quantity) => apiJson(`/api/paper/orders/${id}/quantity`, { method: 'PATCH', body: JSON.stringify({ quantity }) });
export const closeOrder = (id, payload) => apiJson(`/api/paper/orders/${id}/close`, { method: 'POST', body: JSON.stringify(payload || {}) });
export const cancelOrder = (id) => apiJson(`/api/paper/orders/${id}`, { method: 'DELETE' });
export const fillOrder = (id) => apiJson(`/api/paper/orders/${id}/fill`, { method: 'POST' });
export const patchOrderNote = (id, note) => apiJson(`/api/paper/orders/${id}/note`, { method: 'PATCH', body: JSON.stringify({ journal_note: note }) });
export const releaseOrder = (id) => apiJson(`/api/paper/orders/${id}/release`, { method: 'PATCH' });
export const fetchLeaderboard = () => apiJson('/api/paper/leaderboard');
export const searchSymbols = (q, dataset, limit = 10) => apiJson(`/api/screener/symbol-search?q=${encodeURIComponent(q)}&dataset=${encodeURIComponent(dataset || 'av')}&limit=${limit}`);
export const fetchLastPickedDate = () => apiJson('/api/user/last-date');
export const fetchLastTradeDate = (dataset) => apiJson(`/api/user/last-trade-date?dataset=${encodeURIComponent(dataset || 'av')}`);
export const saveLastPickedDate = (date) => apiJson('/api/user/last-date', { method: 'PUT', body: JSON.stringify({ date }) });
