#!/bin/bash
# Start Expo for Expo Go 54.0.2 — use tunnel (most reliable) or lan
set -e
MODE=${1:-tunnel} # tunnel or lan
if [ "$MODE" = "lan" ]; then
  echo "Starting Expo on LAN (phone + laptop must be on same WiFi: lobowifi)..."
  npx expo start --host lan --port 8081 --clear
else
  echo "Starting Expo on TUNNEL (works even if LAN blocked)..."
  npx expo start --tunnel --port 8081 --clear
fi
