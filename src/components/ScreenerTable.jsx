import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { numberText, percentText, atrPercent, dollarVolumeText } from '../lib/utils';

function Pill({ children, color }) {
  return <View style={[styles.pill, { backgroundColor: color || '#e0f2fe' }]}><Text style={styles.pillText}>{children}</Text></View>;
}

export default function ScreenerTable({ rows = [], selectedSymbol, onSelect, market, screen }) {
  if (!rows.length) {
    return <View style={styles.empty}><Text style={styles.emptyText}>No results — try Generate or change date/market</Text></View>;
  }

  // Sort by sl ascending for momentum? Keep as received (already filtered)
  return (
    <ScrollView style={styles.wrap} horizontal={false}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          {/* header */}
          <View style={[styles.row, styles.header]}>
            <Text style={[styles.cell, styles.symCell, styles.headerText]}>Symbol</Text>
            <Text style={[styles.cell, styles.numCell, styles.headerText]}>Close</Text>
            <Text style={[styles.cell, styles.numCell, styles.headerText]}>%Up</Text>
            <Text style={[styles.cell, styles.numCell, styles.headerText]}>ATR%</Text>
            <Text style={[styles.cell, styles.numCell, styles.headerText]}>SL</Text>
            <Text style={[styles.cell, styles.numCell, styles.headerText]}>Vol</Text>
            {screen === 'momentum' && <Text style={[styles.cell, styles.numCell, styles.headerText]}>1/3/6% </Text>}
            {screen === 'momentum' && <Text style={[styles.cell, styles.numCell, styles.headerText]}>ADR</Text>}
          </View>
          {rows.map((r) => {
            const isSel = selectedSymbol === r.symbol;
            const atrPct = atrPercent(r);
            return (
              <TouchableOpacity key={r.symbol} onPress={() => onSelect(r)} style={[styles.row, isSel && styles.selectedRow]}>
                <View style={[styles.cell, styles.symCell]}>
                  <Text style={[styles.symText, isSel && styles.selText]} numberOfLines={1}>{r.symbol}</Text>
                  <Text style={styles.marketText}>{r.market || market}</Text>
                </View>
                <Text style={[styles.cell, styles.numCell, isSel && styles.selText]}>{numberText(r.close)}</Text>
                <Text style={[styles.cell, styles.numCell, isSel && styles.selText, { color: Number(r.pct_up) >= 0 ? '#16a34a' : '#dc2626'}]}>{percentText(r.pct_up)}</Text>
                <Text style={[styles.cell, styles.numCell, isSel && styles.selText]}>{atrPct != null ? percentText(atrPct) : '—'}</Text>
                <Text style={[styles.cell, styles.numCell, isSel && styles.selText]}>{numberText(r.sl, 2)}</Text>
                <Text style={[styles.cell, styles.numCell, isSel && styles.selText]}>{dollarVolumeText(r.dollar_volume) !== '—' ? dollarVolumeText(r.dollar_volume) : r.volume ? (Number(r.volume) > 1e6 ? (Number(r.volume)/1e6).toFixed(1)+'M' : String(r.volume)) : '—'}</Text>
                {screen === 'momentum' && (
                  <Text style={[styles.cell, styles.numCell, isSel && styles.selText]} numberOfLines={1}>
                    {[r.pct_1mth, r.pct_3mth, r.pct_6mth].map(v => v != null ? `${Number(v).toFixed(1)}%` : '—').join(' / ')}
                  </Text>
                )}
                {screen === 'momentum' && <Text style={[styles.cell, styles.numCell, isSel && styles.selText]}>{r.adr != null ? Number(r.adr).toFixed(2) : '—'}</Text>}
              </TouchableOpacity>
            );
          })}
        </View>
      </ScrollView>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#e2e8f0', maxHeight: 360 },
  empty: { padding: 16, alignItems: 'center', backgroundColor: '#f8fafc', borderRadius: 10, borderWidth: 1, borderColor: '#e2e8f0' },
  emptyText: { color: '#64748b', fontSize: 13, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#f1f5f9', paddingVertical: 8, paddingHorizontal: 6 },
  header: { backgroundColor: '#0f172a', borderTopLeftRadius: 10, borderTopRightRadius: 10 },
  headerText: { color: '#e2e8f0', fontWeight: '700', fontSize: 11 },
  cell: { paddingHorizontal: 6, fontSize: 12 },
  symCell: { width: 88 },
  numCell: { width: 78, textAlign: 'right', fontVariant: ['tabular-nums'] },
  symText: { fontWeight: '700', fontSize: 13, color: '#0f172a' },
  marketText: { fontSize: 10, color: '#64748b' },
  selectedRow: { backgroundColor: '#dbeafe' },
  selText: { color: '#1e40af', fontWeight: '700' },
  pill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999, alignSelf: 'flex-start' },
  pillText: { fontSize: 10, fontWeight: '700', color: '#0f172a' },
});
