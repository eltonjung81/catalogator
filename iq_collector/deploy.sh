#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# DEPLOY DO COLETOR IQ OPTION → GOOGLE CLOUD RUN
# ─────────────────────────────────────────────────────────────────────────────
# Pré-requisitos:
#   1. Google Cloud CLI instalado: https://cloud.google.com/sdk/docs/install
#   2. Docker instalado: https://docs.docker.com/get-docker/
#   3. gcloud auth login (autenticado no Google Cloud)
#   4. .env configurado com IQ_EMAIL e IQ_PASSWORD
#   5. firebase_service_account.json presente neste diretório
#
# Uso:
#   chmod +x deploy.sh
#   ./deploy.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e  # Para em caso de erro

# ── Configurações — EDITE AQUI ────────────────────────────────────────────────
PROJECT_ID="catalogador-pro"       # ID do seu projeto no Google Cloud
REGION="southamerica-east1"        # São Paulo (mesmo da Firebase Function)
SERVICE_NAME="iq-collector"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

# ── Carrega credenciais do .env ───────────────────────────────────────────────
if [ -f ".env" ]; then
  export $(grep -v '^#' .env | xargs)
  echo "✅ .env carregado"
else
  echo "❌ Arquivo .env não encontrado! Copie .env.example para .env e configure."
  exit 1
fi

# ── Valida credenciais ────────────────────────────────────────────────────────
if [ -z "$IQ_EMAIL" ] || [ -z "$IQ_PASSWORD" ]; then
  echo "❌ IQ_EMAIL e IQ_PASSWORD devem estar configurados no .env!"
  exit 1
fi

if [ ! -f "firebase_service_account.json" ]; then
  echo "❌ firebase_service_account.json não encontrado!"
  echo "   Baixe em: Firebase Console > Project Settings > Service Accounts > Generate new private key"
  exit 1
fi

echo ""
echo "🚀 Iniciando deploy do IQ Collector para Cloud Run..."
echo "   Projeto: ${PROJECT_ID}"
echo "   Região:  ${REGION}"
echo "   Serviço: ${SERVICE_NAME}"
echo ""

# ── Configura projeto gcloud ──────────────────────────────────────────────────
gcloud config set project ${PROJECT_ID}

# ── Habilita APIs necessárias ─────────────────────────────────────────────────
echo "📦 Habilitando APIs do Google Cloud..."
gcloud services enable \
  run.googleapis.com \
  containerregistry.googleapis.com \
  --quiet

# ── Build e push da imagem Docker ─────────────────────────────────────────────
echo "🐳 Fazendo build da imagem Docker..."
docker build -t ${IMAGE_NAME} .

echo "📤 Enviando imagem para Google Container Registry..."
docker push ${IMAGE_NAME}

# ── Deploy no Cloud Run ───────────────────────────────────────────────────────
echo "☁️  Fazendo deploy no Cloud Run..."
gcloud run deploy ${SERVICE_NAME} \
  --image ${IMAGE_NAME} \
  --region ${REGION} \
  --platform managed \
  --no-allow-unauthenticated \
  --min-instances 1 \
  --max-instances 1 \
  --memory 512Mi \
  --cpu 1 \
  --timeout 3600 \
  --set-env-vars "IQ_EMAIL=${IQ_EMAIL},IQ_PASSWORD=${IQ_PASSWORD},M1_CANDLE_COUNT=720,M5_CANDLE_COUNT=720,UPDATE_INTERVAL_SECONDS=60" \
  --quiet

echo ""
echo "✅ Deploy concluído com sucesso!"
echo ""
echo "📊 Para ver os logs em tempo real:"
echo "   gcloud run services logs tail ${SERVICE_NAME} --region=${REGION}"
echo ""
echo "⏹️  Para pausar o serviço (economizar créditos):"
echo "   gcloud run services update ${SERVICE_NAME} --region=${REGION} --min-instances=0"
