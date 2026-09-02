#!/bin/bash
# Kill anything on 4020 then start backend from trading_app
set -e
echo "Killing old backend on 4020..."
lsof -ti:4020 | xargs kill -9 2>/dev/null || fuser -k 4020/tcp 2>/dev/null || pkill -f "node server.js" 2>/dev/null || true
sleep 1
echo "Starting backend on 0.0.0.0:4020 from $(pwd)/backend..."
cd backend && npm start
