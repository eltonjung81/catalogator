import React, { useState, useEffect, useMemo } from 'react';
import { Wallet, TrendingUp, Zap, ArrowUpCircle, ArrowDownCircle } from 'lucide-react';
import { db } from '../lib/firebase';
import { doc, onSnapshot } from 'firebase/firestore';

interface TradeSimulatorProps {
  topSignal: {
    pair: string;
    pattern: string;
    rawHistory: number[];
  } | null;
}

export const TradeSimulator: React.FC<TradeSimulatorProps> = ({ topSignal }) => {
  const [liveStatus, setLiveStatus] = useState<{msg: string, color: string, isEntering: boolean}>({
    msg: 'Monitorando mercado...',
    color: 'text-blue-400',
    isEntering: false
  });

  const [simData, setSimData] = useState<{
    bankroll: number, 
    trades: any[], 
    currentPair?: string, 
    currentPattern?: string, 
    currentDirection?: string
  }>({ bankroll: 5000, trades: [] });

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "stats", "global_simulator"), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setSimData({
          bankroll: data.bankroll || 5000,
          trades: (data.trades || []).slice(-20).reverse(),
          currentPair: data.currentPair,
          currentPattern: data.currentPattern,
          currentDirection: data.currentDirection
        });
      }
    });
    return () => unsub();
  }, []);

  // Efeito de Ciclo de Operação em Tempo Real
  useEffect(() => {
    const updateStatus = () => {
      const now = new Date();
      const min = now.getMinutes();
      const cycleMin = min % 5;

      const direction = simData.currentDirection || 'ANALISANDO';

      if (cycleMin === 4) {
        setLiveStatus({
          msg: `Padrão Detectado! Entrando ${direction} em ${simData.currentPair || topSignal?.pair} (${simData.currentPattern || topSignal?.pattern}) na próxima vela...`,
          color: 'text-amber-400 animate-pulse',
          isEntering: true
        });
      } else if (cycleMin === 0 || cycleMin === 1 || cycleMin === 2) {
        const stage = cycleMin === 0 ? 'Mão Fixa' : `Gale ${cycleMin}`;
        setLiveStatus({
          msg: `Operação em Andamento (${stage}): ${simData.currentPair || topSignal?.pair} - ${simData.currentPattern || topSignal?.pattern} (${direction})`,
          color: 'text-emerald-400',
          isEntering: false
        });
      } else {
        setLiveStatus({
          msg: `Monitorando ${topSignal?.pair} (${topSignal?.pattern})... Aguardando sinal.`,
          color: 'text-blue-400',
          isEntering: false
        });
      }
    };

    const timer = setInterval(updateStatus, 1000);
    updateStatus();
    return () => clearInterval(timer);
  }, [topSignal]);

  const [flashResult, setFlashResult] = useState<{status: string, color: string} | null>(null);
  const lastTradeIdRef = React.useRef<string | null>(null);

  // Detecta conclusão de trade para o Flash de 1 segundo
  useEffect(() => {
    if (simData.trades.length > 0) {
      const latestTrade = simData.trades[0];
      if (lastTradeIdRef.current && lastTradeIdRef.current !== latestTrade.id) {
        // Um novo trade acabou de ser concluído!
        setFlashResult({
          status: latestTrade.status,
          color: latestTrade.profit > 0 ? 'text-emerald-400' : 'text-red-400'
        });
        
        // Remove o flash após 1 segundo
        setTimeout(() => setFlashResult(null), 1000);
      }
      lastTradeIdRef.current = latestTrade.id;
    }
  }, [simData.trades]);

  const profit = simData.bankroll - 5000;

  // Calcula o valor da aposta atual para descontar "ao vivo"
  const currentBetValue = useMemo(() => {
    const now = new Date();
    const cycleMin = now.getMinutes() % 5;
    if (cycleMin === 0) return 1; // Mão Fixa
    if (cycleMin === 1) return 3; // Mão Fixa (1) + Gale 1 (2)
    if (cycleMin === 2) return 7; // 1 + 2 + Gale 2 (4)
    return 0;
  }, [new Date().getMinutes()]);

  const displayedBankroll = simData.bankroll - currentBetValue;

  if (!topSignal) return null;

  return (
    <div className="bg-slate-800/50 border border-blue-500/30 rounded-2xl p-6 mb-8 backdrop-blur-sm animate-in fade-in slide-in-from-top duration-500">
      <div className="flex flex-col lg:flex-row gap-8">
        
        {/* Painel de Banca */}
        <div className="flex-1">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2 text-blue-400">
              <Wallet size={20} />
              <h2 className="font-bold uppercase tracking-wider text-sm">Monitor de Alta Performance (Fixo M5)</h2>
            </div>
            <div className="bg-emerald-500/10 border border-emerald-500/20 px-3 py-1 rounded-full flex items-center gap-2">
              <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></div>
              <span className="text-emerald-400 text-[10px] font-bold uppercase">Robô Ativo 24h na Nuvem</span>
            </div>
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-slate-900/80 p-4 rounded-xl border border-slate-700">
              <p className="text-slate-500 text-xs mb-1">Banca Atual (Demo)</p>
              <p className="text-2xl font-bold text-white">$ {displayedBankroll.toFixed(2)}</p>
            </div>
            <div className="bg-slate-900/80 p-4 rounded-xl border border-slate-700">
              <p className="text-slate-500 text-xs mb-1">Lucro Acumulado</p>
              <p className={`text-2xl font-bold ${profit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {profit >= 0 ? '+' : ''}$ {profit.toFixed(2)}
              </p>
            </div>
          </div>

          <div className={`mt-6 p-4 rounded-xl flex items-center justify-between border transition-all duration-300 ${flashResult ? 'bg-white/10 border-white/40 scale-[1.02]' : liveStatus.isEntering ? 'bg-amber-500/10 border-amber-500/30' : 'bg-blue-500/10 border-blue-500/20'}`}>
            <div className="flex items-center gap-3">
              <div className="relative">
                <div className={`w-3 h-3 rounded-full animate-ping ${flashResult ? 'bg-white' : liveStatus.isEntering ? 'bg-amber-500' : 'bg-blue-500'}`}></div>
                <div className={`absolute inset-0 w-3 h-3 rounded-full ${flashResult ? 'bg-white' : liveStatus.isEntering ? 'bg-amber-500' : 'bg-blue-500'}`}></div>
              </div>
              <div>
                <p className={`font-bold text-sm ${flashResult ? flashResult.color + ' text-xl animate-bounce' : liveStatus.color}`}>
                  {flashResult ? `RESULTADO: ${flashResult.status}!` : liveStatus.msg}
                </p>
                <p className="text-slate-500 text-xs">
                  {flashResult ? 'Operação encerrada e computada' : 'Sincronizado com o ciclo de 5 minutos da Binance'}
                </p>
              </div>
            </div>
            <TrendingUp className={flashResult ? 'text-white' : liveStatus.isEntering ? 'text-amber-400/30' : 'text-blue-400/30'} size={32} />
          </div>
        </div>

        {/* Histórico de Trades Simulado */}
        <div className="lg:w-96">
          <div className="flex items-center gap-2 text-slate-400 mb-4">
            <Zap size={18} />
            <h3 className="font-semibold text-xs uppercase">Histórico de Operações</h3>
          </div>
          <div className="space-y-2 max-h-[160px] overflow-y-auto pr-2 custom-scrollbar">
            {simData.trades.map((trade, i) => (
              <div key={i} className="flex items-center justify-between bg-slate-900/50 p-2 rounded-lg border border-slate-800 text-[10px] hover:border-slate-600 transition-colors">
                <div className="flex items-center gap-1.5">
                  <span className="text-white font-bold min-w-[65px]">{trade.pair}</span>
                  <span className="text-slate-700">|</span>
                  <span className={`font-bold min-w-[50px] ${trade.profit > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {trade.profit > 0 ? '+' : ''}{trade.profit.toFixed(2)}
                  </span>
                  <span className="text-slate-700">|</span>
                  <span className="text-slate-500 italic">
                    {new Date(trade.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <span className={`font-black px-2 py-0.5 rounded text-[9px] ${trade.profit > 0 ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500'}`}>
                  {trade.status}
                </span>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
};
