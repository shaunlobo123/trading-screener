import React, { useEffect, useState, useCallback } from 'react';
import { StatusBar } from 'expo-status-bar';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput, Alert,
  ActivityIndicator, RefreshControl, Platform, KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import * as Haptics from 'expo-haptics';
import { API_URL, isBackendReachable } from './src/lib/config';
import { getToken, saveToken, login, fetchMe, getApiUrl, setApiUrl, apiFetch } from './src/lib/api';
import { riskSizedQuantity, numberText } from './src/lib/utils';
import { runScreens } from './src/lib/screener';
import { SAMPLE_UNIVERSE, SAMPLE_DATES } from './src/lib/sampleData';
import * as Local from './src/lib/localStore';
import Chart from './src/components/Chart';
import ScreenerTable from './src/components/ScreenerTable';
import OrderPanel from './src/components/OrderPanel';
import Holdings from './src/components/Holdings';
import DateNavigator from './src/components/DateNavigator';

const THEME = {
  bg: '#f8fafc',
  card: '#ffffff',
  border: '#e2e8f0',
  primary: '#0f172a',
  accent: '#6366f1',
  accentLight: '#eef2ff',
  success: '#10b981',
  danger: '#ef4444',
  muted: '#64748b',
  mutedLight: '#f1f5f9',
};

// ---------- Demo user helpers ----------
async function saveDemoUser(username) {
  const u = { username: username || 'demo', isDemo: true, riskPerTrade: 200, trainingRiskPerTrade: 200, tradingChartTv: true };
  await Local.saveLocalUser(u);
  return u;
}

