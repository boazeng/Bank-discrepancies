# Deploying Bank Discrepancies to AWS

Same pattern as **supplierinvoice**: a single **EC2** box, the app run by
**systemd** under **gunicorn**, **nginx** as the public reverse proxy, TLS via
Let's Encrypt behind Cloudflare, and secrets in a **`.env` file on the box**
(never in git).

This service **co-hosts on the same EC2 instance as supplierinvoice** — its own
systemd service, its own nginx `server_name`, and its own port (**5000**, vs
supplierinvoice's 8000). The subdomain makes it feel standalone.

## Architecture

```
Cloudflare ──▶ nginx :443 (server_name bank.<domain>) ──▶ gunicorn 127.0.0.1:5000 ──▶ Flask (backend/server.py)
                                                                                         └─ serves dist/ (Vite/React UI)
                                                                                         └─ proxies Priority OData API
```

## Secrets — how they're handled

| Where | What |
|-------|------|
| **Git repo** | Only `.env.example` (placeholders). `.env` is gitignored. **No real secret is ever committed.** |
| **Your laptop** | Real `.env` in the central folder `C:\Users\User\Aiprojects\env\.env`. |
| **EC2 box** | Real `.env` at `/home/ec2-user/env/.env`, `chmod 600`, outside the repo. The systemd unit points the app at it via `BANK_ENV_FILE`. |

The app resolves its env file in this order (`backend/server.py`):
1. `BANK_ENV_FILE` (explicit path — set by the systemd unit in production)
2. `<parent-of-repo>/env/.env` (the central folder — local dev)
3. `<repo>/.env` (fallback)

> **Future upgrade:** if this grows to multiple instances or a team, move secrets
> to **AWS SSM Parameter Store** (encrypted at rest + audit log). That needs an
> IAM role on the instance and a small boto3 loader; not worth it for a single box.

## Required env keys (minimum)

```
PRIORITY_URL_REAL=https://p.priority-connect.online/odata/Priority/<tabula>.ini/<company>/
PRIORITY_USERNAME=...
PRIORITY_PASSWORD=...
REQUESTS_VERIFY_SSL=false
```

## First-time setup (on a fresh EC2 instance)

1. Launch EC2 (Amazon Linux 2023 or Ubuntu), open ports 80/443 in the security group.
2. SSH in, then run the setup script:
   ```bash
   git clone https://github.com/boazeng/Bank-discrepancies.git ~/Bank-discrepancies
   bash ~/Bank-discrepancies/deploy/setup_ec2.sh
   ```
   It installs Python + nginx, creates the venv, installs deps (incl. gunicorn),
   seeds `~/env/.env` from the template, and installs the systemd + nginx configs.
3. Fill in real secrets: `nano ~/env/.env`
4. Set your real subdomain + cert in `/etc/nginx/conf.d/zz-bank.conf`, then:
   ```bash
   sudo certbot --nginx -d bank.<your-domain>     # if a dedicated cert is needed
   sudo nginx -t && sudo systemctl reload nginx
   ```
5. Start it:
   ```bash
   sudo systemctl start bank-discrepancies
   sudo systemctl status bank-discrepancies
   journalctl -u bank-discrepancies -f
   ```

## Subdomain / DNS (do later, as planned)

- Add a DNS record (Cloudflare or Route53) for `bank.<your-domain>` → the EC2 public IP
  (proxied through Cloudflare, like bookkeeping.newavera.co.il).
- Update `server_name` in `deploy/nginx-bank.conf` (and on the box) to match.

## Updating after a code change

```bash
# locally: commit + push, then on the box:
bash ~/Bank-discrepancies/deploy/update.sh
```

## Files in this folder

| File | Purpose |
|------|---------|
| `setup_ec2.sh` | One-time provisioning on a fresh EC2 instance. |
| `bank-discrepancies.service` | systemd unit (gunicorn, port 5000, `BANK_ENV_FILE`). |
| `nginx-bank.conf` | nginx reverse-proxy server block for the subdomain. |
| `update.sh` | git pull + reinstall deps + restart service. |
