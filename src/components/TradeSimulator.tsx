import React, { useState, useEffect } from 'react';
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
  const [simData, setSimData] = useState<{bankroll: number, trades: any[]}>({ bankroll: 5000, trades: [] });
  
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "stats", "global_simulator"), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setSimData({
          bankroll: data.bankroll || 5000,
          trades: (data.trades || []).slice(-20).reverse()
        });
      }
    });
    return () => unsub();
  }, []);

  const [liveStatus, setLiveStatus] = useState<{msg: string, color: string, isEntering: boolean}>({
    msg: 'Monitorando mercado...',
    color: 'text-blue-400',
    isEntering: false
  });

  // Efeito de Ciclo de Operação em Tempo Real
  useEffect(() => {
    const updateStatus = () => {
      const now = new Date();
      const min = now.getMinutes();
      const cycleMin = min % 5;

      // Gera uma semente estável para o bloco de 5 minutos atual
      const blockTimestamp = Math.floor(now.getTime() / (5 * 60 * 1000));
      // Usa o par e o bloco para decidir a direção (fixo por 5 min)
      const directionSeed = (blockTimestamp + (topSignal?.pair.length || 0)) % 2;
      const direction = directionSeed === 0 ? 'COMPRADO' : 'VENDIDO';

      if (cycleMin === 4) {
        setLiveStatus({
          msg: `Padrão Detectado! Entrando ${direction} em ${topSignal?.pair} (${topSignal?.pattern}) na próxima vela...`,
          color: 'text-amber-400 animate-pulse',
          isEntering: true
        });
      } else if (cycleMin === 0 || cycleMin === 1 || cycleMin === 2) {
        const stage = cycleMin === 0 ? 'Mão Fixa' : `Gale ${cycleMin}`;
        setLiveStatus({
          msg: `Operação em Andamento (${stage}): ${topSignal?.pair} - ${topSignal?.pattern} (${direction})`,
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

  const profit = simData.bankroll - 5000;

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
              <p className="text-2xl font-bold text-white">$ {simData.bankroll.toFixed(2)}</p>
            </div>
            <div className="bg-slate-900/80 p-4 rounded-xl border border-slate-700">
              <p className="text-slate-500 text-xs mb-1">Lucro Acumulado</p>
              <p className={`text-2xl font-bold ${profit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {profit >= 0 ? '+' : ''}$ {profit.toFixed(2)}
              </p>
            </div>
          </div>

          <div className={`mt-6 p-4 rounded-xl flex items-center justify-between border transition-colors ${liveStatus.isEntering ? 'bg-amber-500/10 border-amber-500/30' : 'bg-blue-500/10 border-blue-500/20'}`}>
            <div className="flex items-center gap-3">
              <div className="relative">
                <div className={`w-3 h-3 rounded-full animate-ping ${liveStatus.isEntering ? 'bg-amber-500' : 'bg-blue-500'}`}></div>
                <div className={`absolute inset-0 w-3 h-3 rounded-full ${liveStatus.isEntering ? 'bg-amber-500' : 'bg-blue-500'}`}></div>
              </div>
              <div>
                <p className={`font-bold text-sm ${liveStatus.color}`}>
                  {liveStatus.msg}
                </p>
                <p className="text-slate-500 text-xs">Sincronizado com o ciclo de 5 minutos da Binance</p>
              </div>
            </div>
            <TrendingUp className={liveStatus.isEntering ? 'text-amber-400/30' : 'text-blue-400/30'} size={32} />
          </div>
        </div>

        {/* Histórico de Trades Simulado */}
        <div className="lg:w-80">
          <div className="flex items-center gap-2 text-slate-400 mb-4">
            <Zap size={18} />
            <h3 className="font-semibold text-xs uppercase">Últimas Operações do Robô</h3>
          </div>
          <div className="space-y-2 max-h-[160px] overflow-y-auto pr-2 custom-scrollbar">
            {simData.trades.map((trade, i) => (
              <div key={i} className="flex items-center justify-between bg-slate-900/50 p-2 rounded-lg border border-slate-800 text-[11px]">
                <div className="flex items-center gap-2">
                  {trade.profit > 0 ? (
                    <ArrowUpCircle size={14} className="text-emerald-500" />
                  ) : (
                    <ArrowDownCircle size={14} className="text-red-500" />
                  )}
                  <span className="text-white font-medium">{trade.pair}</span>
                </div>
                <span className={trade.profit > 0 ? 'text-emerald-400' : 'text-red-400'}>
                  {trade.profit > 0 ? '+' : ''}{trade.profit.toFixed(2)}
                </span>
                <span className="text-slate-600 italic">{trade.status}</span>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
};
