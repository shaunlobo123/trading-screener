import Constants from 'expo-constants';
import { Platform } from 'react-native';

// Backend is OPTIONAL now — app works fully offline with on-device algorithms.
// If backend is reachable, we sync; if not, we use local data.
const LAN_IP = '192.168.1.110';
const DEFAULT_PORT = '4020';

function resolveApiUrl() {
  // Priority: EXPO_PUBLIC_API_URL (EAS build env) > app.json extra.apiUrl > LAN fallback
  // For TestFlight/Render, set EXPO_PUBLIC_API_URL=https://<your-render>.onrender.com
  if (process.env.EXPO_PUBLIC_API_URL) return String(process.env.EXPO_PUBLIC_API_URL).replace(/\/$/, '');
  const fromExtra = Constants.expoConfig?.extra?.apiUrl || Constants.manifest?.extra?.apiUrl;
  if (fromExtra) return String(fromExtra).replace(/\/$/, '');
  // Default to LAN for local dev — not required; app works offline via localStore
  if (Platform.OS === 'android') return `http://${LAN_IP}:${DEFAULT_PORT}`;
  return `http://${LAN_IP}:${DEFAULT_PORT}`;
}

export const API_URL = resolveApiUrl();
export const LAN_API_URL = `http://${LAN_IP}:${DEFAULT_PORT}`;

// Helper to check if backend is reachable
export async function isBackendReachable(url = API_URL, timeoutMs = 2500) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${url}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}
