import firebase_admin
from firebase_admin import credentials, firestore
import os

# Caminho para a conta de serviço
cred_path = r'c:\Users\casa\Desktop\catalogador\iq_collector\firebase_service_account.json'

if not os.path.exists(cred_path):
    print(f"Erro: Arquivo não encontrado em {cred_path}")
    exit(1)

cred = credentials.Certificate(cred_path)
firebase_admin.initialize_app(cred)
db = firestore.client()

def reset_simulator():
    sim_ref = db.collection('stats').document('global_simulator')
    
    reset_data = {
        'bankroll': 5000.0,
        'currentBet': 10.0,
        'maxBet': 10.0,
        'phase': 'IDLE',
        'trades': [],
        'statusMessage': 'Simulador resetado com sucesso. Aguardando nova entrada...',
        'lastCycleId': None,
        'currentPair': None,
        'currentPattern': None,
        'currentDirection': None,
        'entryCandleOpenTime': None,
        'galeCandleOpenTime': None
    }
    
    sim_ref.set(reset_data, merge=True)
    print("Simulador resetado com sucesso!")
    print("Saldo: 5000.00")
    print("Historico: Limpo")

if __name__ == "__main__":
    reset_simulator()
