#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────
# EC2 setup for Bank Discrepancies (הפקת קבלות)
# Mirrors the supplierinvoice deployment: EC2 + systemd + nginx + .env on box.
#
# Run ONCE on the instance (Amazon Linux 2023 or Ubuntu):
#   curl -fsSL <raw-url>/deploy/setup_ec2.sh | bash       # or scp + bash
# Idempotent enough to re-run; it will not overwrite an existing .env.
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_URL="https://github.com/boazeng/Bank-discrepancies.git"
APP_USER="${SUDO_USER:-$(whoami)}"
HOME_DIR="$(getent passwd "$APP_USER" | cut -d: -f6)"
APP_DIR="$HOME_DIR/Bank-discrepancies"
ENV_DIR="$HOME_DIR/env"
ENV_FILE="$ENV_DIR/.env"

echo "== Bank Discrepancies EC2 setup =="
echo "user=$APP_USER  app_dir=$APP_DIR  env_file=$ENV_FILE"

# 1. System packages (Python + git; Node only if you want to rebuild the UI)
if command -v dnf &>/dev/null; then
    sudo dnf install -y python3.11 python3.11-pip git nginx
    PYTHON=python3.11
elif command -v apt &>/dev/null; then
    sudo apt update -y
    sudo apt install -y python3 python3-pip python3-venv git nginx
    PYTHON=python3
else
    echo "Unsupported OS (need dnf or apt)" >&2; exit 1
fi

# 2. Clone or update the repo
if [ -d "$APP_DIR/.git" ]; then
    echo "-- repo exists, pulling latest"
    git -C "$APP_DIR" pull --ff-only
else
    git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

# 3. Python venv + dependencies (includes gunicorn)
$PYTHON -m venv .venv
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install -r requirements.txt

# 4. Secrets: central .env OUTSIDE the repo, chmod 600, never in git.
mkdir -p "$ENV_DIR"
if [ ! -f "$ENV_FILE" ]; then
    cp .env.example "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo ""
    echo "*** CREATED $ENV_FILE from template — EDIT IT NOW with real Priority creds:"
    echo "      nano $ENV_FILE"
    echo "    (PRIORITY_URL_REAL / PRIORITY_USERNAME / PRIORITY_PASSWORD)"
    echo ""
else
    echo "-- $ENV_FILE already exists, leaving it untouched"
fi

# 5. The UI (dist/) is committed to the repo and served by Flask directly.
#    If you ever need to rebuild it and have Node installed:
#       npm ci && npm run build
[ -d dist ] && echo "-- dist/ present (UI prebuilt)" || echo "!! dist/ missing — run 'npm run build'"

# 6. systemd service
sudo cp deploy/bank-discrepancies.service /etc/systemd/system/bank-discrepancies.service
sudo systemctl daemon-reload
sudo systemctl enable bank-discrepancies

# 7. nginx reverse proxy (edit the server_name/cert paths first!)
sudo cp deploy/nginx-bank.conf /etc/nginx/conf.d/zz-bank.conf
echo "-- copied nginx config to /etc/nginx/conf.d/zz-bank.conf"
echo "   EDIT it for your real subdomain + cert, then: sudo nginx -t && sudo systemctl reload nginx"

cat <<EOF

== Setup done. Final steps ==
1. Edit secrets:        nano $ENV_FILE
2. Edit nginx domain:   sudo nano /etc/nginx/conf.d/zz-bank.conf
3. (TLS) issue cert:    sudo certbot --nginx -d <your-subdomain>
4. Start the app:       sudo systemctl start bank-discrepancies
5. Check it:            sudo systemctl status bank-discrepancies
                        journalctl -u bank-discrepancies -f
6. Reload nginx:        sudo nginx -t && sudo systemctl reload nginx
EOF
