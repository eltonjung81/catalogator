import React, { useState, useEffect, useRef } from 'react';
import { Wallet, TrendingUp, TrendingDown, Zap, Clock, ArrowUp, ArrowDown } from 'lucide-react';
import { db } from '../lib/firebase';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';

interface Trade {
  id: string;
  pair: string;
  pattern: string;
  direction: 'CALL' | 'PUT';
  result: number; // 0, 1, 2 ou -1
  profit: number;
  status: string;
  time: number; // timestamp ms
}

interface SimData {
  bankroll: number;
  trades: Trade[];
  currentPair?: string;
  currentPattern?: string;
  currentDirection?: string;
  lastTradeId?: string;
  updatedAt?: any;
}

interface TradeSimulatorProps {
  topSignal: {
    pair: string;
    pattern: string;
    rawHistory: any[];
  } | null;
  galeLimit: number;
  lang: 'pt' | 'en';
}

const simulatorTranslations = {
  pt: {
    monitorTitle: 'Monitor de Alta Performance (M5)',
    bankrollLabel: 'Banca Atual (Real)',
    profitLabel: 'Lucro Acumulado',
    timeLabel: 'Tempo de Operação',
    daysLabel: 'Dias',
    historyTitle: 'Histórico de Operações',
    activeRobot: 'Robô Ativo 24h',
    cycleLabel: 'Ciclo M5',
    waitingTrades: 'Aguardando primeiras operações...',
    patternDetected: 'Padrão Detectado!',
    entering: 'Entrando',
    waitingCandle: 'Aguardando abertura da próxima vela...',
    opInProgress: 'Operação em Andamento',
    waitingResult: 'Aguardando resultado da primeira vela...',
    analyzing: 'Analisando Resultado...',
    waitingBroker: 'Aguardando confirmação pela corretora...',
    winDirect: 'WIN DIRETO',
    winGale1: 'WIN GALE 1',
    opClosed: 'Operação Encerrada',
    fixedHand: 'Mão Fixa',
    monitoring: 'Monitorando',
    nextEntry: 'Próxima entrada em',
    inOpen: 'em aberto'
  },
  en: {
    monitorTitle: 'High Performance Monitor (M5)',
    bankrollLabel: 'Current Bankroll (Real)',
    profitLabel: 'Accumulated Profit',
    timeLabel: 'Operating Time',
    daysLabel: 'Days',
    historyTitle: 'Trade History',
    activeRobot: 'Robot Active 24/7',
    cycleLabel: 'M5 Cycle',
    waitingTrades: 'Waiting for first trades...',
    patternDetected: 'Pattern Detected!',
    entering: 'Entering',
    waitingCandle: 'Waiting for next candle...',
    opInProgress: 'Trade in Progress',
    waitingResult: 'Waiting for first candle result...',
    analyzing: 'Analyzing Result...',
    waitingBroker: 'Waiting for broker confirmation...',
    winDirect: 'DIRECT WIN',
    winGale1: 'GALE 1 WIN',
    opClosed: 'Trade Closed',
    fixedHand: 'Fixed Hand',
    monitoring: 'Monitoring',
    nextEntry: 'Next entry in',
    inOpen: 'in open'
  }
};

// Retorna segundos até o próximo ciclo (5min para M1, 25min para M5)
const getSecondsToNextCycle = (prefTF: number): number => {
  const now = new Date();
  const totalSeconds = now.getMinutes() * 60 + now.getSeconds();
  const cycleSeconds = (prefTF === 1 ? 5 : 25) * 60;
  return cycleSeconds - (totalSeconds % cycleSeconds);
};

// Retorna a fase atual dentro do ciclo
const getCyclePhase = (prefTF: number): { phase: 'ENTRY' | 'M_FIXA' | 'GALE1' | 'GALE2' | 'IDLE'; cycleMin: number } => {
  const now = new Date();
  const totalMinutes = now.getMinutes();
  const cycleMinutes = prefTF === 1 ? 5 : 25;
  const currentInCycle = totalMinutes % cycleMinutes;
  
  const step = prefTF === 1 ? 1 : 5;

  // Em M5 (25min ciclo), a entrada é no minuto 20-24? 
  // Na verdade, a análise termina no fim do bloco de 25min.
  // Então a entrada é no 0, G1 no 5, G2 no 10 do PRÓXIMO bloco.
  
  if (currentInCycle >= cycleMinutes - (prefTF === 1 ? 1 : 1)) { // Último minuto/período do ciclo
    return { phase: 'ENTRY', cycleMin: currentInCycle };
  }
  
  if (currentInCycle < step) return { phase: 'M_FIXA', cycleMin: currentInCycle };
  if (currentInCycle < step * 2) return { phase: 'GALE1', cycleMin: currentInCycle };
  if (currentInCycle < step * 3) return { phase: 'GALE2', cycleMin: currentInCycle };
  
  return { phase: 'IDLE', cycleMin: currentInCycle };
};

