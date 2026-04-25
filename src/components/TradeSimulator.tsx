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
  const [currentStep, setCurrentStep] = useState(0);
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

  const profit = simData.bankroll - 5000;

  // Efeito visual de "Analisando..."
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentStep(prev => (prev + 1) % 3);
    }, 3000);
    return () => clearInterval(timer);
  }, []);

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

          <div className="mt-6 bg-blue-500/10 border border-blue-500/20 p-4 rounded-xl flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="relative">
                <div className="w-3 h-3 bg-blue-500 rounded-full animate-ping"></div>
                <div className="absolute inset-0 w-3 h-3 bg-blue-500 rounded-full"></div>
              </div>
              <div>
                <p className="text-blue-400 font-bold text-sm">
                  {currentStep === 0 && `Monitorando ${topSignal.pair}...`}
                  {currentStep === 1 && `Padrão ${topSignal.pattern} detectado!`}
                  {currentStep === 2 && `Preparando entrada de $1.00...`}
                </p>
                <p className="text-slate-500 text-xs">Aguardando fechamento da vela para confirmação</p>
              </div>
            </div>
            <TrendingUp className="text-blue-400/30" size={32} />
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
