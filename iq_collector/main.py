#!/usr/bin/env python3
"""
IQ Option → Firestore Candle Collector
=====================================
Coleta candles M1 e M5 de todos os pares OTC e Forex da IQ Option
e salva na coleção `signals_iq` do Firestore, no mesmo formato
que o catalogador da Binance usa em `signals`.

Roda como daemon 24/7 (Docker/Cloud Run) ou localmente.
"""

import os
import sys
import time
import logging
import math
from datetime import datetime, timezone
from typing import Optional
from dotenv import load_dotenv

# ── Carrega variáveis de ambiente ─────────────────────────────────────────────
load_dotenv()

IQ_EMAIL    = os.getenv("IQ_EMAIL", "")
IQ_PASSWORD = os.getenv("IQ_PASSWORD", "")
SA_PATH     = os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH", "./firebase_service_account.json")
M1_COUNT    = int(os.getenv("M1_CANDLE_COUNT", "720"))
M5_COUNT    = int(os.getenv("M5_CANDLE_COUNT", "720"))
INTERVAL    = int(os.getenv("UPDATE_INTERVAL_SECONDS", "60"))

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

# ── Firebase Admin ────────────────────────────────────────────────────────────
import firebase_admin
from firebase_admin import credentials, firestore
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

# ── Servidor de Health Check para o Cloud Run ────────────────────────────────
class HealthCheckHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"OK")

    def log_message(self, format, *args):
        return # Silencia logs do servidor HTTP

def run_health_server():
    port = int(os.getenv("PORT", "8080"))
    server = HTTPServer(('0.0.0.0', port), HealthCheckHandler)
    log.info(f"📡 Servidor de Health Check rodando na porta {port}")
    server.serve_forever()

cred = credentials.Certificate(SA_PATH)
firebase_admin.initialize_app(cred)
db = firestore.client()

# ── IQ Option API ─────────────────────────────────────────────────────────────
from iqoptionapi.stable_api import IQ_Option

# ─────────────────────────────────────────────────────────────────────────────
# PARES A CATALOGAR
# Formato IQ Option: "EURUSD-OTC" (OTC, sempre disponível) e "EURUSD" (Forex, horário de mercado)
# ─────────────────────────────────────────────────────────────────────────────
OTC_PAIRS = [
    "EURUSD-OTC",
    "GBPUSD-OTC",
    "USDJPY-OTC",
    "AUDUSD-OTC",
    "USDCAD-OTC",
    "USDCHF-OTC",
    "EURGBP-OTC",
    "EURJPY-OTC",
    "GBPJPY-OTC",
    "NZDUSD-OTC",
    "EURAUD-OTC",
    "EURCAD-OTC",
    "GBPAUD-OTC",
    "GBPCAD-OTC",
    "AUDJPY-OTC",
    "CADJPY-OTC",
    "CHFJPY-OTC",
]

FOREX_PAIRS = [
    "EURUSD",
    "GBPUSD",
    "USDJPY",
    "AUDUSD",
    "USDCAD",
    "USDCHF",
    "EURGBP",
    "EURJPY",
    "GBPJPY",
    "NZDUSD",
]

# ─────────────────────────────────────────────────────────────────────────────
# ESTRATÉGIAS — espelho exato das definidas em index.ts
# ─────────────────────────────────────────────────────────────────────────────

def get_color(open_p: float, close_p: float) -> str:
    if close_p > open_p:
        return "GREEN"
    if close_p < open_p:
        return "RED"
    return "DOJI"


def group_in_blocks(candles: list, candles_per_block: int = 5) -> list:
    """Agrupa candles em blocos de N velas alinhados ao boundary de tempo."""
    if not candles:
        return []

    if len(candles) < 2:
        return []

    first_interval = candles[1]["openTime"] - candles[0]["openTime"]
    candle_interval_min = round(first_interval / 60000)
    block_size_minutes = candles_per_block * candle_interval_min

    blocks = []
    current_block = []
    found_first_boundary = False

    for candle in candles:
        dt = datetime.fromtimestamp(candle["openTime"] / 1000, tz=timezone.utc)
        total_minutes = dt.hour * 60 + dt.minute
        is_on_boundary = (total_minutes % block_size_minutes) == 0

        if is_on_boundary:
            if not found_first_boundary:
                found_first_boundary = True
                current_block = []
            elif current_block:
                blocks.append(current_block)
                current_block = []

        if found_first_boundary:
            current_block.append(candle)

    if current_block:
        blocks.append(current_block)

    return blocks


