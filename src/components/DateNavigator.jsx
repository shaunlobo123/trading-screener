import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Alert } from 'react-native';

export default function DateNavigator({ date, onChangeDate, onPrev, onNext, earliest, onGenerate, generating }) {
  const [manual, setManual] = useState(date);

  React.useEffect(() => { setManual(date); }, [date]);

  const submitManual = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(manual)) return Alert.alert('Date must be YYYY-MM-DD');
    onChangeDate(manual);
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <TouchableOpacity onPress={onPrev} style={styles.navBtn}><Text style={styles.navText}>◀ Prev</Text></TouchableOpacity>
        <View style={styles.dateBox}>
          <Text style={styles.dateLabel}>Trading Date</Text>
          <Text style={styles.dateValue}>{date || '—'}</Text>
        </View>
        <TouchableOpacity onPress={onNext} style={styles.navBtn}><Text style={styles.navText}>Next ▶</Text></TouchableOpacity>
      </View>

      <View style={styles.manualRow}>
        <TextInput value={manual} onChangeText={setManual} placeholder="YYYY-MM-DD" style={styles.input} autoCapitalize="none" />
        <TouchableOpacity onPress={submitManual} style={styles.goBtn}><Text style={styles.goText}>Go</Text></TouchableOpacity>
        <TouchableOpacity onPress={onGenerate} disabled={generating} style={[styles.genBtn, generating && { opacity: 0.5 }]}>
          <Text style={styles.genText}>{generating ? 'Generating...' : 'Generate'}</Text>
        </TouchableOpacity>
      </View>
      {earliest ? <Text style={styles.earliest}>Earliest: {earliest}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#e2e8f0', padding: 10, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  navBtn: { backgroundColor: '#0f172a', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8 },
  navText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  dateBox: { flex: 1, alignItems: 'center', backgroundColor: '#f8fafc', paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: '#e2e8f0' },
  dateLabel: { fontSize: 10, color: '#64748b', fontWeight: '600' },
  dateValue: { fontSize: 14, fontWeight: '800', color: '#0f172a' },
  manualRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: { flex: 1, borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, backgroundColor: '#f8fafc' },
  goBtn: { backgroundColor: '#2563eb', paddingHorizontal: 14, paddingVertical: 9, borderRadius: 8 },
  goText: { color: '#fff', fontWeight: '700', fontSize: 12 },
  genBtn: { backgroundColor: '#7c3aed', paddingHorizontal: 14, paddingVertical: 9, borderRadius: 8 },
  genText: { color: '#fff', fontWeight: '700', fontSize: 12 },
  earliest: { fontSize: 11, color: '#94a3b8', textAlign: 'center' },
});
