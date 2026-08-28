#!/bin/bash
set -e

echo "Installing deps..."
apt-get update
apt-get install -y git ffmpeg python3 python3-pip ca-certificates
update-ca-certificates

echo "Installing yt-dlp..."
pip3 install --no-cache-dir -U yt-dlp

echo "yt-dlp version:"
yt-dlp --version || true

echo "Cloning repo..."
if [ ! -d /app/.git ]; then
  git clone https://github.com/mas94uk/upnpTube.git /app
fi

cd /app
npm install

echo "Patching port..."
find /app -type f -name "*.js" -exec sed -i 's/3000/3005/g' {} +

cat > patch.js << 'EOF'
process.on('uncaughtException', e => console.log('⚠️ Skip:', e.message));
process.on('unhandledRejection', e => console.log('⚠️ Skip:', e.message));
EOF

HOST=192.168.0.154 node -r ./patch.js index.js