# ── Funções de Análise (espelho de cataloger.ts) ─────────────────────────────

def analyze_mhi1(prev_block: list) -> Optional[str]:
    if len(prev_block) < 5:
        return None
    last3 = prev_block[-3:]
    greens = sum(1 for c in last3 if c["color"] == "GREEN")
    reds   = sum(1 for c in last3 if c["color"] == "RED")
    if greens == 0 and reds == 0:
        return None
    return "GREEN" if greens < reds else "RED"


def analyze_mhi_maioria(prev_block: list) -> Optional[str]:
    if len(prev_block) < 5:
        return None
    last3 = prev_block[-3:]
    greens = sum(1 for c in last3 if c["color"] == "GREEN")
    reds   = sum(1 for c in last3 if c["color"] == "RED")
    if greens == 0 and reds == 0:
        return None
    return "GREEN" if greens > reds else "RED"


def analyze_torres_gemeas(prev_block: list) -> Optional[str]:
    if len(prev_block) < 5:
        return None
    last = prev_block[-1]
    return last["color"] if last["color"] != "DOJI" else None


def analyze_torres_gemeas_m1(prev_block: list) -> Optional[str]:
    if len(prev_block) < 5:
        return None
    last = prev_block[-1]
    second_last = prev_block[-2]
    if last["color"] == "DOJI" or second_last["color"] == "DOJI":
        return None
    if last["color"] != second_last["color"]:
        return None
    return last["color"]


def analyze_padrao23(prev_block: list) -> Optional[str]:
    if len(prev_block) < 5:
        return None
    c2 = prev_block[1]
    return c2["color"] if c2["color"] != "DOJI" else None


def analyze_padrao23_m1(prev_block: list) -> Optional[str]:
    if len(prev_block) < 5:
        return None
    c2 = prev_block[1]
    c3 = prev_block[2]
    votes = []
    if c2["color"] != "DOJI":
        votes.append(c2["color"])
    if c3["color"] != "DOJI":
        votes.append(c3["color"])
    if not votes:
        return None
    greens = votes.count("GREEN")
    reds   = votes.count("RED")
    if greens > reds:
        return "GREEN"
    if reds > greens:
        return "RED"
    return None


def analyze_m1_trend(candles: list) -> Optional[str]:
    if not candles:
        return None
    last = candles[-1]
    return last["color"] if last["color"] != "DOJI" else None


# ── Estratégias por timeframe ─────────────────────────────────────────────────

M5_STRATEGIES = [
    {"name": "MHI 1",         "func": analyze_mhi1,           "entryIndex": 0},
    {"name": "MHI 2",         "func": analyze_mhi1,           "entryIndex": 1},
    {"name": "MHI 3",         "func": analyze_mhi1,           "entryIndex": 2},
    {"name": "MHI Maioria",   "func": analyze_mhi_maioria,    "entryIndex": 0},
    {"name": "Torres Gêmeas", "func": analyze_torres_gemeas,  "entryIndex": 0},
    {"name": "Padrão 23",     "func": analyze_padrao23,       "entryIndex": 0},
]

M1_STRATEGIES = [
    {"name": "Tendência M1",       "func": analyze_m1_trend,        "entryIndex": 0},
    {"name": "MHI 1 (M1)",         "func": analyze_mhi1,            "entryIndex": 0},
    {"name": "MHI 2 (M1)",         "func": analyze_mhi1,            "entryIndex": 1},
    {"name": "MHI 3 (M1)",         "func": analyze_mhi1,            "entryIndex": 2},
    {"name": "MHI Maioria (M1)",   "func": analyze_mhi_maioria,     "entryIndex": 0},
    {"name": "Padrão 23 (M1)",     "func": analyze_padrao23_m1,     "entryIndex": 0},
    {"name": "Torres Gêmeas (M1)", "func": analyze_torres_gemeas_m1,"entryIndex": 0},
]


