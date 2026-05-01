#!/usr/bin/env python3
"""
Deriv (Binary.com) → Firestore Candle Collector
==============================================
Coleta candles M1 e M5 via WebSocket da Deriv
e salva na coleção `signals_deriv` do Firestore.
"""

import os
import sys
import time
import json
import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional, List
from dotenv import load_dotenv

# ── Firebase Admin ────────────────────────────────────────────────────────────
import firebase_admin
from firebase_admin import credentials, firestore

# ── Deriv API ─────────────────────────────────────────────────────────────────
from deriv_api import DerivAPI

# ── Carrega variáveis de ambiente ─────────────────────────────────────────────
load_dotenv()

DERIV_APP_ID = os.getenv("DERIV_APP_ID", "1089") # Default public App ID
SA_PATH      = os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH", "../iq_collector/firebase_service_account.json")
M1_COUNT     = int(os.getenv("M1_CANDLE_COUNT", "720"))
M5_COUNT     = int(os.getenv("M5_CANDLE_COUNT", "720"))
UPDATE_INTERVAL = 60 # Ciclo de catalogação a cada minuto

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(message)s",
)
log = logging.getLogger(__name__)
print("Starting script...")

# ── Inicialização Firebase ────────────────────────────────────────────────────
if not os.path.exists(SA_PATH):
    # Tenta caminho relativo alternativo se rodando de dentro da pasta
    SA_PATH = "./firebase_service_account.json"

if not os.path.exists(SA_PATH):
    log.error(f"[ERR] Firebase service account nao encontrado em: {SA_PATH}")
    sys.exit(1)

print("Iniciando Firebase...")
cred = credentials.Certificate(SA_PATH)
firebase_admin.initialize_app(cred)
db = firestore.client()
print("Firebase OK.")

# ── Configuração de Pares ─────────────────────────────────────────────────────
print("Configurando pares...")
# Forex pairs prefixados com 'frx' na Deriv
FOREX_PAIRS = [
    "frxEURUSD", "frxGBPUSD", "frxUSDJPY", "frxAUDUSD", 
    "frxUSDCAD", "frxUSDCHF", "frxEURGBP", "frxEURJPY", 
    "frxGBPJPY", "frxNZDUSD"
]

# Synthetic Indices (24/7) - Mantendo apenas os mais estáveis e conhecidos
SYNTHETIC_PAIRS = [
    "R_10", "R_25", "R_50", "R_75", "R_100"
]

ALL_SYMBOLS = FOREX_PAIRS + SYNTHETIC_PAIRS

# ── Estratégias (Espelho do index.ts e iq_collector) ─────────────────────────

def get_color(open_p: float, close_p: float) -> str:
    if close_p > open_p: return "GREEN"
    if close_p < open_p: return "RED"
    return "DOJI"

def group_in_blocks(candles: list, candles_per_block: int = 5) -> list:
    if not candles or len(candles) < 2: return []
    first_interval = candles[1]["openTime"] - candles[0]["openTime"]
    candle_interval_min = round(first_interval / 60000)
    block_size_minutes = candles_per_block * candle_interval_min
    blocks, current_block = [], []
    found_first_boundary = False
    for candle in candles:
        dt = datetime.fromtimestamp(candle["openTime"] / 1000, tz=timezone.utc)
        total_minutes = dt.hour * 60 + dt.minute
        if (total_minutes % block_size_minutes) == 0:
            if not found_first_boundary:
                found_first_boundary = True
                current_block = []
            elif current_block:
                blocks.append(current_block)
                current_block = []
        if found_first_boundary: current_block.append(candle)
    if current_block: blocks.append(current_block)
    return blocks

# Funções de Análise
def analyze_mhi1(prev_block: list) -> Optional[str]:
    if len(prev_block) < 5: return None
    last3 = prev_block[-3:]
    greens = sum(1 for c in last3 if c["color"] == "GREEN")
    reds   = sum(1 for c in last3 if c["color"] == "RED")
    if greens == 0 and reds == 0: return None
    return "GREEN" if greens < reds else "RED"

def analyze_mhi_maioria(prev_block: list) -> Optional[str]:
    if len(prev_block) < 5: return None
    last3 = prev_block[-3:]
    greens = sum(1 for c in last3 if c["color"] == "GREEN")
    reds   = sum(1 for c in last3 if c["color"] == "RED")
    if greens == 0 and reds == 0: return None
    return "GREEN" if greens > reds else "RED"

def analyze_torres_gemeas(prev_block: list) -> Optional[str]:
    if len(prev_block) < 5: return None
    last = prev_block[-1]
    return last["color"] if last["color"] != "DOJI" else None

def analyze_padrao23_m1(prev_block: list) -> Optional[str]:
    if len(prev_block) < 5: return None
    c2, c3 = prev_block[1], prev_block[2]
    votes = [c["color"] for c in [c2, c3] if c["color"] != "DOJI"]
    if not votes: return None
    g, r = votes.count("GREEN"), votes.count("RED")
    return "GREEN" if g > r else "RED" if r > g else None

