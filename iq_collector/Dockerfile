# ─── Imagem base Python slim ──────────────────────────────────────────────────
FROM python:3.11-slim

# ─── Dependências do sistema (necessárias para iqoptionapi) ──────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# ─── Diretório de trabalho ────────────────────────────────────────────────────
WORKDIR /app

# ─── Dependências Python ──────────────────────────────────────────────────────
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ─── Código da aplicação ─────────────────────────────────────────────────────
COPY main.py .
COPY firebase_service_account.json .

# ─── Variáveis de ambiente (sobrescritas no deploy) ──────────────────────────
ENV IQ_EMAIL=""
ENV IQ_PASSWORD=""
ENV FIREBASE_SERVICE_ACCOUNT_PATH="/app/firebase_service_account.json"
ENV M1_CANDLE_COUNT="720"
ENV M5_CANDLE_COUNT="720"
ENV UPDATE_INTERVAL_SECONDS="60"

# ─── Healthcheck ─────────────────────────────────────────────────────────────
HEALTHCHECK --interval=120s --timeout=10s --start-period=30s --retries=3 \
  CMD python -c "import os; exit(0 if os.path.exists('/tmp/collector_alive') else 1)"

# ─── Ponto de entrada ────────────────────────────────────────────────────────
CMD ["python", "-u", "main.py"]