# ── Catalogador (espelho de runCataloger em cataloger.ts) ────────────────────

def run_cataloger(blocks: list, pattern_func, entry_candle_index: int = 0) -> list:
    history = []
    flat = [c for block in blocks for c in block]

    for i in range(1, len(blocks)):
        prev_block    = blocks[i - 1]
        current_block = blocks[i]

        if len(prev_block) < 1 or len(current_block) <= entry_candle_index:
            continue

        prediction = pattern_func(prev_block)
        if not prediction:
            continue

        entry_candle = current_block[entry_candle_index]
        entry_flat_idx = next(
            (j for j, c in enumerate(flat) if c["openTime"] == entry_candle["openTime"]),
            -1
        )
        if entry_flat_idx == -1:
            continue

        trade_result = None

        for attempt in range(3):
            candle_flat_idx = entry_flat_idx + attempt
            if candle_flat_idx >= len(flat):
                trade_result = None
                break

            trade_candle = flat[candle_flat_idx]

            if trade_candle["color"] == "DOJI":
                if attempt == 2:
                    trade_result = -1
                continue

            if trade_candle["color"] == prediction:
                trade_result = attempt
                break

            if attempt == 2:
                trade_result = -1

        if trade_result is not None:
            last_idx = min(entry_flat_idx + (2 if trade_result == -1 else trade_result), len(flat) - 1)
            last_candle = flat[last_idx]
            history.append({
                "result":     trade_result,
                "time":       entry_candle["openTime"],
                "direction":  "CALL" if prediction == "GREEN" else "PUT",
                "openPrice":  entry_candle["open"],
                "closePrice": last_candle["close"],
            })

    return history


def is_dead_chart(candles: list, doji_threshold: float = 20, unique_price_threshold: int = 15) -> bool:
    if len(candles) < 60:
        return False
    recent = candles[-100:]
    total = len(recent)
    dojis = sum(1 for c in recent if c["color"] == "DOJI")
    doji_rate = (dojis / total) * 100
    unique_prices = len(set(c["close"] for c in recent))
    recent_vol = sum(c["volume"] for c in recent[-20:]) / 20
    avg_vol = sum(c["volume"] for c in recent) / total
    vol_drop = (recent_vol / avg_vol) if avg_vol > 0 else 1
    return doji_rate > doji_threshold or unique_prices < unique_price_threshold or vol_drop < 0.3


# ─────────────────────────────────────────────────────────────────────────────
# CONEXÃO COM IQ OPTION
# ─────────────────────────────────────────────────────────────────────────────

def connect_iq() -> Optional[IQ_Option]:
    """Cria e autentica uma sessão na IQ Option. Retorna None se falhar."""
    try:
        api = IQ_Option(IQ_EMAIL, IQ_PASSWORD)
        api.connect()
        connected, reason = api.connect()
        if not connected:
            log.error(f"Falha na conexão com IQ Option: {reason}")
            return None
        # Força conta de PRÁTICA para segurança (dados OTC são os mesmos)
        api.change_balance("PRACTICE")
        log.info("✅ Conectado à IQ Option (conta PRÁTICA)")
        return api
    except Exception as e:
        log.error(f"Erro ao conectar na IQ Option: {e}")
        return None


def fetch_iq_candles(api: IQ_Option, pair: str, timeframe_seconds: int, count: int) -> list:
    """
    Busca candles da IQ Option e converte para o formato interno do catalogador:
    { openTime (ms), open, high, low, close, volume, color }
    """
    try:
        end_time = time.time()
        raw_candles = api.get_candles(pair, timeframe_seconds, count, end_time)

        if not raw_candles:
            return []

        candles = []
        now_ms = int(time.time() * 1000)
        candle_duration_ms = timeframe_seconds * 1000

        for c in raw_candles:
            open_time_ms = int(c["from"] * 1000)
            close_time_ms = open_time_ms + candle_duration_ms - 1

            # Filtra a vela ainda aberta (igual ao filtro da Binance: now > closeTime)
            if now_ms <= close_time_ms:
                continue

            o = float(c["open"])
            cl = float(c["close"])
            color = get_color(o, cl)

            candles.append({
                "openTime": open_time_ms,
                "open":     o,
                "high":     float(c["max"]),
                "low":      float(c["min"]),
                "close":    cl,
                "volume":   float(c.get("volume", 0)),
                "color":    color,
            })

        # Ordena por tempo crescente
        candles.sort(key=lambda x: x["openTime"])
        return candles

    except Exception as e:
        log.error(f"Erro ao buscar candles de {pair} (tf={timeframe_seconds}s): {e}")
        return []