M5_STRATEGIES = [
    {"name": "MHI 1",         "func": analyze_mhi1,           "entryIndex": 0},
    {"name": "MHI 2",         "func": analyze_mhi1,           "entryIndex": 1},
    {"name": "MHI Maioria",   "func": analyze_mhi_maioria,    "entryIndex": 0},
    {"name": "Torres Gêmeas", "func": analyze_torres_gemeas,  "entryIndex": 0},
]

M1_STRATEGIES = [
    {"name": "MHI 1 (M1)",         "func": analyze_mhi1,            "entryIndex": 0},
    {"name": "MHI Maioria (M1)",   "func": analyze_mhi_maioria,     "entryIndex": 0},
    {"name": "Padrão 23 (M1)",     "func": analyze_padrao23_m1,     "entryIndex": 0},
]

def run_cataloger(blocks: list, pattern_func, entry_idx: int = 0) -> list:
    history = []
    flat = [c for block in blocks for c in block]
    for i in range(1, len(blocks)):
        prev_block, curr_block = blocks[i-1], blocks[i]
        if len(prev_block) < 1 or len(curr_block) <= entry_idx: continue
        prediction = pattern_func(prev_block)
        if not prediction: continue
        entry_candle = curr_block[entry_idx]
        entry_flat_idx = next((j for j, c in enumerate(flat) if c["openTime"] == entry_candle["openTime"]), -1)
        if entry_flat_idx == -1: continue
        res = None
        for attempt in range(3):
            idx = entry_flat_idx + attempt
            if idx >= len(flat): break
            c = flat[idx]
            if c["color"] == "DOJI":
                if attempt == 2: res = -1
                continue
            if c["color"] == prediction:
                res = attempt; break
            if attempt == 2: res = -1
        if res is not None:
            l_idx = min(entry_flat_idx + (2 if res == -1 else res), len(flat)-1)
            history.append({
                "result": res, "time": entry_candle["openTime"],
                "direction": "CALL" if prediction == "GREEN" else "PUT",
                "openPrice": entry_candle["open"], "closePrice": flat[l_idx]["close"]
            })
    return history

# ── Coleta e Salvamento ──────────────────────────────────────────────────────

async def fetch_and_save(api: DerivAPI, symbol: str):
    print(f"[WAIT] Processando {symbol}...")
    try:
        for tf in [1, 5]:
            count = M1_COUNT if tf == 1 else M5_COUNT
            granularity = tf * 60
            
            # Request candles
            resp = await api.ticks_history({
                "ticks_history": symbol,
                "style": "candles",
                "granularity": granularity,
                "count": count,
                "end": "latest"
            })
            
            if "candles" not in resp:
                log.warning(f"[WARN] {symbol} M{tf} nao retornou candles.")
                continue
                
            raw_candles = resp["candles"]
            candles = []
            for c in raw_candles:
                o, cl = float(c["open"]), float(c["close"])
                candles.append({
                    "openTime": int(c["epoch"] * 1000),
                    "open": o, "high": float(c["high"]),
                    "low": float(c["low"]), "close": cl,
                    "volume": 0, "color": get_color(o, cl)
                })
            
            candles.sort(key=lambda x: x["openTime"])
            
            # Save candles for simulator
            db.collection("candles_deriv").document(f"{symbol}_M{tf}").set({
                "pair": symbol, "tf": tf, "candles": candles[-20:],
                "updatedAt": firestore.SERVER_TIMESTAMP
            })
            
            # Catalog patterns
            blocks = group_in_blocks(candles, 5)
            strategies = M1_STRATEGIES if tf == 1 else M5_STRATEGIES
            batch = db.batch()
            
            for strat in strategies:
                slug = strat["name"].replace(" ", "").replace("(", "").replace(")", "")
                doc_id = f"{symbol}_{slug}_M{tf}"
                history = run_cataloger(blocks, strat["func"], strat["entryIndex"])
                
                batch.set(db.collection("signals_deriv").document(doc_id), {
                    "id": doc_id, "pair": symbol, "pattern": strat["name"],
                    "timeframe": tf, "rawHistory": history[-100:],
                    "isDead": False, "source": "deriv",
                    "updatedAt": firestore.SERVER_TIMESTAMP
                })
            batch.commit()
            print(f"[OK] {symbol} M{tf} salvo.")
            
    except Exception as e:
        log.error(f"[ERR] Erro em {symbol}: {e}")

async def main():
    print("Deriv Collector Iniciado")
    api = DerivAPI(app_id=DERIV_APP_ID)
    
    while True:
        start_time = time.time()
        for s in ALL_SYMBOLS:
            await fetch_and_save(api, s)
        
        elapsed = time.time() - start_time
        wait_time = max(0, UPDATE_INTERVAL - elapsed)
        log.info(f"Ciclo concluido em {elapsed:.1f}s. Aguardando {wait_time:.1f}s...")
        await asyncio.sleep(wait_time)

if __name__ == "__main__":
    try:
        print("Entrando no loop principal...")
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Interrompido.")
