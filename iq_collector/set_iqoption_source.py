"""
Script para configurar o Firestore e ativar o mercado real (IQ Option Forex).
Execute: python set_iqoption_source.py
"""
import firebase_admin
from firebase_admin import credentials, firestore
import os
from datetime import datetime, timezone

cred_path = r'c:\Users\casa\Desktop\catalogador\iq_collector\firebase_service_account.json'

if not os.path.exists(cred_path):
    print(f"Erro: Arquivo nao encontrado em {cred_path}")
    exit(1)

cred = credentials.Certificate(cred_path)
firebase_admin.initialize_app(cred)
db = firestore.client()

print("=" * 60)
print("  CONFIGURACAO: Ativando Mercado Real (IQ Option)")
print("=" * 60)

# 1) Configura a fonte de dados para 'iqoption'
config_ref = db.collection('stats').document('config')
config_ref.set({
    'dataSource': 'iqoption',
    'preferredTimeframe': 5,
}, merge=True)
print("\n[1/3] dataSource configurado para: 'iqoption'")
print("       O painel agora vai mostrar pares REAIS (EURUSD, GBPUSD...)")

# 2) Verifica quantos sinais IQ Option existem
iq_signals = list(db.collection('signals_iq').stream())
iq_count = len(iq_signals)
forex_count = 0
otc_count = 0
freshest_ts = None

for doc_snap in iq_signals:
    data = doc_snap.to_dict()
    pair = data.get('pair', '')
    updated_at = data.get('updatedAt')

    if '-OTC' in pair:
        otc_count += 1
    else:
        forex_count += 1

    if updated_at is not None:
        try:
            ts = updated_at.timestamp()
            if freshest_ts is None or ts > freshest_ts:
                freshest_ts = ts
        except Exception:
            pass

print(f"\n[2/3] Sinais encontrados em signals_iq:")
print(f"       Total: {iq_count} sinais")
print(f"       OTC: {otc_count} | Forex Real: {forex_count}")

if freshest_ts:
    age_minutes = (datetime.now(timezone.utc).timestamp() - freshest_ts) / 60
    freshest_str = datetime.fromtimestamp(freshest_ts, tz=timezone.utc).strftime('%H:%M:%S UTC')
    print(f"       Ultimo update: {freshest_str} ({age_minutes:.1f} min atras)")
    if age_minutes > 10:
        print(f"\n  AVISO: Dados desatualizados ({age_minutes:.0f} min)!")
        print("   O coletor Python (main.py) precisa estar rodando!")
    else:
        print("       Dados frescos - coletor ativo!")
else:
    print("\n  AVISO: Nenhum dado encontrado em signals_iq!")
    print("   Inicie o coletor: python main.py")

# 3) Verifica candles_iq
candles_count = len(list(db.collection('candles_iq').stream()))
print(f"\n[3/3] Candles IQ: {candles_count} documentos em candles_iq")
if candles_count == 0:
    print("   AVISO: Simulador vai travar sem candles! Inicie o main.py.")

print("\n" + "=" * 60)
if iq_count > 0 and candles_count > 0:
    print("TUDO PRONTO! O mercado real deve aparecer no painel.")
    print("Faca um hard refresh no browser (Ctrl+Shift+R).")
else:
    print("ACAO NECESSARIA: Inicie o coletor Python:")
    print()
    print("   cd c:\\Users\\casa\\Desktop\\catalogador\\iq_collector")
    print("   python main.py")
    print()
    print("Aguarde 2-3 minutos para os dados aparecerem.")
print("=" * 60)