# ─────────────────────────────────────────────────────────────────────────────
# SALVAR NO FIRESTORE
# ─────────────────────────────────────────────────────────────────────────────

def save_signals_to_firestore(pair: str, tf: int, candles: list, strategies: list):
    """
    Roda o catalogador para cada estratégia e salva em `signals_iq` no Firestore.
    O doc_id usa o mesmo formato do sistema Binance: EURUSD-OTC_MHI1_M5

    Também salva os últimos 20 candles em `candles_iq/{pair}_M{tf}` para que
    o simulador Firebase (Node.js) possa verificar se a vela de entrada fechou.
    """
    if len(candles) < 700:
        log.warning(f"[{pair} M{tf}] Candles insuficientes: {len(candles)} < 700. Pulando.")
        return

    # ── Salva os últimos 20 candles para o simulador verificar trades ─────────
    try:
        candle_ref = db.collection("candles_iq").document(f"{pair}_M{tf}")
        candle_ref.set({
            "pair":      pair,
            "tf":        tf,
            "candles":   candles[-20:],  # Últimos 20 são suficientes para verificar entry + 2 gales
            "updatedAt": firestore.SERVER_TIMESTAMP,
        })
        log.debug(f"[{pair} M{tf}] candles_iq atualizado com {len(candles[-20:])} candles recentes.")
    except Exception as e:
        log.error(f"[{pair} M{tf}] Erro ao salvar candles_iq: {e}")

    is_dead = is_dead_chart(candles, doji_threshold=40 if tf == 1 else 20,
                              unique_price_threshold=8 if tf == 1 else 15)
    if is_dead:
        log.info(f"[DEAD] {pair} M{tf} — Baixa liquidez. Marcando como morto.")

    blocks = group_in_blocks(candles, 5)
    batch  = db.batch()
    count  = 0

    for strategy in strategies:
        # Remove espaços e parênteses do nome para o doc_id (igual ao TS)
        strategy_slug = strategy["name"].replace(" ", "").replace("(", "").replace(")", "")
        doc_id = f"{pair}_{strategy_slug}_M{tf}"
        doc_ref = db.collection("signals_iq").document(doc_id)

        if is_dead:
            batch.set(doc_ref, {
                "rawHistory": [],
                "isDead": True,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            }, merge=True)
        else:
            raw_history = run_cataloger(blocks, strategy["func"], strategy["entryIndex"])
            filtered_history = raw_history[-100:]  # Últimos 100 trades

            batch.set(doc_ref, {
                "id":         doc_id,
                "pair":       pair,
                "pattern":    strategy["name"],
                "timeframe":  tf,
                "rawHistory": filtered_history,
                "isDead":     False,
                "source":     "iqoption",
                "updatedAt":  firestore.SERVER_TIMESTAMP,
            })

        count += 1

        # Firestore batch tem limite de 500 writes
        if count >= 490:
            batch.commit()
            batch = db.batch()
            count = 0

    if count > 0:
        batch.commit()

    log.info(f"[{pair} M{tf}] {'DEAD' if is_dead else f'{len(candles)} candles'} → {len(strategies)} estratégias salvas em signals_iq")



# ─────────────────────────────────────────────────────────────────────────────
# LOOP PRINCIPAL
# ─────────────────────────────────────────────────────────────────────────────

