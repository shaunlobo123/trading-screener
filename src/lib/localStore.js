import AsyncStorage from '@react-native-async-storage/async-storage';

const ORDERS_KEY = 'local_orders_v1';
const SESSION_KEY = 'local_session_v1';
const USER_KEY = 'local_user_v1';

// Simple local paper trading - no server needed
// Session: { trading_date: 'YYYY-MM-DD', created_at }

export async function getLocalUser() {
  const j = await AsyncStorage.getItem(USER_KEY);
  return j ? JSON.parse(j) : null;
}
export async function saveLocalUser(u) {
  await AsyncStorage.setItem(USER_KEY, JSON.stringify(u));
}
export async function clearLocalUser() {
  await AsyncStorage.removeItem(USER_KEY);
}

export async function getLocalSession() {
  const j = await AsyncStorage.getItem(SESSION_KEY);
  return j ? JSON.parse(j) : null;
}
export async function saveLocalSession(s) {
  await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

export async function getLocalOrders() {
  const j = await AsyncStorage.getItem(ORDERS_KEY);
  return j ? JSON.parse(j) : [];
}
export async function saveLocalOrders(orders) {
  await AsyncStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
}

export async function resetLocal() {
  await AsyncStorage.multiRemove([ORDERS_KEY, SESSION_KEY]);
}

// Order shape mirrors backend: { id, symbol, market, status: 'pending'|'open'|'closed', order_type, quantity, entry_price, stop_price, limit_price, placed_date, entry_date, exit_date, exit_price, exit_reason, journal_note, created_at }
let idCounter = Date.now();
function nextId() { return String(++idCounter); }

export async function placeLocalOrder({ market, symbol, order_type, quantity, limit_price, stop_price, trading_date }) {
  const orders = await getLocalOrders();
  // Training: one open/pending per symbol
  if (orders.some(o => o.symbol === symbol && ['open','pending'].includes(o.status))) {
    throw new Error('Already have open/pending for ' + symbol + ' (training: 1 per symbol)');
  }
  const id = nextId();
  const now = trading_date || new Date().toISOString().slice(0,10);
  // Determine fill: if limit > close? We need close price - caller passes entry_price as limit or close
  // For simplicity local: market always fills at entry_price (close), limit pending until Next Day
  const isPending = order_type === 'limit';
  const order = {
    id,
    market: market || 'US',
    symbol,
    order_type,
    quantity: Number(quantity),
    initial_quantity: Number(quantity),
    limit_price: limit_price != null ? Number(limit_price) : null,
    stop_price: Number(stop_price),
    status: isPending ? 'pending' : 'open',
    placed_date: now,
    entry_date: isPending ? null : now,
    entry_price: isPending ? null : Number(limit_price || 0) || null, // will be set to close by caller
    exit_date: null,
    exit_price: null,
    exit_reason: null,
    journal_note: '',
    created_at: new Date().toISOString(),
  };
  // For market, we set entry_price to limit_price if provided else caller must set
  if (order.status === 'open' && !order.entry_price) {
    // caller should have passed close as limit_price for market
    order.entry_price = Number(limit_price) || null;
  }
  orders.push(order);
  await saveLocalOrders(orders);
  return order;
}

export async function advanceLocalSession(candlesMap, currentDate) {
  // candlesMap: { symbol: candles[] } for checking lows
  // currentDate: trading_date to advance from
  // Find next trading date as max date > currentDate across universe
  const allDates = new Set();
  for (const candles of Object.values(candlesMap)) {
    for (const c of candles) if (c.date > currentDate) allDates.add(c.date);
  }
  const nextDates = [...allDates].sort();
  const nextDate = nextDates[0];
  if (!nextDate) throw new Error('No next trading date');

  const orders = await getLocalOrders();
  const nextOrders = orders.map(o => ({ ...o }));

  for (const o of nextOrders) {
    if (o.status === 'pending') {
      const candles = candlesMap[o.symbol] || [];
      const nextCandle = candles.find(c => c.date === nextDate);
      if (!nextCandle) continue;
      // fill check low <= limit
      if (nextCandle.low <= o.limit_price) {
        // fill at min(open, limit)
        const fillPrice = Math.min(nextCandle.open, o.limit_price);
        o.status = 'open';
        o.entry_date = nextDate;
        o.entry_price = fillPrice;
        // immediate stop check same candle low <= stop with includeFrom=true
        if (nextCandle.low <= o.stop_price) {
          o.status = 'closed';
          o.exit_date = nextDate;
          o.exit_price = Math.min(nextCandle.open, o.stop_price);
          o.exit_reason = 'stop_loss';
        }
      }
    } else if (o.status === 'open') {
      const candles = candlesMap[o.symbol] || [];
      const nextCandle = candles.find(c => c.date === nextDate);
      if (!nextCandle) continue;
      if (nextCandle.low <= o.stop_price) {
        o.status = 'closed';
        o.exit_date = nextDate;
        o.exit_price = Math.min(nextCandle.open, o.stop_price);
        o.exit_reason = 'stop_loss';
      }
    }
  }
  await saveLocalOrders(nextOrders);
  const session = { trading_date: nextDate, updated_at: new Date().toISOString() };
  await saveLocalSession(session);
  return { session, orders: nextOrders };
}

export async function updateLocalStop(id, newStop) {
  const orders = await getLocalOrders();
  const o = orders.find(x => String(x.id) === String(id));
  if (!o) throw new Error('Order not found');
  o.stop_price = Number(newStop);
  // if training and stop >= close? Need current candle close - we don't have here, just update
  await saveLocalOrders(orders);
  return o;
}

export async function updateLocalEntry(id, patch) {
  const orders = await getLocalOrders();
  const o = orders.find(x => String(x.id) === String(id));
  if (!o) throw new Error('Order not found');
  if (patch.limit_price != null) o.limit_price = Number(patch.limit_price);
  if (patch.entry_price != null) o.entry_price = Number(patch.entry_price);
  await saveLocalOrders(orders);
  return o;
}

export async function cancelLocal(id) {
  let orders = await getLocalOrders();
  const o = orders.find(x => String(x.id) === String(id));
  if (!o) throw new Error('Not found');
  if (!['pending','open'].includes(o.status)) throw new Error('Only pending/open can cancel');
  o.status = 'cancelled';
  await saveLocalOrders(orders);
  return o;
}

export async function closeLocal(id, qty) {
  const orders = await getLocalOrders();
  const o = orders.find(x => String(x.id) === String(id));
  if (!o) throw new Error('Not found');
  if (o.status !== 'open') throw new Error('Only open can close');
  // For simplicity, full close
  o.status = 'closed';
  o.exit_date = new Date().toISOString().slice(0,10);
  o.exit_price = o.entry_price; // caller should provide price, but fallback
  o.exit_reason = 'take_profit';
  await saveLocalOrders(orders);
  return o;
}

export async function releaseLocal(id) {
  let orders = await getLocalOrders();
  orders = orders.filter(x => String(x.id) !== String(id));
  // Alternatively mark released, but for local just remove closed
  await saveLocalOrders(orders);
  return true;
}

export async function addLocalNote(id, note) {
  const orders = await getLocalOrders();
  const o = orders.find(x => String(x.id) === String(id));
  if (!o) throw new Error('Not found');
  o.journal_note = String(note);
  await saveLocalOrders(orders);
  return o;
}

export function computeAccount(orders, starting = 100000) {
  let realised = 0, unrealised = 0, wins = 0, losses = 0, open = 0, closed = 0;
  for (const o of orders) {
    if (o.status === 'open') {
      open++;
      // unrealised not computed without current price - 0 for demo
    } else if (o.status === 'closed') {
      closed++;
      const pnl = (Number(o.exit_price) - Number(o.entry_price)) * Number(o.quantity);
      realised += pnl;
      if (pnl >= 0) wins++; else losses++;
    }
  }
  const total = wins + losses;
  return {
    starting_capital: starting,
    realised_pnl: realised,
    unrealised_pnl: unrealised,
    running_amount: starting + realised + unrealised,
    wins, losses, win_rate: total ? (wins / total) * 100 : 0,
    open_trades: open, closed_trades: closed,
    closed_trades: closed,
  };
}
