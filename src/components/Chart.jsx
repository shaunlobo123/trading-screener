import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, Dimensions, TouchableOpacity, ScrollView } from 'react-native';
import Svg, { Rect, Line, G, Text as SvgText, Circle, Path } from 'react-native-svg';

const MA_CONFIG = [
  { period: 10, color: '#664d00', width: 1 },
  { period: 20, color: '#9900ff', width: 1 },
  { period: 50, color: '#1976d2', width: 1.2 },
];

function sma(candles, period) {
  let sum = 0;
  const out = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close;
    if (i >= period) sum -= candles[i - period].close;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export default function Chart({
  candles = [],
  entryPrice = null,
  stopPrice = null,
  transactionMarkers = [],
  onPickPrice = null,
  height = 280,
  showMAs = true,
}) {
  const [pickMode, setPickMode] = useState(null); // 'entry' | 'stop' | null
  const width = Dimensions.get('window').width - 16; // account for padding
  const chartW = width;
  const chartH = height;
  const volH = 48;
  const candleH = chartH - volH - 18; // leave room for labels

  const stats = useMemo(() => {
    if (!candles.length) return null;
    let min = Infinity, max = -Infinity, volMax = 0;
    for (const c of candles) {
      if (c.low < min) min = c.low;
      if (c.high > max) max = c.high;
      if (c.volume > volMax) volMax = c.volume;
    }
    // Include entry/stop in range so lines visible
    if (entryPrice != null && Number.isFinite(Number(entryPrice))) {
      const v = Number(entryPrice);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (stopPrice != null && Number.isFinite(Number(stopPrice))) {
      const v = Number(stopPrice);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const pad = (max - min) * 0.08 || max * 0.02 || 1;
    return { min: min - pad, max: max + pad, volMax: volMax || 1 };
  }, [candles, entryPrice, stopPrice]);

  const sma10 = useMemo(() => (candles.length ? sma(candles, 10) : []), [candles]);
  const sma20 = useMemo(() => (candles.length ? sma(candles, 20) : []), [candles]);
  const sma50 = useMemo(() => (candles.length ? sma(candles, 50) : []), [candles]);

  if (!candles.length || !stats) {
    return (
      <View style={[styles.empty, { height }]}>
        <Text style={styles.emptyText}>No candle data</Text>
        <Text style={styles.emptySub}>Pick a symbol from screener</Text>
      </View>
    );
  }

  const { min, max, volMax } = stats;
  const range = max - min || 1;
  const n = candles.length;
  // candle width calc: minimal 4px, max to fill screen. Use 6px per candle default, scroll if needed
  const candleW = Math.max(4, Math.min(10, (chartW - 40) / Math.max(30, n)));
  const gap = 2;
  const step = candleW + gap;
  const contentW = n * step + 40; // 40 for y-axis area
  const yForPrice = (p) => {
    // top padding 8
    return 8 + ((max - p) / range) * (candleH - 16);
  };
  const xForIndex = (i) => 8 + i * step + candleW / 2;

  const handlePress = (evt) => {
    if (!pickMode || !onPickPrice) return;
    // evt is synthetic from SVG press - we need y coordinate
    // For native, we use touch responder on wrapper to map y to price.
    // Simpler: tapping anywhere cycles through price approximation? We'll use chart tap.
  };

  // Use touch on overlay to pick price
  const onChartTouch = (e) => {
    if (!pickMode || !onPickPrice) return;
    const y = e.nativeEvent.locationY;
    if (y == null) return;
    // Clamp to candle area
    const clampedY = Math.max(8, Math.min(candleH - 8, y));
    const price = max - ((clampedY - 8) / (candleH - 16)) * range;
    onPickPrice(Number(price.toFixed(2)), pickMode);
    setPickMode(null);
  };

  // Build MA paths
  const maPath = (values, color) => {
    let d = '';
    let started = false;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null) continue;
      const x = xForIndex(i);
      const y = yForPrice(v);
      if (!started) { d += `M ${x} ${y}`; started = true; }
      else d += ` L ${x} ${y}`;
    }
    return d;
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{n} candles • {candles[0]?.time} → {candles[n-1]?.time}</Text>
        <View style={styles.legend}>
          {MA_CONFIG.map(m => (
            <View key={m.period} style={styles.legendItem}>
              <View style={[styles.dot, { backgroundColor: m.color }]} />
              <Text style={styles.legendText}>MA{m.period}</Text>
            </View>
          ))}
        </View>
      </View>

      <View
        style={{ height, backgroundColor: '#fff', borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: '#e2e8f0' }}
        onStartShouldSetResponder={() => !!pickMode}
        onResponderRelease={onChartTouch}
      >
        <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
          <Svg width={contentW} height={height} onPress={handlePress}>
            {/* grid */}
            {[0, 0.25, 0.5, 0.75, 1].map((t) => {
              const y = 8 + t * (candleH - 16);
              const price = max - t * range;
              return (
                <G key={t}>
                  <Line x1={0} y1={y} x2={contentW - 40} y2={y} stroke="#f1f5f9" strokeWidth={1} />
                  <SvgText x={contentW - 38} y={y + 3} fontSize={9} fill="#64748b" fontWeight="500">
                    {price.toFixed(2)}
                  </SvgText>
                </G>
              );
            })}

            {/* MAs */}
            {showMAs && <Path d={maPath(sma10, MA_CONFIG[0].color)} stroke={MA_CONFIG[0].color} strokeWidth={1} fill="none" opacity={0.9} />}
            {showMAs && <Path d={maPath(sma20, MA_CONFIG[1].color)} stroke={MA_CONFIG[1].color} strokeWidth={1} fill="none" opacity={0.9} />}
            {showMAs && <Path d={maPath(sma50, MA_CONFIG[2].color)} stroke={MA_CONFIG[2].color} strokeWidth={1.2} fill="none" opacity={0.9} />}

            {/* candles + volume */}
            {candles.map((c, i) => {
              const x = 8 + i * step;
              const cx = x + candleW / 2;
              const yHigh = yForPrice(c.high);
              const yLow = yForPrice(c.low);
              const yOpen = yForPrice(c.open);
              const yClose = yForPrice(c.close);
              const bodyTop = Math.min(yOpen, yClose);
              const bodyH = Math.max(2, Math.abs(yOpen - yClose));
              const isUp = c.close >= c.open;
              const volHgt = (c.volume / volMax) * (volH - 4);
              const volY = candleH + 8 + (volH - 4 - volHgt);
              const marker = transactionMarkers.find(m => String(m.date).slice(0,10) === String(c.time).slice(0,10));
              return (
                <G key={i}>
                  {/* wick */}
                  <Line x1={cx} y1={yHigh} x2={cx} y2={yLow} stroke={isUp ? '#16a34a' : '#dc2626'} strokeWidth={1.2} />
                  {/* body */}
                  <Rect x={x} y={bodyTop} width={candleW} height={bodyH} fill={isUp ? '#16a34a' : '#dc2626'} stroke={isUp ? '#15803d' : '#b91c1c'} strokeWidth={0.6} rx={1} />
                  {/* volume */}
                  <Rect x={x} y={volY} width={candleW} height={volHgt} fill={isUp ? '#bbf7d0' : '#fecaca'} opacity={0.9} />
                  {/* marker dot */}
                  {marker && (
                    <G>
                      <Circle cx={cx} cy={marker.kind === 'exit' ? bodyTop - 10 : bodyTop + bodyH + 10} r={5} fill={marker.kind === 'exit' ? '#ef4444' : '#3b82f6'} />
                      <SvgText x={cx} y={marker.kind === 'exit' ? bodyTop - 14 : bodyTop + bodyH + 22} fontSize={7} fill={marker.kind === 'exit' ? '#ef4444' : '#3b82f6'} textAnchor="middle" fontWeight="700">
                        {marker.kind === 'exit' ? 'S' : 'B'}
                      </SvgText>
                    </G>
                  )}
                </G>
              );
            })}

            {/* entry/stop lines */}
            {entryPrice != null && Number.isFinite(Number(entryPrice)) && (
              <G>
                <Line x1={0} y1={yForPrice(Number(entryPrice))} x2={contentW - 40} y2={yForPrice(Number(entryPrice))} stroke="#2563eb" strokeWidth={1.4} strokeDasharray="6 4" />
                <Rect x={contentW - 40} y={yForPrice(Number(entryPrice)) - 9} width={40} height={18} fill="#2563eb" rx={3} />
                <SvgText x={contentW - 20} y={yForPrice(Number(entryPrice)) + 3} fontSize={8} fill="#fff" textAnchor="middle" fontWeight="700">
                  E {Number(entryPrice).toFixed(2)}
                </SvgText>
              </G>
            )}
            {stopPrice != null && Number.isFinite(Number(stopPrice)) && (
              <G>
                <Line x1={0} y1={yForPrice(Number(stopPrice))} x2={contentW - 40} y2={yForPrice(Number(stopPrice))} stroke="#ef4444" strokeWidth={1.4} strokeDasharray="6 4" />
                <Rect x={contentW - 40} y={yForPrice(Number(stopPrice)) - 9} width={40} height={18} fill="#ef4444" rx={3} />
                <SvgText x={contentW - 20} y={yForPrice(Number(stopPrice)) + 3} fontSize={8} fill="#fff" textAnchor="middle" fontWeight="700">
                  S {Number(stopPrice).toFixed(2)}
                </SvgText>
              </G>
            )}

            {/* volume bg */}
            <Rect x={0} y={candleH + 4} width={contentW} height={volH} fill="#f8fafc" />
            <Line x1={0} y1={candleH + 4} x2={contentW} y2={candleH + 4} stroke="#e2e8f0" strokeWidth={1} />
          </Svg>
        </ScrollView>

        {pickMode && (
          <View style={styles.pickOverlay}>
            <Text style={styles.pickText}>Tap chart to pick {pickMode === 'entry' ? 'ENTRY' : 'STOP'} price</Text>
            <TouchableOpacity onPress={() => setPickMode(null)} style={styles.pickCancel}><Text style={styles.pickCancelText}>Cancel</Text></TouchableOpacity>
          </View>
        )}
      </View>

      <View style={styles.pickRow}>
        <TouchableOpacity style={[styles.pickBtn, pickMode==='entry' && styles.pickActive]} onPress={() => setPickMode(pickMode==='entry'?null:'entry')}>
          <Text style={[styles.pickBtnText, pickMode==='entry' && styles.pickActiveText]}>Pick Entry</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.pickBtn, pickMode==='stop' && styles.pickActive, { backgroundColor: pickMode==='stop' ? '#fef2f2' : '#fff', borderColor: '#fecaca'}]} onPress={() => setPickMode(pickMode==='stop'?null:'stop')}>
          <Text style={[styles.pickBtnText, pickMode==='stop' && { color:'#dc2626'}]}>Pick Stop</Text>
        </TouchableOpacity>
        <Text style={styles.hint}>Scroll → more candles</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 8, paddingTop: 6 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, paddingHorizontal: 4 },
  headerTitle: { fontSize: 11, color: '#475569', fontWeight: '500' },
  legend: { flexDirection: 'row', gap: 8 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: 10, color: '#64748b' },
  empty: { backgroundColor: '#f8fafc', borderRadius: 10, borderWidth: 1, borderColor: '#e2e8f0', alignItems: 'center', justifyContent: 'center' },
  emptyText: { fontSize: 14, fontWeight: '700', color: '#334155' },
  emptySub: { fontSize: 12, color: '#64748b', marginTop: 4 },
  pickOverlay: { position: 'absolute', top: 8, left: 8, right: 8, backgroundColor: 'rgba(15,23,42,0.92)', borderRadius: 8, padding: 10, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  pickText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  pickCancel: { backgroundColor: '#fff', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6 },
  pickCancelText: { color: '#0f172a', fontSize: 12, fontWeight: '700' },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, paddingHorizontal: 2 },
  pickBtn: { borderWidth: 1, borderColor: '#bfdbfe', backgroundColor: '#eff6ff', paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8 },
  pickActive: { backgroundColor: '#dbeafe', borderColor: '#3b82f6' },
  pickBtnText: { fontSize: 12, fontWeight: '700', color: '#2563eb' },
  pickActiveText: { color: '#1d4ed8' },
  hint: { fontSize: 11, color: '#94a3b8', marginLeft: 'auto' },
});
