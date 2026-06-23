# Bank Discrepancies — build the React/Vite frontend, then serve it (and the
# Priority API) from Flask/gunicorn. The frontend is built INSIDE the image, so
# committing dist/ is unnecessary and a src change can never ship a stale build.

# ---- stage 1: build the static frontend ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- stage 2: Flask app server (gunicorn) ----
FROM python:3.12-slim
WORKDIR /app

# Node.js 20 — required for backend/close_receipt/*.js scripts at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# tzdata so zoneinfo("Asia/Jerusalem") is DST-correct.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt tzdata

# App code + the built UI. Runtime data (database/**/*.json, *.db) is a
# bind-mounted volume (see docker-compose.yml), not baked into the image.
COPY backend/ ./backend/
COPY database/ ./database/
COPY --from=build /app/dist ./dist

# Install Node.js deps for the close_receipt scripts (node_modules is in .dockerignore).
RUN cd backend/close_receipt && npm ci --omit=dev

EXPOSE 5000

CMD ["gunicorn", "--chdir", "backend", "--bind", "0.0.0.0:5000", \
     "--workers", "2", "--threads", "4", "--timeout", "120", \
     "--access-logfile", "-", "server:app"]