def run_collection_cycle(api: IQ_Option):
    """Executa um ciclo completo de coleta para todos os pares e timeframes."""
    log.info("─" * 60)
    log.info(f"🔄 Iniciando ciclo de coleta — {datetime.now().strftime('%H:%M:%S')}")

    # Define quais pares estão ativos (OTC sempre, Forex só em horário de mercado)
    all_actives = api.get_all_open_time()
    active_otc   = all_actives.get("turbo", {})   # OTC (Digital Options turbo)
    active_forex = all_actives.get("binary", {})  # Binary / Forex

    pairs_to_process = []

    for pair in OTC_PAIRS:
        # OTC pairs: verificar se estão abertos
        pair_info = active_otc.get(pair, {}) or active_forex.get(pair, {})
        is_open = pair_info.get("open", False) if pair_info else True  # Default: tenta mesmo assim
        if is_open or "-OTC" in pair:  # OTC sempre tenta
            pairs_to_process.append(pair)
        else:
            log.debug(f"[{pair}] Mercado fechado. Pulando.")

    for pair in FOREX_PAIRS:
        pair_info = active_forex.get(pair, {}) or active_otc.get(pair, {})
        is_open = pair_info.get("open", False) if pair_info else False
        if is_open:
            pairs_to_process.append(pair)
        else:
            log.debug(f"[{pair}] Forex fechado. Pulando.")

    log.info(f"📊 Pares ativos para coleta: {len(pairs_to_process)}")

    for pair in pairs_to_process:
        for tf, count, strategies in [
            (1, M1_COUNT, M1_STRATEGIES),
            (5, M5_COUNT, M5_STRATEGIES),
        ]:
            timeframe_seconds = tf * 60
            candles = fetch_iq_candles(api, pair, timeframe_seconds, count)
            if candles:
                save_signals_to_firestore(pair, tf, candles, strategies)
            else:
                log.warning(f"[{pair} M{tf}] Nenhum candle retornado.")
            time.sleep(0.5)  # Respeita rate limit da IQ Option

    log.info(f"✅ Ciclo concluído — próximo em {INTERVAL}s")


def main():
    if not IQ_EMAIL or not IQ_PASSWORD:
        log.error("❌ Credenciais IQ Option não definidas! Configure IQ_EMAIL e IQ_PASSWORD no .env")
        sys.exit(1)

    if not os.path.exists(SA_PATH):
        log.error(f"❌ Firebase service account não encontrado em: {SA_PATH}")
        log.error("   Baixe em: Firebase Console > Project Settings > Service Accounts")
        sys.exit(1)

    log.info("🚀 IQ Option → Firestore Collector iniciado")
    
    # Inicia o servidor de health check em uma thread separada para o Cloud Run
    threading.Thread(target=run_health_server, daemon=True).start()

    log.info(f"   Email: {IQ_EMAIL}")
    log.info(f"   Pares OTC: {len(OTC_PAIRS)} | Forex: {len(FOREX_PAIRS)}")
    log.info(f"   Intervalo: {INTERVAL}s | M1: {M1_COUNT} candles | M5: {M5_COUNT} candles")

    api: Optional[IQ_Option] = None
    consecutive_errors = 0
    MAX_ERRORS = 5

    while True:
        try:
            # Reconecta se necessário
            if api is None or not api.check_connect():
                log.info("📡 Conectando na IQ Option...")
                if api:
                    try:
                        api.close()
                    except Exception:
                        pass
                api = connect_iq()
                if api is None:
                    log.error(f"Falha na conexão. Tentando novamente em 30s... ({consecutive_errors}/{MAX_ERRORS})")
                    consecutive_errors += 1
                    if consecutive_errors >= MAX_ERRORS:
                        log.error("❌ Muitas falhas consecutivas. Aguardando 5 minutos...")
                        time.sleep(300)
                        consecutive_errors = 0
                    else:
                        time.sleep(30)
                    continue

            # Executa ciclo de coleta
            run_collection_cycle(api)
            consecutive_errors = 0

        except KeyboardInterrupt:
            log.info("⛔ Interrompido pelo usuário.")
            break
        except Exception as e:
            log.error(f"❌ Erro no ciclo principal: {e}", exc_info=True)
            consecutive_errors += 1
            api = None  # Força reconexão no próximo ciclo

        # Aguarda próximo ciclo
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
