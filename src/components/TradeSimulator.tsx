import React, { useState, useEffect, useRef } from 'react';
import { Wallet, TrendingUp, TrendingDown, Zap, Clock, ArrowUp, ArrowDown } from 'lucide-react';
import { db } from '../lib/firebase';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface TradeEntry {
  id: string;
  pair: string;
  pattern: string;
  direction: 'CALL' | 'PUT';
  phase: 'Mão Fixa' | 'Gale 1' | 'Gale 2';
  openPrice: number;
  closePrice: number;
  result: 'GAIN' | 'LOSS';
  profit: number;
  time: number;
  bankrollAfter: number;
}

interface SimData {
  phase: 'IDLE' | 'M_FIXA' | 'GALE1' | 'GALE2';
  bankroll: number;
  trades: TradeEntry[];
  currentPair?: string;
  currentPattern?: string;
  currentDirection?: 'CALL' | 'PUT';
  galeCandleOpenTime?: number;
  statusMessage?: string;
  updatedAt?: any;
}

interface TradeSimulatorProps {
  lang: 'pt' | 'en';
}

// ─── Traduções ────────────────────────────────────────────────────────────────

const T = {
  pt: {
    title: 'Monitor de Alta Performance',
    bankrollLabel: 'Banca Atual (Real)',
    profitLabel: 'Lucro Acumulado',
    timeLabel: 'Tempo de Operação',
    daysLabel: 'Dias',
    historyTitle: 'Histórico de Operações',
    activeRobot: 'Robô Ativo 24h',
    noTrades: 'Aguardando primeiras operações...',
    monitoringNext: 'Monitorando próxima entrada',
    waitingCandle: 'Aguardando vela de entrada fechar...',
    inProgress: 'Operação em Andamento',
    analyzing: 'Analisando resultado...',
    inOpen: 'em aberto',
  },
  en: {
    title: 'High Performance Monitor',
    bankrollLabel: 'Current Bankroll',
    profitLabel: 'Accumulated Profit',
    timeLabel: 'Operating Time',
    daysLabel: 'Days',
    historyTitle: 'Trade History',
    activeRobot: 'Robot Active 24h',
    noTrades: 'Waiting for first trades...',
    monitoringNext: 'Monitoring next entry',
    waitingCandle: 'Waiting for entry candle to close...',
    inProgress: 'Trade in Progress',
    analyzing: 'Analyzing result...',
    inOpen: 'in open',
  }
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const fmtPrice = (p: number) => {
  if (p >= 1000) return p.toFixed(1);
  if (p >= 1)    return p.toFixed(3);
  return p.toFixed(5);
};

const START_DATE = new Date('2026-03-13T00:00:00');

// ─── Componente ───────────────────────────────────────────────────────────────

export const TradeSimulator: React.FC<TradeSimulatorProps> = ({ lang }) => {
  const t = T[lang];
  const [simData, setSimData] = useState<SimData>({
    phase: 'IDLE',
    bankroll: 5000,
    trades: []
  });
  const [prefTF, setPrefTF] = useState<number>(5);
  const [, setTick] = useState(0);
  const lastTradeCountRef = useRef<number>(0);
  const [flashResult, setFlashResult] = useState<{ type: 'GAIN' | 'LOSS'; profit: number; phase: string } | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Relógio interno (atualiza a cada segundo para o countdown)
  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  // Listener Firestore — simulador global
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "stats", "global_simulator"), (snap) => {
      if (!snap.exists()) return;
      const data = snap.data();

      const sortedTrades: TradeEntry[] = [...(data.trades || [])]
        .filter((t: any) => typeof t.result === 'string' && typeof t.profit === 'number')
        .sort((a, b) => a.time - b.time);

      setSimData({
        phase: data.phase || 'IDLE',
        bankroll: data.bankroll ?? 5000,
        trades: sortedTrades,
        currentPair: data.currentPair,
        currentPattern: data.currentPattern,
        currentDirection: data.currentDirection,
        galeCandleOpenTime: data.galeCandleOpenTime,
        statusMessage: data.statusMessage,
        updatedAt: data.updatedAt
      });

      // Flash quando chega novo trade
      const newCount = sortedTrades.length;
      if (lastTradeCountRef.current > 0 && newCount > lastTradeCountRef.current) {
        const latest = sortedTrades[sortedTrades.length - 1];
        if (latest) {
          if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
          setFlashResult({ type: latest.result, profit: latest.profit, phase: latest.phase });
          flashTimerRef.current = setTimeout(() => setFlashResult(null), 4000);
        }
      }
      lastTradeCountRef.current = newCount;
    });

    const unsubConfig = onSnapshot(doc(db, "stats", "config"), (snap) => {
      if (snap.exists()) setPrefTF(snap.data().preferredTimeframe || 5);
    });

    return () => {
      unsub();
      unsubConfig();
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  const toggleTimeframe = async (tf: number) => {
    try {
      await setDoc(doc(db, "stats", "config"), { preferredTimeframe: tf }, { merge: true });
      setPrefTF(tf);
    } catch (err) {
      console.error("Erro ao mudar timeframe:", err);
    }
  };

  // ─── Dados derivados ────────────────────────────────────────────────────────

  const pair      = simData.currentPair      || '---';
  const pattern   = simData.currentPattern   || '---';
  const direction = simData.currentDirection || '---';

  // Banca display: deduz a aposta em aberto
  const betIndex = simData.phase === 'M_FIXA' ? 0 : simData.phase === 'GALE1' ? 1 : simData.phase === 'GALE2' ? 2 : -1;
  const activeBet = betIndex >= 0 ? [1, 2, 4][betIndex] : 0;
  const displayedBankroll = simData.bankroll - activeBet;

  // Lucro acumulado (base de 1350 + sessão atual)
  const sessionProfit = simData.bankroll - 5000;
  const totalProfit = 1350 + sessionProfit;

  // Dias de operação
  const operatingDays = Math.floor(Math.abs(Date.now() - START_DATE.getTime()) / 86400000);

  // Trades para exibição (mais recente primeiro, max 30)
  const displayTrades = [...simData.trades].reverse().slice(0, 30);

  // Countdown até próxima vela de entrada
  const now = new Date();
  const cycleSeconds = prefTF * 60;
  const secondsInCycle = (now.getMinutes() % prefTF) * 60 + now.getSeconds();
  const secondsToNext = cycleSeconds - secondsInCycle;
  const countdownFormatted = `${Math.floor(secondsToNext / 60).toString().padStart(2, '0')}:${String(secondsToNext % 60).padStart(2, '0')}`;

  // ─── Painel de Status ───────────────────────────────────────────────────────
  const statusConfig = (() => {
    // Flash de resultado
    if (flashResult) {
      const isGain = flashResult.type === 'GAIN';
      return {
        msg: `${flashResult.phase}: ${isGain ? 'GAIN' : 'LOSS'} ${isGain ? '+' : ''}$${flashResult.profit.toFixed(2)}`,
        subMsg: `${pair} — ${direction}`,
        bgClass: isGain ? 'bg-emerald-500/20 border-emerald-500/60' : 'bg-red-500/20 border-red-500/60',
        dotClass: isGain ? 'bg-emerald-400' : 'bg-red-400',
        textClass: isGain ? 'text-emerald-300 text-xl font-black' : 'text-red-300 text-xl font-black',
        icon: isGain ? <TrendingUp size={36} className="text-emerald-400" /> : <TrendingDown size={36} className="text-red-400" />
      };
    }

    // Mão Fixa em andamento
    if (simData.phase === 'M_FIXA') {
      return {
        msg: simData.statusMessage || `${t.inProgress} (Mão Fixa): ${pair} → ${direction}`,
        subMsg: simData.statusMessage ? `${pattern} | -$1.00 ${t.inOpen}` : `${pattern} | -$1.00 ${t.inOpen}`,
        bgClass: 'bg-blue-500/10 border-blue-500/30',
        dotClass: 'bg-blue-500 animate-pulse',
        textClass: 'text-blue-300 font-semibold',
        icon: direction === 'CALL'
          ? <TrendingUp size={32} className="text-blue-400/50" />
          : <TrendingDown size={32} className="text-blue-400/50" />
      };
    }

    // Gale 1 em andamento
    if (simData.phase === 'GALE1') {
      return {
        msg: simData.statusMessage || `${t.inProgress} (Gale 1): ${pair} → ${direction}`,
        subMsg: simData.statusMessage ? `${pattern} | -$2.00 ${t.inOpen}` : `${pattern} | -$2.00 ${t.inOpen}`,
        bgClass: 'bg-orange-500/10 border-orange-500/30',
        dotClass: 'bg-orange-500 animate-pulse',
        textClass: 'text-orange-300 font-semibold',
        icon: direction === 'CALL'
          ? <TrendingUp size={32} className="text-orange-400/50" />
          : <TrendingDown size={32} className="text-orange-400/50" />
      };
    }

    // Gale 2 em andamento
    if (simData.phase === 'GALE2') {
      return {
        msg: simData.statusMessage || `${t.inProgress} (Gale 2): ${pair} → ${direction}`,
        subMsg: simData.statusMessage ? `${pattern} | -$4.00 ${t.inOpen}` : `${pattern} | -$4.00 ${t.inOpen}`,
        bgClass: 'bg-red-500/10 border-red-500/30',
        dotClass: 'bg-red-500 animate-pulse',
        textClass: 'text-red-300 font-semibold',
        icon: direction === 'CALL'
          ? <TrendingUp size={32} className="text-red-400/50" />
          : <TrendingDown size={32} className="text-red-400/50" />
      };
    }

    // IDLE — monitorando
    return {
      msg: simData.statusMessage || `${t.monitoringNext}: ${pair} (${pattern})`,
      subMsg: simData.statusMessage ? countdownFormatted : `Próxima entrada em ${countdownFormatted}`,
      bgClass: 'bg-slate-700/30 border-slate-600/30',
      dotClass: 'bg-slate-500',
      textClass: 'text-slate-400',
      icon: <Clock size={32} className="text-slate-600" />
    };
  })();

  return (
    <div className={`relative rounded-2xl p-6 mb-8 overflow-hidden transition-all duration-500 ${
      flashResult
        ? flashResult.type === 'GAIN'
          ? 'bg-emerald-950/60 border-2 border-emerald-500/80 shadow-xl shadow-emerald-500/20'
          : 'bg-red-950/60 border-2 border-red-500/80 shadow-xl shadow-red-500/20'
        : 'bg-slate-800/50 border border-blue-500/30 backdrop-blur-sm'
    } animate-in fade-in slide-in-from-top duration-500`}>

      {/* Overlay de GAIN/LOSS */}
      {flashResult && (
        <div className={`absolute inset-0 pointer-events-none animate-pulse rounded-2xl ${
          flashResult.type === 'GAIN' ? 'bg-emerald-500/5' : 'bg-red-500/5'
        }`} />
      )}

      <div className="flex flex-col lg:flex-row gap-8 relative z-10">

        {/* ── Painel Esquerdo ────────────────────────────────────────────── */}
        <div className="flex-1">

          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2 text-blue-400">
              <Wallet size={20} />
              <h2 className="font-bold uppercase tracking-wider text-sm">
                {t.title} ({prefTF === 1 ? 'M1' : 'M5'})
              </h2>
            </div>

            {/* Seletor M1 / M5 */}
            <div className="flex bg-slate-900/80 p-1 rounded-lg border border-slate-700 ml-4">
              {[1, 5].map(tf => (
                <button
                  key={tf}
                  onClick={() => toggleTimeframe(tf)}
                  className={`px-3 py-1 rounded-md text-[10px] font-bold transition-all ${
                    prefTF === tf ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  M{tf}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-3 ml-auto">
              <div className="bg-slate-900/60 border border-slate-700 px-3 py-1 rounded-full flex items-center gap-1.5">
                <Clock size={12} className="text-slate-400" />
                <span className="text-slate-300 text-[11px] font-mono font-bold">{countdownFormatted}</span>
              </div>
              <div className="bg-emerald-500/10 border border-emerald-500/20 px-3 py-1 rounded-full flex items-center gap-2">
                <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
                <span className="text-emerald-400 text-[10px] font-bold uppercase">{t.activeRobot}</span>
              </div>
            </div>
          </div>

          {/* Cards de Métricas */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-slate-900/80 p-4 rounded-xl border border-slate-700">
              <p className="text-slate-500 text-[10px] uppercase tracking-wider mb-1">{t.bankrollLabel}</p>
              <p className={`text-xl md:text-2xl font-bold transition-colors duration-300 ${
                flashResult ? (flashResult.type === 'GAIN' ? 'text-emerald-300' : 'text-red-300') : 'text-white'
              }`}>
                $ {displayedBankroll.toFixed(2)}
              </p>
              {activeBet > 0 && (
                <p className="text-amber-500/70 text-[10px] mt-1 font-mono">-${activeBet.toFixed(2)} {t.inOpen}</p>
              )}
            </div>

            <div className="bg-slate-900/80 p-4 rounded-xl border border-slate-700">
              <p className="text-slate-500 text-[10px] uppercase tracking-wider mb-1">{t.profitLabel}</p>
              <p className={`text-xl md:text-2xl font-bold ${totalProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {totalProfit >= 0 ? '+' : ''}$ {totalProfit.toFixed(2)}
              </p>
            </div>

            <div className="bg-slate-900/80 p-4 rounded-xl border border-slate-700 border-blue-500/20">
              <p className="text-slate-500 text-[10px] uppercase tracking-wider mb-1">{t.timeLabel}</p>
              <div className="flex items-baseline gap-1">
                <p className="text-xl md:text-2xl font-bold text-blue-400">{operatingDays}</p>
                <p className="text-[10px] text-blue-500/60 font-bold uppercase">{t.daysLabel}</p>
              </div>
            </div>
          </div>

          {/* Painel de Status */}
          <div className={`mt-4 p-4 rounded-xl flex items-center justify-between border transition-all duration-300 ${statusConfig.bgClass}`}>
            <div className="flex items-center gap-3">
              <div className={`w-3 h-3 rounded-full flex-shrink-0 ${statusConfig.dotClass}`} />
              <div>
                <p className={`font-bold text-sm leading-tight ${statusConfig.textClass}`}>
                  {statusConfig.msg}
                </p>
                <p className="text-slate-500 text-xs mt-0.5">{statusConfig.subMsg}</p>
              </div>
            </div>
            <div className="flex-shrink-0 ml-2">{statusConfig.icon}</div>
          </div>

          {/* Barra de Progresso */}
          <div className="mt-3 flex items-center gap-2">
            <span className="text-[10px] text-slate-600 uppercase font-bold tracking-wider">
              Ciclo M{prefTF}
            </span>
            <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-1000 ${
                  simData.phase === 'IDLE' ? 'bg-slate-600' :
                  simData.phase === 'M_FIXA' ? 'bg-blue-500' :
                  simData.phase === 'GALE1'  ? 'bg-orange-500' : 'bg-red-500'
                }`}
                style={{ width: `${((cycleSeconds - secondsToNext) / cycleSeconds) * 100}%` }}
              />
            </div>
            <span className="text-[10px] text-slate-500 font-mono">{countdownFormatted}</span>
          </div>
        </div>

        {/* ── Histórico de Trades ────────────────────────────────────────── */}
        <div className="lg:w-[420px]">
          <div className="flex items-center gap-2 text-slate-400 mb-3">
            <Zap size={16} />
            <h3 className="font-semibold text-xs uppercase tracking-wider">{t.historyTitle}</h3>
            <span className="ml-auto text-[10px] text-slate-600">{simData.trades.length} ops</span>
          </div>

          {simData.trades.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-28 text-slate-600 text-sm border border-dashed border-slate-700 rounded-xl">
              <Zap size={20} className="mb-2 opacity-40" />
              {t.noTrades}
            </div>
          ) : (
            <div className="space-y-1.5 max-h-[260px] overflow-y-auto pr-1 custom-scrollbar">
              {displayTrades.map((trade) => {
                const isGain = trade.result === 'GAIN';
                const phaseLabel =
                  trade.phase === 'Mão Fixa' ? 'MF' :
                  trade.phase === 'Gale 1'   ? 'G1' : 'G2';

                return (
                  <div
                    key={trade.id}
                    className={`flex items-center justify-between p-2.5 rounded-lg border text-[10px] transition-colors ${
                      isGain
                        ? 'bg-emerald-950/30 border-emerald-800/30 hover:border-emerald-700/50'
                        : 'bg-red-950/30 border-red-800/30 hover:border-red-700/50'
                    }`}
                  >
                    {/* Esquerda: seta + par + fase */}
                    <div className="flex items-center gap-1.5 min-w-0">
                      {trade.direction === 'CALL'
                        ? <ArrowUp size={11} className="text-emerald-400 flex-shrink-0" />
                        : <ArrowDown size={11} className="text-red-400 flex-shrink-0" />
                      }
                      <span className="text-white font-bold truncate">{trade.pair}</span>
                      <span className="text-slate-600">•</span>
                      <span className={`font-bold ${
                        trade.phase === 'Mão Fixa' ? 'text-blue-400' :
                        trade.phase === 'Gale 1'   ? 'text-orange-400' : 'text-red-400'
                      }`}>{phaseLabel}</span>
                    </div>

                    {/* Direita: preços + resultado + horário */}
                    <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
                      {trade.openPrice != null && (
                        <span className="text-slate-600 font-mono">
                          O:{fmtPrice(trade.openPrice)}
                        </span>
                      )}
                      {trade.closePrice != null && (
                        <span className="text-slate-600 font-mono">
                          C:{fmtPrice(trade.closePrice)}
                        </span>
                      )}
                      <span className={`font-black ${isGain ? 'text-emerald-400' : 'text-red-400'}`}>
                        {isGain ? '+' : ''}${(trade.profit ?? 0).toFixed(2)}
                      </span>
                      <span className={`px-1.5 py-0.5 rounded font-black text-[9px] ${
                        isGain ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'
                      }`}>
                        {isGain ? 'GAIN' : 'LOSS'}
                      </span>
                      <span className="text-slate-600 font-mono text-[9px]">
                        {fmtTime(trade.time)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

      </div>
    </div>
  );
};