// ---------- Polished Tab Bar ----------
function TabBar({ active, onChange, paperState }) {
  const tabs = [
    { id: 'screener', label: 'Explore', icon: '◉' },
    { id: 'chart', label: 'Chart', icon: '∿' },
    { id: 'holdings', label: 'Positions', icon: '⬣', badge: (paperState?.orders || []).filter(o => ['open', 'pending'].includes(o.status)).length },
    { id: 'trades', label: 'Results', icon: '◎' },
    { id: 'more', label: 'You', icon: '○' },
  ];
  return (
    <View style={styles.tabBar}>
      {tabs.map(t => (
        <TouchableOpacity
          key={t.id}
          onPress={() => { Haptics.selectionAsync().catch(()=>{}); onChange(t.id); }}
          style={[styles.tab, active === t.id && styles.tabActive]}
          activeOpacity={0.7}
        >
          <Text style={[styles.tabIcon, active === t.id && styles.tabIconActive]}>{t.icon}</Text>
          <Text style={[styles.tabLabel, active === t.id && styles.tabLabelActive]}>{t.label}</Text>
          {t.badge ? <View style={styles.badge}><Text style={styles.badgeText}>{t.badge}</Text></View> : null}
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ---------- Login: demo-first, backend optional ----------
function LoginScreen({ onLogin }) {
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [showBackend, setShowBackend] = useState(false);
  const [backendStatus, setBackendStatus] = useState(null); // null | 'checking' | 'ok' | 'fail'
  const [apiUrl, setApiUrl] = useState(getApiUrl());

  useEffect(() => {
    setBackendStatus('checking');
    isBackendReachable(apiUrl, 2500).then(ok => setBackendStatus(ok ? 'ok' : 'fail'));
  }, []);

  const doDemo = async () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(()=>{});
    const u = await saveDemoUser(user.trim() || 'demo');
    // also clear any old token
    await saveToken('');
    onLogin(u);
  };

  const doBackendLogin = async () => {
    if (!user.trim() || !pass.trim()) return Alert.alert('Missing info', 'Enter username and password for your private backend.');
    setBusy(true);
    try {
      if (apiUrl.trim() && apiUrl.trim() !== getApiUrl()) setApiUrl(apiUrl.trim());
      const res = await login(user.trim(), pass.trim());
      if (!res.token) throw new Error('No token returned');
      await saveToken(res.token);
      const me = await fetchMe();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(()=>{});
      onLogin({ ...me.user, isDemo: false });
    } catch (e) {
      const msg = e.message || 'Network error';
      const isNetwork = msg.includes('Network') || msg.includes('Failed to fetch') || msg.includes('timeout') || msg.includes('ECONNREFUSED');
      Alert.alert(
        isNetwork ? 'Backend not reachable' : 'Login failed',
        isNetwork
          ? `Can't reach ${getApiUrl()}.\n\nYour iPhone must be on the same WiFi as the laptop (lobowifi) and the backend must be running:\n\n  cd ~/trading_app/backend && npm start\n\nOr just use Demo Mode — all algorithms run on-device, no backend needed.`
          : msg,
        isNetwork ? [{ text: 'Use Demo Mode', onPress: doDemo }, { text: 'OK' }] : undefined
      );
    } finally { setBusy(false); }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.loginWrap}>
      <View style={styles.loginCard}>
        <View style={styles.loginBrand}>
          <View style={styles.loginLogo}><Text style={styles.loginLogoText}>◉</Text></View>
          <Text style={styles.loginTitle}>Screener</Text>
          <Text style={styles.loginSub}>Momentum • Pattern • Paper Trading</Text>
        </View>

        <Text style={styles.loginTagline}>On-device algorithms — same math as the desktop app, but instant and offline.</Text>

        <View style={styles.loginField}>
          <Text style={styles.label}>Username</Text>
          <TextInput
            value={user} onChangeText={setUser}
            placeholder="demo" placeholderTextColor="#94a3b8"
            style={styles.input} autoCapitalize="none" autoCorrect={false}
            returnKeyType="next"
          />
        </View>

        <TouchableOpacity onPress={doDemo} style={styles.primaryBtn} activeOpacity={0.9}>
          <Text style={styles.primaryBtnText}>Continue in Demo Mode →</Text>
        </TouchableOpacity>
        <Text style={styles.loginHint}>No password needed. All screens & trading run locally on your phone.</Text>

        <View style={styles.divider}><View style={styles.dividerLine} /><Text style={styles.dividerText}>or connect to your private backend</Text><View style={styles.dividerLine} /></View>

        {!showBackend ? (
          <TouchableOpacity onPress={() => setShowBackend(true)} style={styles.secondaryBtn}>
            <Text style={styles.secondaryBtnText}>Connect to Private Backend</Text>
          </TouchableOpacity>
        ) : (
          <>
            <View style={styles.loginField}>
              <Text style={styles.label}>Password (backend)</Text>
              <TextInput
                value={pass} onChangeText={setPass}
                placeholder="••••••••" secureTextEntry style={styles.input}
              />
            </View>
            <View style={styles.backendRow}>
              <Text style={[styles.backendDot, backendStatus === 'ok' ? { backgroundColor: THEME.success } : backendStatus === 'fail' ? { backgroundColor: THEME.danger } : { backgroundColor: '#f59e0b' }]} />
              <Text style={styles.backendText}>
                {backendStatus === 'checking' ? 'Checking backend…' : backendStatus === 'ok' ? `Backend reachable at ${apiUrl}` : `Backend not reachable at ${apiUrl}`}
              </Text>
            </View>
            <TouchableOpacity onPress={doBackendLogin} disabled={busy} style={[styles.secondaryBtn, styles.backendLoginBtn, busy && { opacity: 0.6 }]}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={[styles.secondaryBtnText, { color: '#fff' }]}>Log in to Backend</Text>}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowBackend(false)} style={{ alignItems: 'center', marginTop: 8 }}>
              <Text style={{ color: THEME.muted, fontSize: 12 }}>Hide</Text>
            </TouchableOpacity>
          </>
        )}

        <Text style={styles.loginFoot}>Demo mode uses embedded SAMPLE_UNIVERSE (12 symbols) and runs the frozen `passesMomentum` / `passesPattern` logic directly on-device via `src/lib/screener.js` — no server, no API URL.</Text>
      </View>
    </KeyboardAvoidingView>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [activeTab, setActiveTab] = useState('screener');

  // screener (local-first)
  const [date, setDate] = useState(SAMPLE_DATES[SAMPLE_DATES.length - 1]); // latest sample date
  const [market, setMarket] = useState('US');
  const [trainDataset, setTrainDataset] = useState('av'); // for demo, av; norgate also supported via relaxed flag
  const isNg = trainDataset === 'norgate';
  const activeDataset = isNg ? 'norgate' : 'av';
  const [screen, setScreen] = useState('momentum');
  const [rows, setRows] = useState([]);
  const [loadingRows, setLoadingRows] = useState(false);
  const [selected, setSelected] = useState(null);
  const [candles, setCandles] = useState([]);
  const [candlePeriod, setCandlePeriod] = useState('daily');
  const [loadingCandles, setLoadingCandles] = useState(false);

  // paper (local)
  const [paperOrders, setPaperOrders] = useState([]);
  const [paperSession, setPaperSession] = useState(null);
  const [advancing, setAdvancing] = useState(false);

  const riskPerTrade = user?.trainingRiskPerTrade ?? user?.riskPerTrade ?? 200;

  // --- init: try local user first, then token-based backend user ---
  useEffect(() => {
    (async () => {
      const local = await Local.getLocalUser();
      if (local) { setUser(local); setChecking(false); return; }
      const t = await getToken();
      if (!t) { setChecking(false); return; }
      try {
        const me = await fetchMe();
        setUser({ ...me.user, isDemo: false });
      } catch {
        await saveToken('');
        // fall back to demo prompt
      } finally { setChecking(false); }
    })();
  }, []);

  // --- load local paper state ---
  const refreshLocalPaper = useCallback(async () => {
    const orders = await Local.getLocalOrders();
    const sess = await Local.getLocalSession();
    setPaperOrders(orders);
    if (sess?.trading_date && !date) setDate(sess.trading_date);
    setPaperSession(sess);
  }, []);

  useEffect(() => { if (user) refreshLocalPaper(); }, [user, refreshLocalPaper]);

  // --- run screens locally (instant) ---
  const runLocal = useCallback(async (targetDate = date) => {
    if (!targetDate) return;
    setLoadingRows(true);
    try {
      // For demo we have a small universe; in connected mode we could fetch from backend
      // Here we always run on-device for smoothness
      const relaxed = isNg;
      const { momentum, pattern } = runScreens(SAMPLE_UNIVERSE, targetDate, { relaxedMomentum: relaxed });
      const result = screen === 'momentum' ? momentum : pattern;
      setRows(result);
    } finally { setLoadingRows(false); }
  }, [date, screen, isNg]);

  useEffect(() => { if (date) runLocal(date); }, [runLocal]);

  const changeMarket = (next) => {
    Haptics.selectionAsync().catch(()=>{});
    if (next === 'NG') { setTrainDataset('norgate'); setMarket('US'); }
    else { setTrainDataset('av'); setMarket(next); }
    setScreen('momentum');
    setRows([]); setSelected(null); setCandles([]);
  };

  // Candles: from local universe or sample
  const loadCandlesFor = useCallback(async (symbol) => {
    if (!symbol || !date) return;
    setLoadingCandles(true);
    try {
      // Local: slice up to date
      const all = SAMPLE_UNIVERSE[symbol] || [];
      let sliced = all.filter(c => c.date <= date);
      // For monthly period, the Chart will handle rollup visually via prop, but we provide daily here
      // Keep as daily; Chart does internal handling? We provide daily and let Chart render.
      // For monthly toggle, we could rollup here, but Chart expects daily and does volume etc.
      // So we just provide sliced daily; period switch is just UI label for now in demo.
      setCandles(sliced);
    } finally { setLoadingCandles(false); }
  }, [date]);

  useEffect(() => { if (selected?.symbol) loadCandlesFor(selected.symbol); }, [selected?.symbol, loadCandlesFor]);

  // Date nav (local)
  const moveDate = async (direction) => {
    const idx = SAMPLE_DATES.indexOf(date);
    if (idx === -1) return;
    const nextIdx = direction === 'next' ? idx + 1 : idx - 1;
    if (nextIdx < 0 || nextIdx >= SAMPLE_DATES.length) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(()=>{});
      return;
    }
    setDate(SAMPLE_DATES[nextIdx]);
    setSelected(null); setCandles([]);
    Haptics.selectionAsync().catch(()=>{});
  };

  const handleSelectSymbol = (row) => {
    Haptics.selectionAsync().catch(()=>{});
    setSelected(row);
    setActiveTab('chart');
  };

  // Paper: place locally, instant
  const handlePlaceOrder = async (payload) => {
    const tradingDate = paperSession?.trading_date || date;
    const entryPrice = payload.limit_price ?? payload.entry_price ?? selected?.close;
    if (payload.order_type === 'market' && !entryPrice) throw new Error('Missing entry price');
    const order = await Local.placeLocalOrder({
      market: payload.market, symbol: payload.symbol,
      order_type: payload.order_type, quantity: payload.quantity,
      limit_price: payload.order_type === 'limit' ? Number(entryPrice) : Number(entryPrice),
      stop_price: payload.stop_price, trading_date: tradingDate,
    });
    // For market, set entry_price to close
    if (order.status === 'open' && !order.entry_price) {
      order.entry_price = Number(entryPrice);
      const orders = await Local.getLocalOrders();
      const idx = orders.findIndex(o => String(o.id) === String(order.id));
      if (idx !== -1) { orders[idx].entry_price = order.entry_price; await Local.saveLocalOrders(orders); }
    }
    await refreshLocalPaper();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(()=>{});
    return order;
  };

  const handleAdvance = async () => {
    setAdvancing(true);
    try {
      const cur = paperSession?.trading_date || date;
      const { session, orders } = await Local.advanceLocalSession(SAMPLE_UNIVERSE, cur);
      setPaperSession(session);
      setDate(session.trading_date);
      setPaperOrders(orders);
      await runLocal(session.trading_date);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(()=>{});
    } catch (e) {
      Alert.alert('No next date', e.message);
    } finally { setAdvancing(false); }
  };

  const handleReset = async () => {
    Alert.alert('Reset local session?', 'Clears all paper trades on this device.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reset', style: 'destructive', onPress: async () => {
        await Local.resetLocal();
        await refreshLocalPaper();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(()=>{});
      }},
    ]);
  };

  const doUpdateStop = async (id, v) => { await Local.updateLocalStop(id, v); await refreshLocalPaper(); };
  const doUpdateEntry = async (id, p) => { await Local.updateLocalEntry(id, p); await refreshLocalPaper(); };
  const doCancel = async (id) => { await Local.cancelLocal(id); await refreshLocalPaper(); };
  const doClose = async (id) => { await Local.closeLocal(id); await refreshLocalPaper(); };
  const doRelease = async (id) => { await Local.releaseLocal(id); await refreshLocalPaper(); };
  const doNote = async (id, n) => { await Local.addLocalNote(id, n); await refreshLocalPaper(); };

  const handleLogout = async () => {
    await Local.clearLocalUser();
    await saveToken('');
    setUser(null); setPaperOrders([]); setPaperSession(null); setRows([]); setSelected(null);
  };

  if (checking) {
    return <View style={styles.center}><ActivityIndicator size="large" color={THEME.primary} /><Text style={{ marginTop: 12, color: THEME.muted }}>Loading…</Text></View>;
  }
  if (!user) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={{ flex: 1, backgroundColor: THEME.bg }}>
          <StatusBar style="dark" />
          <LoginScreen onLogin={setUser} />
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  const paperState = { orders: paperOrders, session: paperSession, account: Local.computeAccount(paperOrders) };
  const selectedMarkers = paperOrders.filter(o => o.symbol === selected?.symbol && o.status !== 'cancelled').flatMap(o => {
    const out = [];
    if (o.entry_date && o.entry_price) out.push({ date: o.entry_date, price: Number(o.entry_price), kind: 'entry', label: 'Buy' });
    if (o.exit_date && o.exit_price) out.push({ date: o.exit_date, price: Number(o.exit_price), kind: 'exit', label: 'Sell' });
    return out;
  });

  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: THEME.bg }}>
        <StatusBar style="dark" />
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>{user.isDemo ? 'Demo' : 'Training'} • {market}{isNg ? ' NG' : ''} • {screen}</Text>
            <Text style={styles.headerSub}>{user.username} • Risk ${riskPerTrade} • {paperSession?.trading_date || date} {user.isDemo ? '• on-device' : '• synced'}</Text>
          </View>
          <TouchableOpacity onPress={handleLogout} style={styles.logoutBtn}><Text style={styles.logoutText}>Switch</Text></TouchableOpacity>
        </View>

        <View style={{ flex: 1 }}>
          {activeTab === 'screener' && (
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, gap: 14 }} refreshControl={<RefreshControl refreshing={loadingRows} onRefresh={() => runLocal()} tintColor={THEME.accent} />}>
              <DateNavigator date={date} onChangeDate={setDate} onPrev={() => moveDate('previous')} onNext={() => moveDate('next')} earliest={SAMPLE_DATES[0]} onGenerate={() => runLocal()} generating={false} />

              <View style={styles.selectorRow}>
                <View style={styles.selectorGroup}>
                  <Text style={styles.selectorLabel}>Market</Text>
                  <View style={styles.pillRow}>
                    {[{ id: 'US', label: 'US' }, { id: 'IN', label: 'IN' }, { id: 'NG', label: 'NG' }].map(m => (
                      <TouchableOpacity key={m.id} onPress={() => changeMarket(m.id)} style={[styles.pill, ((m.id === 'NG' && isNg) || (m.id === market && !isNg)) && styles.pillActive]}>
                        <Text style={[styles.pillText, ((m.id === 'NG' && isNg) || (m.id === market && !isNg)) && styles.pillTextActive]}>{m.label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
                <View style={styles.selectorGroup}>
                  <Text style={styles.selectorLabel}>Screen</Text>
                  <View style={styles.pillRow}>
                    {['momentum', 'pattern'].map(s => (
                      <TouchableOpacity key={s} onPress={() => { Haptics.selectionAsync().catch(()=>{}); setScreen(s); }} style={[styles.pill, screen === s && styles.pillActive]}>
                        <Text style={[styles.pillText, screen === s && styles.pillTextActive]}>{s}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              </View>

              <View style={styles.selectorRow}>
                <TouchableOpacity onPress={() => setCandlePeriod(p => p === 'daily' ? 'monthly' : 'daily')} style={styles.smallPill}>
                  <Text style={styles.smallPillText}>{candlePeriod === 'daily' ? 'Daily' : 'Monthly'} • tap to switch</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={handleAdvance} disabled={advancing} style={[styles.smallPill, { backgroundColor: THEME.success, borderColor: THEME.success }]}>
                  <Text style={[styles.smallPillText, { color: '#fff' }]}>{advancing ? '…' : 'Next Day →'}</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.infoCard}>
                <Text style={styles.infoTitle}>On-device • Frozen math • {rows.length} matches</Text>
                <Text style={styles.infoSub}>Momentum: 1/3/6m >20% + ADR>4.5  •  Pattern: red,red,green + last.close>prev.high  •  ATR Wilder 14. No backend needed.</Text>
              </View>

              {loadingRows ? <ActivityIndicator color={THEME.accent} /> : <ScreenerTable rows={rows} selectedSymbol={selected?.symbol} onSelect={handleSelectSymbol} market={market} screen={screen} />}

              {selected && (
                <View style={{ gap: 12 }}>
                  <Chart candles={candles} entryPrice={selected.close} stopPrice={null} transactionMarkers={selectedMarkers} height={260} />
                  <OrderPanel selectedRow={selected} date={date} market={market} dataset={activeDataset} riskPerTrade={riskPerTrade} onPlaceOrder={handlePlaceOrder} paperState={paperState} />
                </View>
              )}
            </ScrollView>
          )}

          {activeTab === 'chart' && (
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, gap: 14 }}>
              {selected ? (
                <>
                  <View style={styles.card}>
                    <Text style={styles.cardTitle}>{selected.symbol} • {market} • {candlePeriod}</Text>
                    <Text style={styles.cardSub}>{date} • {candles.length} candles • local</Text>
                  </View>
                  {loadingCandles ? <ActivityIndicator color={THEME.accent} /> : <Chart candles={candles} transactionMarkers={selectedMarkers} height={380} />}
                  <OrderPanel selectedRow={selected} date={date} market={market} dataset={activeDataset} riskPerTrade={riskPerTrade} onPlaceOrder={handlePlaceOrder} paperState={paperState} />
                </>
              ) : (
                <View style={styles.emptyChart}>
                  <Text style={styles.emptyTitle}>No symbol</Text>
                  <Text style={styles.emptySub}>Pick one in Explore</Text>
                  <TouchableOpacity onPress={() => setActiveTab('screener')} style={styles.goScreener}><Text style={styles.goScreenerText}>Explore →</Text></TouchableOpacity>
                </View>
              )}
            </ScrollView>
          )}

          {activeTab === 'holdings' && (
            <View style={{ flex: 1, padding: 14, gap: 14 }}>
              <View style={styles.holdingsHeader}>
                <View>
                  <Text style={styles.holdingsTitle}>Positions</Text>
                  <Text style={styles.holdingsSub}>{paperSession?.trading_date || date} • {paperOrders.filter(o=>['open','pending'].includes(o.status)).length} open • local</Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TouchableOpacity onPress={handleAdvance} disabled={advancing} style={[styles.actionBtn, { backgroundColor: THEME.success }]}><Text style={styles.actionText}>{advancing ? '…' : 'Next Day'}</Text></TouchableOpacity>
                  <TouchableOpacity onPress={handleReset} style={[styles.actionBtn, { backgroundColor: THEME.muted }]}><Text style={styles.actionText}>Reset</Text></TouchableOpacity>
                </View>
              </View>
              <View style={styles.accountCard}>
                <Text style={styles.accountTitle}>${numberText(paperState.account.running_amount)} <Text style={{ fontWeight: '400', color: THEME.muted }}>• started 100k</Text></Text>
                <View style={styles.accountRow}>
                  <Text style={styles.accountLabel}>Realised <Text style={{ color: paperState.account.realised_pnl >= 0 ? THEME.success : THEME.danger }}>${numberText(paperState.account.realised_pnl)}</Text></Text>
                  <Text style={styles.accountLabel}>Win {paperState.account.wins} • Loss {paperState.account.losses} • {paperState.account.win_rate ? paperState.account.win_rate.toFixed(1)+'%' : '—'}</Text>
                </View>
              </View>
              <Holdings
                orders={paperOrders}
                onUpdateStop={doUpdateStop}
                onUpdateEntry={doUpdateEntry}
                onCancel={doCancel}
                onClose={doClose}
                onFill={async()=>{ /* local fill is auto on Next Day */ Alert.alert('Local mode', 'Pending fills automatically on Next Day when low ≤ limit.'); }}
                onRelease={doRelease}
                onNote={doNote}
                onSelectSymbol={(o) => { setSelected({ symbol: o.symbol, close: o.entry_price || '', market: o.market }); setActiveTab('chart'); }}
              />
            </View>
          )}

          {activeTab === 'trades' && (
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, gap: 14 }}>
              <View style={styles.accountCard}>
                <Text style={styles.accountTitle}>Performance • {user.username}</Text>
                <Text style={styles.accountLabel}>Realised ${numberText(paperState.account.realised_pnl)} • Running ${numberText(paperState.account.running_amount)}</Text>
                <Text style={styles.accountLabel}>{paperState.account.wins}W / {paperState.account.losses}L • {paperState.account.win_rate ? paperState.account.win_rate.toFixed(1)+'%' : '—'} win • {paperState.account.closed_trades} closed</Text>
              </View>
              <Text style={styles.sectionTitle}>Closed</Text>
              {paperOrders.filter(o=>o.status==='closed').length ? paperOrders.filter(o=>o.status==='closed').map(o => {
                const pnl = o.exit_price!=null ? (Number(o.exit_price)-Number(o.entry_price))*Number(o.quantity) : null;
                return (
                  <View key={o.id} style={styles.tradeRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.tradeSym}>{o.symbol} <Text style={styles.tradeMarket}>{o.market} • {o.exit_reason}</Text></Text>
                      <Text style={styles.tradeMeta}>{numberText(o.entry_price)} → {numberText(o.exit_price)} × {o.quantity} • {o.entry_date} → {o.exit_date}</Text>
                    </View>
                    <Text style={[styles.tradePnl, { color: (pnl||0)>=0 ? THEME.success : THEME.danger }]}>{pnl!=null ? `${pnl>=0?'+':''}${pnl.toFixed(2)}` : '—'}</Text>
                  </View>
                );
              }) : <Text style={styles.emptyText}>No closed trades yet — place a trade then tap Next Day</Text>}
            </ScrollView>
          )}

          {activeTab === 'more' && (
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, gap: 14 }}>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>{user.username} {user.isDemo ? '• Demo' : '• Connected'}</Text>
                <Text style={styles.cardSub}>{user.isDemo ? 'On-device • no backend • instant' : `Backend • ${getApiUrl()}`}</Text>
                {!user.isDemo && (
                  <TouchableOpacity onPress={async () => {
                    try { const me = await fetchMe(); Alert.alert('Backend OK', JSON.stringify(me.user, null, 2)); } catch(e){ Alert.alert('Backend unreachable', e.message); }
                  }} style={styles.smallPill}><Text style={styles.smallPillText}>Test Backend</Text></TouchableOpacity>
                )}
                {user.isDemo && (
                  <TouchableOpacity onPress={async () => {
                    const ok = await isBackendReachable();
                    Alert.alert(ok ? 'Backend reachable' : 'Backend not reachable', ok ? `Can connect to ${API_URL}. Go to Login to sign in.` : `Not reachable at ${API_URL}.\n\nKeep using demo, or start backend:\n  cd ~/trading_app/backend && npm start`);
                  }} style={styles.smallPill}><Text style={styles.smallPillText}>Check Backend</Text></TouchableOpacity>
                )}
              </View>

              <View style={styles.card}>
                <Text style={styles.cardTitle}>How it works</Text>
                <Text style={styles.hint}>All momentum/pattern/ATR/ADR math runs locally in `src/lib/screener.js` — identical to the frozen `backend/screener.js`. Pick a date, see only stocks that would have been shown then, trade, advance day-by-day. No network needed in demo.</Text>
                <Text style={[styles.hint, { marginTop: 8 }]}>To sync with your private Postgres (alphavantage/norgate), log out and “Connect to Private Backend”.</Text>
              </View>

              <TouchableOpacity onPress={handleLogout} style={styles.logoutFull}><Text style={styles.logoutFullText}>Switch Account</Text></TouchableOpacity>
              <Text style={styles.footerText}>Screener • SDK 54.0.2 • Demo on-device • Backend optional at {API_URL}</Text>
            </ScrollView>
          )}
        </View>

        <TabBar active={activeTab} onChange={setActiveTab} paperState={paperState} />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: THEME.bg },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, backgroundColor: THEME.card, borderBottomWidth: 1, borderBottomColor: THEME.border, paddingTop: Platform.OS === 'android' ? 40 : 12 },
  headerTitle: { color: THEME.primary, fontSize: 13, fontWeight: '800', letterSpacing: 0.2 },
  headerSub: { color: THEME.muted, fontSize: 11, marginTop: 2, fontWeight: '500' },
  logoutBtn: { backgroundColor: THEME.mutedLight, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999 },
  logoutText: { color: THEME.primary, fontSize: 12, fontWeight: '700' },
  loginWrap: { flex: 1, justifyContent: 'center', padding: 20, backgroundColor: THEME.bg },
  loginCard: { backgroundColor: THEME.card, borderRadius: 20, padding: 22, borderWidth: 1, borderColor: THEME.border, gap: 14, shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
  loginBrand: { alignItems: 'center', gap: 6, marginBottom: 4 },
  loginLogo: { width: 44, height: 44, borderRadius: 22, backgroundColor: THEME.primary, alignItems: 'center', justifyContent: 'center' },
  loginLogoText: { color: '#fff', fontSize: 20, fontWeight: '900' },
  loginTitle: { fontSize: 22, fontWeight: '800', color: THEME.primary, letterSpacing: -0.3 },
  loginSub: { fontSize: 12, color: THEME.muted, fontWeight: '600' },
  loginTagline: { fontSize: 13, color: THEME.muted, textAlign: 'center', lineHeight: 18, marginBottom: 4 },
  loginField: { gap: 6 },
  label: { fontSize: 12, fontWeight: '700', color: THEME.primary },
  input: { borderWidth: 1, borderColor: THEME.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, backgroundColor: THEME.bg, color: THEME.primary },
  primaryBtn: { backgroundColor: THEME.primary, paddingVertical: 15, borderRadius: 12, alignItems: 'center' },
  primaryBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  loginHint: { fontSize: 11, color: THEME.muted, textAlign: 'center' },
  loginHintStrong: { fontSize: 11, color: THEME.muted, textAlign: 'center' },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 2 },
  dividerLine: { flex: 1, height: 1, backgroundColor: THEME.border },
  dividerText: { fontSize: 11, color: THEME.muted, fontWeight: '600' },
  secondaryBtn: { backgroundColor: THEME.card, borderWidth: 1, borderColor: THEME.border, paddingVertical: 13, borderRadius: 12, alignItems: 'center' },
  secondaryBtnText: { color: THEME.primary, fontWeight: '700', fontSize: 13 },
  backendLoginBtn: { backgroundColor: THEME.primary, borderColor: THEME.primary },
  backendRow: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: THEME.mutedLight, padding: 10, borderRadius: 10 },
  backendDot: { width: 8, height: 8, borderRadius: 4 },
  backendText: { fontSize: 11, color: THEME.muted, flex: 1, fontWeight: '500' },
  loginFoot: { fontSize: 11, color: THEME.muted, textAlign: 'center', lineHeight: 14 },
  tabBar: { flexDirection: 'row', backgroundColor: THEME.card, borderTopWidth: 1, borderTopColor: THEME.border, paddingBottom: Platform.OS === 'ios' ? 22 : 8, paddingTop: 8, paddingHorizontal: 4 },
  tab: { flex: 1, alignItems: 'center', gap: 3, paddingVertical: 6, borderRadius: 12, position: 'relative' },
  tabActive: { backgroundColor: THEME.mutedLight },
  tabIcon: { fontSize: 16, color: THEME.muted },
  tabIconActive: { color: THEME.primary },
  tabLabel: { fontSize: 10, fontWeight: '600', color: THEME.muted, letterSpacing: 0.2 },
  tabLabelActive: { color: THEME.primary, fontWeight: '800' },
  badge: { position: 'absolute', top: 2, right: 16, backgroundColor: THEME.accent, borderRadius: 999, minWidth: 16, height: 16, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  selectorRow: { flexDirection: 'row', gap: 10 },
  selectorGroup: { flex: 1, backgroundColor: THEME.card, borderRadius: 14, borderWidth: 1, borderColor: THEME.border, padding: 12, gap: 8 },
  selectorLabel: { fontSize: 11, fontWeight: '700', color: THEME.muted, letterSpacing: 0.4 },
  pillRow: { flexDirection: 'row', gap: 6 },
  pill: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: THEME.border, backgroundColor: THEME.card },
  pillActive: { backgroundColor: THEME.primary, borderColor: THEME.primary },
  pillText: { fontSize: 12, fontWeight: '700', color: THEME.primary },
  pillTextActive: { color: '#fff' },
  smallPill: { backgroundColor: THEME.card, borderRadius: 999, borderWidth: 1, borderColor: THEME.border, paddingHorizontal: 14, paddingVertical: 9, alignItems: 'center' },
  smallPillText: { fontSize: 12, fontWeight: '700', color: THEME.primary },
  infoCard: { backgroundColor: THEME.accentLight, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#e0e7ff', gap: 4 },
  infoTitle: { fontSize: 12, fontWeight: '800', color: THEME.accent },
  infoSub: { fontSize: 11, color: '#6366f1', lineHeight: 14 },
  card: { backgroundColor: THEME.card, borderRadius: 16, borderWidth: 1, borderColor: THEME.border, padding: 14, gap: 6 },
  cardTitle: { fontSize: 14, fontWeight: '800', color: THEME.primary },
  cardSub: { fontSize: 11, color: THEME.muted, fontWeight: '500' },
  holdingsHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: THEME.card, borderRadius: 16, borderWidth: 1, borderColor: THEME.border, padding: 14 },
  holdingsTitle: { fontSize: 15, fontWeight: '800', color: THEME.primary },
  holdingsSub: { fontSize: 11, color: THEME.muted, marginTop: 2, fontWeight: '500' },
  actionBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 999 },
  actionText: { color: '#fff', fontSize: 12, fontWeight: '800', letterSpacing: 0.2 },
  accountCard: { backgroundColor: THEME.card, borderRadius: 16, borderWidth: 1, borderColor: THEME.border, padding: 14, gap: 6 },
  accountTitle: { fontSize: 15, fontWeight: '800', color: THEME.primary },
  accountRow: { flexDirection: 'row', gap: 14, flexWrap: 'wrap' },
  accountLabel: { fontSize: 12, color: THEME.muted, fontWeight: '600' },
  sectionTitle: { fontSize: 13, fontWeight: '800', color: THEME.primary, letterSpacing: 0.2 },
  tradeRow: { flexDirection: 'row', backgroundColor: THEME.card, borderRadius: 14, borderWidth: 1, borderColor: THEME.border, padding: 14, gap: 12, alignItems: 'center' },
  tradeSym: { fontSize: 14, fontWeight: '800', color: THEME.primary },
  tradeMarket: { fontSize: 11, color: THEME.muted, fontWeight: '600' },
  tradeMeta: { fontSize: 11, color: THEME.muted, marginTop: 2 },
  tradePnl: { fontSize: 14, fontWeight: '800' },
  emptyText: { fontSize: 13, color: THEME.muted, textAlign: 'center', padding: 14, lineHeight: 18 },
  emptyChart: { backgroundColor: THEME.card, borderRadius: 16, borderWidth: 1, borderColor: THEME.border, padding: 28, alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 15, fontWeight: '800', color: THEME.primary },
  emptySub: { fontSize: 12, color: THEME.muted },
  goScreener: { backgroundColor: THEME.primary, paddingHorizontal: 18, paddingVertical: 11, borderRadius: 999, marginTop: 8 },
  goScreenerText: { color: '#fff', fontWeight: '800', fontSize: 12 },
  hint: { fontSize: 12, color: THEME.muted, lineHeight: 16 },
  logoutFull: { backgroundColor: THEME.card, borderWidth: 1, borderColor: THEME.border, paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
  logoutFullText: { color: THEME.primary, fontWeight: '700', fontSize: 13 },
  footerText: { fontSize: 11, color: THEME.muted, textAlign: 'center', lineHeight: 14 },
});