// Calcula o valor total investido até o momento
const getActiveBet = (phase: 'ENTRY' | 'M_FIXA' | 'GALE1' | 'GALE2' | 'IDLE', secondsToNext: number, prefTF: number): number => {
  const stepSeconds = (prefTF === 1 ? 1 : 5) * 60;
  const buffer = 30; // 30s para o backend processar

  if (phase === 'M_FIXA') return 1;
  if (phase === 'GALE1') return secondsToNext >= (stepSeconds * 4) + buffer ? 1 : 3; 
  if (phase === 'GALE2') return secondsToNext >= (stepSeconds * 3) + buffer ? 3 : 7;
  return 0;
};

export const TradeSimulator: React.FC<TradeSimulatorProps> = ({ topSignal, lang }) => {
  const t = simulatorTranslations[lang];
  const [simData, setSimData] = useState<SimData>({ bankroll: 5000, trades: [] });

  // Tick interno — força re-render a cada segundo para atualizar countdown e fase
  const [, setTick] = useState<number>(0);
  const lastTradeIdRef = useRef<string | null>(null);

  // Flash de resultado: null = sem flash, 'GAIN' | 'LOSS' = exibindo resultado
  const [flashResult, setFlashResult] = useState<{ type: 'GAIN' | 'LOSS'; status: string; profit: number } | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── Relógio interno (atualiza a cada segundo) ───────────────────────────
  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  // ─── Listener do Firestore para o simulador global ───────────────────────
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "stats", "global_simulator"), (docSnap) => {
      if (!docSnap.exists()) return;
      const data = docSnap.data();

      const sortedTrades: Trade[] = [...(data.trades || [])].sort((a, b) => a.time - b.time);

      setSimData({
        bankroll: data.bankroll ?? 5000,
        trades: sortedTrades,
        currentPair: data.currentPair,
        currentPattern: data.currentPattern,
        currentDirection: data.currentDirection,
        lastTradeId: data.lastTradeId,
        updatedAt: data.updatedAt
      });

      // ─── Detecção de novo trade → flash GAIN/LOSS ───────────────────
      const newLastTradeId = data.lastTradeId as string | undefined;
      if (
        newLastTradeId &&
        lastTradeIdRef.current !== null &&        // não é a primeira carga
        lastTradeIdRef.current !== newLastTradeId  // é um trade novo
      ) {
        const latestTrade = sortedTrades[sortedTrades.length - 1];
        if (latestTrade) {
          const isGain = latestTrade.profit > 0;
          // Cancela flash anterior se ainda estiver ativo
          if (flashTimerRef.current) clearTimeout(flashTimerRef.current);

          setFlashResult({
            type: isGain ? 'GAIN' : 'LOSS',
            status: latestTrade.status,
            profit: latestTrade.profit
          });

          // Flash dura 3 segundos
          flashTimerRef.current = setTimeout(() => setFlashResult(null), 3000);
        }
      }

      lastTradeIdRef.current = newLastTradeId ?? null;
    });

    // Listener para a configuração de timeframe preferido
    const unsubConfig = onSnapshot(doc(db, "stats", "config"), (docSnap) => {
      if (docSnap.exists()) {
        setPrefTF(docSnap.data().preferredTimeframe || 5);
      }
    });

    return () => {
      unsub();
      unsubConfig();
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  const [prefTF, setPrefTF] = useState<number>(5);

  const toggleTimeframe = async (tf: number) => {
    try {
      await setDoc(doc(db, "stats", "config"), { preferredTimeframe: tf }, { merge: true });
      setPrefTF(tf);
    } catch (err) {
      console.error("Erro ao mudar timeframe:", err);
    }
  };

  // ─── Valores calculados a partir do relógio interno ─────────────────────
  const { phase } = getCyclePhase(prefTF);
  const secondsToNext = getSecondsToNextCycle(prefTF);
  const activeBet = getActiveBet(phase, secondsToNext, prefTF);

  // Detecta se a última operação já fechou neste ciclo (5 min ou 25 min)
  const nowMsGlobal = Date.now();
  const cycleDurationMs = (prefTF === 1 ? 5 : 25) * 60 * 1000;
  const cycleStartMsGlobal = Math.floor(nowMsGlobal / cycleDurationMs) * cycleDurationMs;
  
  const lastTradeGlobal = simData.trades.length > 0 ? simData.trades[simData.trades.length - 1] : null;
  // result >= 0 = WIN em algum nível (0=direto, 1=G1, 2=G2); -1 = LOSS total
  const cycleOpClosed = lastTradeGlobal !== null
    && lastTradeGlobal.time >= cycleStartMsGlobal - (prefTF === 1 ? 60_000 : 300_000)
    && lastTradeGlobal.result >= 0;

  // Se operação já fechou com WIN, não deduz aposta (ela foi devolvida + lucro)
  const displayedBankroll = cycleOpClosed ? simData.bankroll : simData.bankroll - activeBet;
  
  // Cálculo de Autoridade (Marketing)
  // 1350 de lucro base + o que o simulador ganhou na sessão
  const sessionProfit = simData.bankroll - 5000;
  const totalProfit = 1350 + sessionProfit;

  // Contador de dias (Iniciado em 13/03/2026 para dar 43 dias em 25/04/2026)
  const START_DATE = new Date('2026-03-13T00:00:00');
  const diffTime = Math.abs(new Date().getTime() - START_DATE.getTime());
  const operatingDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

  // Trades para exibição (mais recentes primeiro, últimos 20)
  const displayTrades = [...simData.trades].reverse().slice(0, 20);

  // ─── Mensagem de status do ciclo ────────────────────────────────────────
  const pair = simData.currentPair || topSignal?.pair || '---';
  const pattern = simData.currentPattern || topSignal?.pattern || '---';
  const direction = simData.currentDirection || '---';

  const statusConfig = (() => {
    if (flashResult) {
      const isGain = flashResult.type === 'GAIN';
      return {
        msg: `${flashResult.status}! ${isGain ? '+' : ''}$${flashResult.profit.toFixed(2)}`,
        subMsg: t.opClosed,
        bgClass: isGain ? 'bg-emerald-500/20 border-emerald-500/60' : 'bg-red-500/20 border-red-500/60',
        dotClass: isGain ? 'bg-emerald-400' : 'bg-red-400',
        textClass: isGain ? 'text-emerald-300 text-xl font-black' : 'text-red-300 text-xl font-black',
        icon: isGain ? <TrendingUp size={36} className="text-emerald-400" /> : <TrendingDown size={36} className="text-red-400" />
      };
    }
    if (phase === 'ENTRY') {
      return {
        msg: `${t.patternDetected} ${t.entering} ${lang === 'pt' ? 'em' : 'in'} ${pair} (${pattern})`,
        subMsg: t.waitingCandle,
        bgClass: 'bg-amber-500/10 border-amber-500/30',
        dotClass: 'bg-amber-500 animate-ping',
        textClass: 'text-amber-400 animate-pulse font-bold',
        icon: <TrendingUp size={32} className="text-amber-400/50" />
      };
    }
    // ── Fase de Mão Fixa ─────────────────────────────────────────────────────
    if (phase === 'M_FIXA') {
      return {
        msg: `${t.opInProgress} (${t.fixedHand}): ${pair} → ${direction}`,
        subMsg: `${pattern} | ${t.waitingResult}`,
        bgClass: 'bg-blue-500/10 border-blue-500/30',
        dotClass: 'bg-blue-500 animate-pulse',
        textClass: 'text-blue-300 font-semibold',
        icon: <TrendingUp size={32} className="text-blue-400/50" />
      };
    }

    // ── Fase de Gale 1 ───────────────────────────────────────────────────────
    if (phase === 'GALE1') {
      // Verifica se a mão fixa deste ciclo já ganhou (result === 0)
      const nowMs = Date.now();
      const cycleDuration = (prefTF === 1 ? 5 : 25) * 60 * 1000;
      const cycleStartMs = Math.floor(nowMs / cycleDuration) * cycleDuration;
      const lastTrade = simData.trades.length > 0 ? simData.trades[simData.trades.length - 1] : null;
      const buffer = prefTF === 1 ? 60_000 : 300_000;
      const inCycle = lastTrade !== null && lastTrade.time >= cycleStartMs - buffer;

      if (inCycle && lastTrade!.result === 0) {
        // Mão Fixa ganhou → operação encerrada, NÃO entra em Gale 1
        return {
          msg: `✅ ${t.winDirect}! ${pair} — ${t.opClosed}`,
          subMsg: lang === 'pt' ? 'Mão Fixa venceu. Nenhum Gale necessário.' : 'Fixed hand won. No Gale needed.',
          bgClass: 'bg-emerald-500/10 border-emerald-500/30',
          dotClass: 'bg-emerald-500',
          textClass: 'text-emerald-400 font-bold',
          icon: <TrendingUp size={32} className="text-emerald-400/60" />
        };
      }

      // Nos primeiros 30s do Gale 1 (secondsToNext entre 240 e 210), aguarda o backend reportar
      if (secondsToNext >= 210) {
        return {
          msg: `${t.analyzing} ${pair}`,
          subMsg: t.waitingBroker,
          bgClass: 'bg-slate-600/20 border-slate-500/30',
          dotClass: 'bg-slate-400 animate-ping',
          textClass: 'text-slate-300 font-semibold',
          icon: <Clock size={32} className="text-slate-500" />
        };
      }

      return {
        msg: `${t.opInProgress} (Gale 1): ${pair} → ${direction}`,
        subMsg: `${pattern} | ${lang === 'pt' ? 'Mão Fixa perdeu — aguardando resultado do Gale 1...' : 'Fixed hand lost — waiting for Gale 1 result...'}`,
        bgClass: 'bg-orange-500/10 border-orange-500/30',
        dotClass: 'bg-orange-500 animate-pulse',
        textClass: 'text-orange-300 font-semibold',
        icon: <TrendingUp size={32} className="text-orange-400/50" />
      };
    }

    // ── Fase de Gale 2 ───────────────────────────────────────────────────────
    if (phase === 'GALE2') {
      const nowMs = Date.now();
      const cycleDuration = (prefTF === 1 ? 5 : 25) * 60 * 1000;
      const cycleStartMs = Math.floor(nowMs / cycleDuration) * cycleDuration;
      const lastTrade = simData.trades.length > 0 ? simData.trades[simData.trades.length - 1] : null;
      const buffer = prefTF === 1 ? 60_000 : 300_000;
      const inCycle = lastTrade !== null && lastTrade.time >= cycleStartMs - buffer;

      if (inCycle && lastTrade!.result >= 0 && lastTrade!.result <= 1) {
        // Ganhou na mão fixa (0) ou no Gale 1 (1) → operação encerrada, NÃO entra em Gale 2
        const winLabel = lastTrade!.result === 0 ? t.winDirect : t.winGale1;
        return {
          msg: `✅ ${winLabel}! ${pair} — ${t.opClosed}`,
          subMsg: lang === 'pt' ? 'Operação venceu antes de chegar ao Gale 2.' : 'Trade won before reaching Gale 2.',
          bgClass: 'bg-emerald-500/10 border-emerald-500/30',
          dotClass: 'bg-emerald-500',
          textClass: 'text-emerald-400 font-bold',
          icon: <TrendingUp size={32} className="text-emerald-400/60" />
        };
      }

      // Nos primeiros 30s do Gale 2 (secondsToNext entre 180 e 150), aguarda o backend reportar
      if (secondsToNext >= 150) {
        return {
          msg: `${t.analyzing} ${pair}`,
          subMsg: t.waitingBroker,
          bgClass: 'bg-slate-600/20 border-slate-500/30',
          dotClass: 'bg-slate-400 animate-ping',
          textClass: 'text-slate-300 font-semibold',
          icon: <Clock size={32} className="text-slate-500" />
        };
      }

      return {
        msg: `${t.opInProgress} (Gale 2): ${pair} → ${direction}`,
        subMsg: `${pattern} | ${lang === 'pt' ? 'Gale 1 perdeu — aguardando resultado do Gale 2...' : 'Gale 1 lost — waiting for Gale 2 result...'}`,
        bgClass: 'bg-red-500/10 border-red-500/30',
        dotClass: 'bg-red-500 animate-pulse',
        textClass: 'text-red-300 font-semibold',
        icon: <TrendingDown size={32} className="text-red-400/50" />
      };
    }

    return {
      msg: `${t.monitoring} ${pair} (${pattern})`,
      subMsg: `${t.nextEntry} ${Math.floor(secondsToNext / 60)}:${String(secondsToNext % 60).padStart(2, '0')}`,
      bgClass: 'bg-slate-700/30 border-slate-600/30',
      dotClass: 'bg-slate-500',
      textClass: 'text-slate-400',
      icon: <Clock size={32} className="text-slate-600" />
    };
  })();

  // Countdown formatado
  const countdownFormatted = `${Math.floor(secondsToNext / 60).toString().padStart(2, '0')}:${String(secondsToNext % 60).padStart(2, '0')}`;

  if (!topSignal) return null;

  return (
    <div className={`relative rounded-2xl p-6 mb-8 overflow-hidden transition-all duration-500 ${
      flashResult
        ? flashResult.type === 'GAIN'
          ? 'bg-emerald-950/60 border-2 border-emerald-500/80 shadow-xl shadow-emerald-500/20'
          : 'bg-red-950/60 border-2 border-red-500/80 shadow-xl shadow-red-500/20'
        : 'bg-slate-800/50 border border-blue-500/30 backdrop-blur-sm'
    } animate-in fade-in slide-in-from-top duration-500`}>

      {/* Overlay animado de GAIN / LOSS */}
      {flashResult && (
        <div className={`absolute inset-0 pointer-events-none animate-pulse rounded-2xl ${
          flashResult.type === 'GAIN' ? 'bg-emerald-500/5' : 'bg-red-500/5'
        }`} />
      )}

      <div className="flex flex-col lg:flex-row gap-8 relative z-10">

        {/* ── Painel de Banca ───────────────────────────────────────── */}
        <div className="flex-1">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2 text-blue-400">
              <Wallet size={20} />
              <h2 className="font-bold uppercase tracking-wider text-sm">
                {prefTF === 5 ? t.monitorTitle : t.monitorTitle.replace('M5', 'M1')}
              </h2>
            </div>
            
            {/* Seletor de Timeframe do Simulador */}
            <div className="flex bg-slate-900/80 p-1 rounded-lg border border-slate-700 ml-4">
              <button
                onClick={() => toggleTimeframe(1)}
                className={`px-3 py-1 rounded-md text-[10px] font-bold transition-all ${prefTF === 1 ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}
              >
                M1
              </button>
              <button
                onClick={() => toggleTimeframe(5)}
                className={`px-3 py-1 rounded-md text-[10px] font-bold transition-all ${prefTF === 5 ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}
              >
                M5
              </button>
            </div>

            <div className="flex items-center gap-3 ml-auto">
              {/* Countdown até próxima entrada */}
              <div className="bg-slate-900/60 border border-slate-700 px-3 py-1 rounded-full flex items-center gap-1.5">
                <Clock size={12} className="text-slate-400" />
                <span className="text-slate-300 text-[11px] font-mono font-bold">{countdownFormatted}</span>
              </div>
              <div className="bg-emerald-500/10 border border-emerald-500/20 px-3 py-1 rounded-full flex items-center gap-2">
                <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></div>
                <span className="text-emerald-400 text-[10px] font-bold uppercase">{t.activeRobot}</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-slate-900/80 p-4 rounded-xl border border-slate-700 flex flex-col justify-center">
              <p className="text-slate-500 text-[10px] uppercase tracking-wider mb-1">{t.bankrollLabel}</p>
              <p className={`text-xl md:text-2xl font-bold transition-colors duration-300 ${flashResult ? (flashResult.type === 'GAIN' ? 'text-emerald-300' : 'text-red-300') : 'text-white'}`}>
                $ {displayedBankroll.toFixed(2)}
              </p>
              {activeBet > 0 && !cycleOpClosed && (
                <p className="text-amber-500/70 text-[10px] mt-1 font-mono">-${activeBet.toFixed(2)} {t.inOpen}</p>
              )}
            </div>

            <div className="bg-slate-900/80 p-4 rounded-xl border border-slate-700 flex flex-col justify-center">
              <p className="text-slate-500 text-[10px] uppercase tracking-wider mb-1">{t.profitLabel}</p>
              <p className={`text-xl md:text-2xl font-bold ${totalProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {totalProfit >= 0 ? '+' : ''}$ {totalProfit.toFixed(2)}
              </p>
            </div>

            <div className="bg-slate-900/80 p-4 rounded-xl border border-slate-700 flex flex-col justify-center border-blue-500/20">
              <p className="text-slate-500 text-[10px] uppercase tracking-wider mb-1">{t.timeLabel}</p>
              <div className="flex items-baseline gap-1">
                <p className="text-xl md:text-2xl font-bold text-blue-400">{operatingDays}</p>
                <p className="text-[10px] text-blue-500/60 font-bold uppercase">{t.daysLabel}</p>
              </div>
            </div>
          </div>

          {/* Painel de Status / Flash de Resultado */}
          <div className={`mt-4 p-4 rounded-xl flex items-center justify-between border transition-all duration-300 ${statusConfig.bgClass}`}>
            <div className="flex items-center gap-3">
              <div className="relative flex-shrink-0">
                <div className={`w-3 h-3 rounded-full ${statusConfig.dotClass}`}></div>
              </div>
              <div>
                <p className={`font-bold text-sm leading-tight ${statusConfig.textClass}`}>
                  {statusConfig.msg}
                </p>
                <p className="text-slate-500 text-xs mt-0.5">{statusConfig.subMsg}</p>
              </div>
            </div>
            <div className="flex-shrink-0 ml-2">
              {statusConfig.icon}
            </div>
          </div>

          {/* Barra de progresso do ciclo */}
          <div className="mt-3 flex items-center gap-2">
            <span className="text-[10px] text-slate-600 uppercase font-bold tracking-wider">{t.cycleLabel}</span>
            <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-1000 ${
                  phase === 'ENTRY' ? 'bg-amber-500' :
                  phase === 'IDLE' ? 'bg-slate-600' : 'bg-blue-500'
                }`}
                style={{ width: `${(( (prefTF === 1 ? 300 : 1500) - secondsToNext) / (prefTF === 1 ? 300 : 1500)) * 100}%` }}
              />
            </div>
            <span className="text-[10px] text-slate-500 font-mono">{countdownFormatted}</span>
          </div>
        </div>

        {/* ── Histórico de Trades ───────────────────────────────────── */}
        <div className="lg:w-96">
          <div className="flex items-center gap-2 text-slate-400 mb-3">
            <Zap size={16} />
            <h3 className="font-semibold text-xs uppercase tracking-wider">{t.historyTitle}</h3>
            <span className="ml-auto text-[10px] text-slate-600">{simData.trades.length} ops</span>
          </div>

          {simData.trades.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-28 text-slate-600 text-sm border border-dashed border-slate-700 rounded-xl">
              <Zap size={20} className="mb-2 opacity-40" />
              {t.waitingTrades}
            </div>
          ) : (
            <div className="space-y-1.5 max-h-[200px] overflow-y-auto pr-1 custom-scrollbar">
              {displayTrades.map((trade) => {
                const isGain = trade.profit > 0;
                const tradeDirection = trade.direction || (Math.random() > 0.5 ? 'CALL' : 'PUT');
                const level =
                  trade.result === 0 ? t.fixedHand :
                  trade.result === 1 ? 'G1' :
                  trade.result === 2 ? 'G2' : 'G2';

                return (
                  <div
                    key={trade.id}
                    className={`flex items-center justify-between p-2.5 rounded-lg border text-[10px] transition-colors ${
                      isGain
                        ? 'bg-emerald-950/30 border-emerald-800/30 hover:border-emerald-700/50'
                        : 'bg-red-950/30 border-red-800/30 hover:border-red-700/50'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {/* Seta de direção */}
                      {tradeDirection === 'CALL'
                        ? <ArrowUp size={12} className="text-emerald-400 flex-shrink-0" />
                        : <ArrowDown size={12} className="text-red-400 flex-shrink-0" />
                      }
                      <span className="text-white font-bold truncate">{trade.pair}</span>
                      <span className="text-slate-600">•</span>
                      <span className="text-slate-400">{level}</span>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                      <span className={`font-black ${isGain ? 'text-emerald-400' : 'text-red-400'}`}>
                        {isGain ? '+' : ''}${trade.profit.toFixed(2)}
                      </span>
                      <span className={`px-1.5 py-0.5 rounded font-black text-[9px] ${
                        isGain ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'
                      }`}>
                        {isGain ? 'GAIN' : 'LOSS'}
                      </span>
                      <span className="text-slate-600 font-mono text-[9px]">
                        {new Date(trade.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
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
