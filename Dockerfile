# Bank Discrepancies — Flask app served by gunicorn, in a container.
# Built frontend (dist/) is committed and served by Flask directly.
FROM python:3.12-slim

WORKDIR /app

# tzdata so zoneinfo("Asia/Jerusalem") works (DST-correct) inside slim image.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt tzdata

# App code + built UI. Runtime data (database/**/*.json) is a bind-mounted
# volume (see docker-compose.yml), not baked into the image.
COPY backend/ ./backend/
COPY database/ ./database/
COPY dist/ ./dist/

EXPOSE 5000

# PROJECT_ROOT resolves to /app (backend/server.py -> parent.parent).
CMD ["gunicorn", "--chdir", "backend", "--bind", "0.0.0.0:5000", \
     "--workers", "2", "--threads", "4", "--timeout", "120", "server:app"]
