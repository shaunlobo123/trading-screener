import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Alert } from 'react-native';
import { riskSizedQuantity, numberText } from '../lib/utils';

export default function OrderPanel({
  selectedRow,
  date,
  market,
  dataset,
  riskPerTrade,
  onPlaceOrder,
  paperState,
}) {
  const [orderType, setOrderType] = useState('market'); // market | limit
  const [limitPrice, setLimitPrice] = useState('');
  const [stopPrice, setStopPrice] = useState('');
  const [quantity, setQuantity] = useState('');
  const [busy, setBusy] = useState(false);

  const entry = orderType === 'limit' ? Number(limitPrice) : Number(selectedRow?.close);
  const stop = Number(stopPrice);
  const suggestedQty = riskSizedQuantity(riskPerTrade, entry, stop);

  useEffect(() => {
    if (suggestedQty > 0 && !quantity) setQuantity(String(suggestedQty));
  }, [suggestedQty]);

  useEffect(() => {
    // reset when symbol changes
    setLimitPrice(selectedRow?.close ? String(selectedRow.close) : '');
    setStopPrice('');
    setQuantity('');
  }, [selectedRow?.symbol]);

  if (!selectedRow) {
    return <View style={styles.empty}><Text style={styles.emptyText}>Select a symbol from screener to trade</Text></View>;
  }

  const alreadyOwned = (paperState?.orders || []).some(o => o.symbol === selectedRow.symbol && ['open','pending'].includes(o.status));

  const handlePlace = async () => {
    const e = Number(entry);
    const s = Number(stop);
    const q = Number(quantity);
    if (!Number.isFinite(e) || e <= 0) return Alert.alert('Entry invalid');
    if (!Number.isFinite(s) || s <= 0) return Alert.alert('Stop invalid');
    if (s >= e) return Alert.alert('Stop must be below entry');
    if (!Number.isFinite(q) || q <= 0) return Alert.alert('Quantity invalid');
    if (alreadyOwned) return Alert.alert('Already owned', 'One open/pending per symbol in training');

    setBusy(true);
    try {
      await onPlaceOrder({
        market,
        symbol: selectedRow.symbol,
        order_type: orderType,
        quantity: q,
        limit_price: orderType === 'limit' ? e : undefined,
        stop_price: s,
        dataset,
      });
      Alert.alert('Order placed');
    } catch (err) {
      Alert.alert('Order failed', err.message);
    } finally { setBusy(false); }
  };

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.title}>Trade {selectedRow.symbol}</Text>
        <Text style={styles.subtitle}>{market} • {date} • Close {numberText(selectedRow.close)}</Text>
        {alreadyOwned && <Text style={styles.warn}>Already have open/pending — training allows 1 per symbol</Text>}
      </View>

      <View style={styles.row}>
        <TouchableOpacity onPress={() => setOrderType('market')} style={[styles.typeBtn, orderType==='market' && styles.typeActive]}><Text style={[styles.typeText, orderType==='market' && styles.typeActiveText]}>Market</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => setOrderType('limit')} style={[styles.typeBtn, orderType==='limit' && styles.typeActive]}><Text style={[styles.typeText, orderType==='limit' && styles.typeActiveText]}>Limit</Text></TouchableOpacity>
        <View style={styles.risk}><Text style={styles.riskLabel}>Risk/trade</Text><Text style={styles.riskVal}>${Number(riskPerTrade||0).toFixed(0)}</Text></View>
      </View>

      {orderType === 'limit' && (
        <View style={styles.field}>
          <Text style={styles.label}>Limit (entry) price</Text>
          <TextInput value={limitPrice} onChangeText={setLimitPrice} placeholder={String(selectedRow.close)} keyboardType="numeric" style={styles.input} />
        </View>
      )}
      {orderType === 'market' && <View style={styles.info}><Text style={styles.infoText}>Market fills at close: {numberText(selectedRow.close)}</Text></View>}

      <View style={styles.field}>
        <Text style={styles.label}>Stop price</Text>
        <TextInput value={stopPrice} onChangeText={setStopPrice} placeholder="e.g. 142.50" keyboardType="numeric" style={styles.input} />
        {stopPrice ? <Text style={styles.hint}>Risk per share: {(entry - stop).toFixed(2)} • Suggested qty: {suggestedQty}</Text> : null}
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Quantity</Text>
        <View style={styles.qtyRow}>
          <TextInput value={quantity} onChangeText={setQuantity} placeholder={String(suggestedQty || '')} keyboardType="numeric" style={[styles.input, { flex: 1 }]} />
          <TouchableOpacity onPress={() => setQuantity(String(suggestedQty))} style={styles.qtyBtn}><Text style={styles.qtyBtnText}>Use {suggestedQty}</Text></TouchableOpacity>
        </View>
      </View>

      <TouchableOpacity onPress={handlePlace} disabled={busy || alreadyOwned} style={[styles.place, (busy||alreadyOwned) && { opacity: 0.5 }]}>
        <Text style={styles.placeText}>{busy ? 'Placing...' : `Buy ${selectedRow.symbol}`}</Text>
      </TouchableOpacity>
      <Text style={styles.foot}>Stop via chart Pick Stop also works • edit later in Holdings</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { padding: 16, backgroundColor: '#f8fafc', borderRadius: 10, borderWidth: 1, borderColor: '#e2e8f0', alignItems: 'center' },
  emptyText: { color: '#64748b', fontSize: 13 },
  card: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#e2e8f0', padding: 12, gap: 10 },
  head: { gap: 2 },
  title: { fontSize: 16, fontWeight: '800', color: '#0f172a' },
  subtitle: { fontSize: 12, color: '#64748b' },
  warn: { fontSize: 12, color: '#dc2626', fontWeight: '600', marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  typeBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: '#cbd5e1', backgroundColor: '#fff' },
  typeActive: { backgroundColor: '#0f172a', borderColor: '#0f172a' },
  typeText: { fontSize: 13, fontWeight: '700', color: '#334155' },
  typeActiveText: { color: '#fff' },
  risk: { marginLeft: 'auto', alignItems: 'flex-end' },
  riskLabel: { fontSize: 10, color: '#64748b', fontWeight: '600' },
  riskVal: { fontSize: 13, fontWeight: '800', color: '#0f172a' },
  field: { gap: 4 },
  label: { fontSize: 12, fontWeight: '700', color: '#334155' },
  input: { borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, backgroundColor: '#f8fafc' },
  info: { backgroundColor: '#eff6ff', borderRadius: 8, padding: 8, borderWidth: 1, borderColor: '#bfdbfe' },
  infoText: { fontSize: 12, color: '#1d4ed8', fontWeight: '600' },
  hint: { fontSize: 11, color: '#64748b' },
  qtyRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  qtyBtn: { backgroundColor: '#eff6ff', borderWidth: 1, borderColor: '#bfdbfe', paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8 },
  qtyBtnText: { fontSize: 12, fontWeight: '700', color: '#2563eb' },
  place: { backgroundColor: '#16a34a', paddingVertical: 14, borderRadius: 10, alignItems: 'center' },
  placeText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  foot: { fontSize: 11, color: '#94a3b8', textAlign: 'center' },
});
