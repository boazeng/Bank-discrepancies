#!/bin/bash
# Pull the latest code and restart the service. Run on the EC2 box after pushing.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

echo "== Updating Bank Discrepancies =="
git pull --ff-only
./.venv/bin/pip install -q -r requirements.txt
(cd backend/close_receipt && npm install --omit=dev --silent)
sudo systemctl restart bank-discrepancies
sleep 2
sudo systemctl --no-pager status bank-discrepancies | head -n 12
echo "-- done. Tail logs with: journalctl -u bank-discrepancies -f"
