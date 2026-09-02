import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Alert, ScrollView } from 'react-native';

export default function Holdings({ orders = [], onUpdateStop, onUpdateEntry, onUpdateQuantity, onClose, onCancel, onFill, onRelease, onNote, onSelectSymbol }) {
  const [activeTab, setActiveTab] = useState('open'); // open | pending | closed | all
  const [editingStop, setEditingStop] = useState({});
  const [editingEntry, setEditingEntry] = useState({});

  const filter = (o) => {
    if (activeTab === 'all') return true;
    if (activeTab === 'open') return o.status === 'open';
    if (activeTab === 'pending') return o.status === 'pending';
    if (activeTab === 'closed') return o.status === 'closed';
    return true;
  };
  const visible = orders.filter(filter).sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));

  const renderRow = (o) => {
    const isOpen = o.status === 'open';
    const isPending = o.status === 'pending';
    const isClosed = o.status === 'closed';
    const pnl = o.exit_price != null ? (Number(o.exit_price) - Number(o.entry_price)) * Number(o.quantity) : null;
    return (
      <View key={o.id} style={[styles.row, isClosed && styles.closedRow, isPending && styles.pendingRow]}>
        <TouchableOpacity onPress={() => onSelectSymbol?.(o)} style={styles.symCol}>
          <Text style={styles.sym}>{o.symbol}</Text>
          <Text style={styles.meta}>{o.market} • {o.status}</Text>
          {o.stop_price && <Text style={styles.meta}>Stop {Number(o.stop_price).toFixed(2)}</Text>}
          {o.limit_price && isPending && <Text style={styles.meta}>Limit {Number(o.limit_price).toFixed(2)}</Text>}
          {o.entry_price && <Text style={styles.meta}>Entry {Number(o.entry_price).toFixed(2)} × {o.quantity}</Text>}
          {o.exit_price && <Text style={[styles.meta, { color: (pnl||0) >= 0 ? '#16a34a' : '#dc2626' }]}>Exit {Number(o.exit_price).toFixed(2)} {pnl!=null?`(${pnl>=0?'+':''}${pnl.toFixed(2)})`:''}</Text>}
          {o.journal_note && <Text style={styles.note} numberOfLines={2}>📝 {o.journal_note}</Text>}
        </TouchableOpacity>

        <View style={styles.actions}>
          {(isOpen || isPending) && (
            <>
              <View style={styles.editRow}>
                <TextInput
                  value={editingStop[o.id] ?? String(o.stop_price ?? '')}
                  onChangeText={v => setEditingStop(s => ({...s, [o.id]: v}))}
                  placeholder="Stop"
                  keyboardType="numeric"
                  style={styles.miniInput}
                />
                <TouchableOpacity onPress={async () => {
                  const v = editingStop[o.id] ?? String(o.stop_price ?? '');
                  const n = Number(v);
                  if (!Number.isFinite(n) || n <= 0) return Alert.alert('Invalid stop');
                  try { await onUpdateStop(o.id, n); Alert.alert('Stop updated'); } catch(e){ Alert.alert('Failed', e.message); }
                }} style={styles.miniBtn}><Text style={styles.miniBtnText}>Set</Text></TouchableOpacity>
              </View>
              {isPending && (
                <View style={styles.editRow}>
                  <TextInput
                    value={editingEntry[o.id] ?? String(o.limit_price ?? o.entry_price ?? '')}
                    onChangeText={v => setEditingEntry(s => ({...s, [o.id]: v}))}
                    placeholder="Entry/Limit"
                    keyboardType="numeric"
                    style={styles.miniInput}
                  />
                  <TouchableOpacity onPress={async () => {
                    const v = editingEntry[o.id] ?? '';
                    const n = Number(v);
                    if (!Number.isFinite(n) || n <= 0) return Alert.alert('Invalid entry');
                    try { await onUpdateEntry(o.id, { limit_price: n }); Alert.alert('Entry updated'); } catch(e){ Alert.alert('Failed', e.message); }
                  }} style={styles.miniBtn}><Text style={styles.miniBtnText}>Set</Text></TouchableOpacity>
                </View>
              )}
              <View style={styles.btnRow}>
                {isOpen && <TouchableOpacity onPress={async () => {
                  const qty = await new Promise(res => {
                    Alert.prompt ? Alert.prompt('Close quantity', `Max ${o.quantity}`, (text)=>res(text), 'plain-text', String(o.quantity))
                    : res(String(o.quantity));
                  });
                  // fallback if prompt not available
                  const q = qty ? Number(qty) : Number(o.quantity);
                  if (!Number.isFinite(q) || q<=0) return;
                  try { await onClose(o.id, { quantity: q }); } catch(e){ Alert.alert('Close failed', e.message); }
                }} style={[styles.btn, styles.closeBtn]}><Text style={styles.btnText}>Close</Text></TouchableOpacity>}
                {isPending && <TouchableOpacity onPress={async()=>{ try{await onFill(o.id);}catch(e){Alert.alert('Fill failed',e.message);}}} style={[styles.btn, styles.fillBtn]}><Text style={styles.btnText}>Fill</Text></TouchableOpacity>}
                <TouchableOpacity onPress={async()=>{ try{await onCancel(o.id);}catch(e){Alert.alert('Cancel failed',e.message);}}} style={[styles.btn, styles.cancelBtn]}><Text style={styles.btnText}>Cancel</Text></TouchableOpacity>
              </View>
            </>
          )}
          {isClosed && !o.released_at && !o.partial_close && (
            <TouchableOpacity onPress={async()=>{ try{await onRelease(o.id);}catch(e){Alert.alert('Release failed', e.message);}}} style={[styles.btn, styles.releaseBtn]}><Text style={styles.btnText}>Release</Text></TouchableOpacity>
          )}
          <TouchableOpacity onPress={async()=>{
            const note = await new Promise(res=>{
              if (Alert.prompt) Alert.prompt('Journal note', '', (text)=>res(text), 'plain-text', o.journal_note||'');
              else res(null);
            });
            if (note==null) return;
            try{ await onNote(o.id, note); }catch(e){Alert.alert('Note failed', e.message);}
          }} style={[styles.btn, styles.noteBtn]}><Text style={styles.btnText}>Note</Text></TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.tabs}>
        {['open','pending','closed','all'].map(t => (
          <TouchableOpacity key={t} onPress={()=>setActiveTab(t)} style={[styles.tab, activeTab===t && styles.tabActive]}>
            <Text style={[styles.tabText, activeTab===t && styles.tabActiveText]}>{t.toUpperCase()} ({orders.filter(o=> t==='all'?true:o.status===t).length})</Text>
          </TouchableOpacity>
        ))}
      </View>
      <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 12 }}>
        {visible.length ? visible.map(renderRow) : <View style={styles.empty}><Text style={styles.emptyText}>No {activeTab} orders</Text></View>}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#e2e8f0', overflow: 'hidden' },
  tabs: { flexDirection: 'row', backgroundColor: '#f8fafc', borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  tabActive: { backgroundColor: '#0f172a' },
  tabText: { fontSize: 11, fontWeight: '700', color: '#64748b' },
  tabActiveText: { color: '#fff' },
  list: { flex: 1 },
  empty: { padding: 20, alignItems: 'center' },
  emptyText: { color: '#64748b', fontSize: 13 },
  row: { flexDirection: 'row', padding: 12, borderBottomWidth: 1, borderBottomColor: '#f1f5f9', gap: 12, backgroundColor: '#fff' },
  closedRow: { backgroundColor: '#f8fafc', opacity: 0.85 },
  pendingRow: { backgroundColor: '#fffbeb' },
  symCol: { flex: 1, gap: 2 },
  sym: { fontSize: 15, fontWeight: '800', color: '#0f172a' },
  meta: { fontSize: 11, color: '#64748b' },
  note: { fontSize: 11, color: '#334155', backgroundColor: '#f1f5f9', padding: 6, borderRadius: 6, marginTop: 4 },
  actions: { width: 150, gap: 6 },
  editRow: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  miniInput: { flex: 1, borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6, fontSize: 12, backgroundColor: '#f8fafc' },
  miniBtn: { backgroundColor: '#0f172a', paddingHorizontal: 10, paddingVertical: 7, borderRadius: 6 },
  miniBtnText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  btnRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  btn: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 6, alignItems: 'center', minWidth: 60 },
  btnText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  closeBtn: { backgroundColor: '#16a34a' },
  fillBtn: { backgroundColor: '#2563eb' },
  cancelBtn: { backgroundColor: '#64748b' },
  releaseBtn: { backgroundColor: '#7c3aed' },
  noteBtn: { backgroundColor: '#0ea5e9' },
});
