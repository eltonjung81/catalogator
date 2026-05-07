// Robot Version 5.1 — Binance + IQ Option + Deriv Multi-Source Simulator (Refreshed)
import * as admin from 'firebase-admin';
import { onSchedule } from "firebase-functions/v2/scheduler";

admin.initializeApp();

export { createPreference, mercadopagoWebhook } from './payments';
import {
  fetchCandles,
  groupInBlocks,
  runCataloger,
  analyzeMHI1,
  analyzeMHI2,
  analyzeMHI3,
  analyzeMHIMaioria,
  analyzeTorresGemeas,
  analyzeTorresGemeasM1,
  analyzePadrao23,
  analyzePadrao23M1,
  analyzeM1Trend,
  isDeadChart,
  TradeResult,
  Candle
} from './cataloger';

const db = admin.firestore();

// ── Pares Binance (Cripto) ────────────────────────────────────────────────────
const PAIRS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'DOTUSDT'];

// ── Pares IQ Option que necessitam de dados do Firestore (via Python collector) ──
const IQ_FOREX_PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'EURGBP', 'EURJPY', 'GBPJPY', 'NZDUSD'];

/**
 * Detecta se um par é da IQ Option (OTC ou Forex).
 * Esses pares têm candles armazenados no Firestore pelo Python collector.
 */


/**
 * Busca candles de pares IQ Option do Firestore.
 * O Python collector escreve em `candles_iq/{pair}_M{tf}` a cada minuto.
 */
const fetchCandlesIQ = async (pair: string, tf: number): Promise<Candle[]> => {
  try {
    const docRef = db.collection('candles_iq').doc(`${pair}_M${tf}`);
    const snap = await docRef.get();
    if (!snap.exists) {
      console.log(`[IQ] candles_iq/${pair}_M${tf} ainda não disponível.`);
      return [];
    }
    const data = snap.data();
    return (data?.candles || []) as Candle[];
  } catch (err) {
    console.error(`[IQ] Erro ao buscar candles_iq/${pair}_M${tf}:`, err);
    return [];
  }
};

/**
 * Roteador: busca candles da fonte correta baseado no par.
 */
const fetchCandlesDeriv = async (pair: string, tf: number): Promise<Candle[]> => {
  try {
    const docRef = db.collection('candles_deriv').doc(`${pair}_M${tf}`);
    const snap = await docRef.get();
    if (!snap.exists) return [];
    return (snap.data()?.candles || []) as Candle[];
  } catch (err) {
    return [];
  }
};

const fetchCandlesAny = async (pair: string, interval: string, limit: number): Promise<Candle[]> => {
  const tf = interval === '1m' ? 1 : 5;
  if (pair.startsWith('frx') || pair.startsWith('R_') || pair.includes('HZ')) {
    return fetchCandlesDeriv(pair, tf);
  }
  if (pair.includes('-OTC') || IQ_FOREX_PAIRS.includes(pair)) {
    return fetchCandlesIQ(pair, tf);
  }
  return fetchCandles(pair, interval, limit);
};

const M5_STRATEGIES = [
  { name: 'MHI 1',          func: analyzeMHI1,          entryIndex: 0 },
  { name: 'MHI 2',          func: analyzeMHI2,          entryIndex: 1 },
  { name: 'MHI 3',          func: analyzeMHI3,          entryIndex: 2 },
  { name: 'MHI Maioria',    func: analyzeMHIMaioria,    entryIndex: 0 },
  { name: 'Torres Gêmeas',  func: analyzeTorresGemeas,  entryIndex: 0 },
  { name: 'Padrão 23',      func: analyzePadrao23,      entryIndex: 0 }
];

const M1_STRATEGIES = [
  { name: 'Tendência M1',       func: analyzeM1Trend,        entryIndex: 0 },
  { name: 'MHI 1 (M1)',         func: analyzeMHI1,           entryIndex: 0 },
  { name: 'MHI 2 (M1)',         func: analyzeMHI2,           entryIndex: 1 },
  { name: 'MHI 3 (M1)',         func: analyzeMHI3,           entryIndex: 2 },
  { name: 'MHI Maioria (M1)',   func: analyzeMHIMaioria,     entryIndex: 0 },
  { name: 'Padrão 23 (M1)',     func: analyzePadrao23M1,     entryIndex: 0 },
  { name: 'Torres Gêmeas (M1)', func: analyzeTorresGemeasM1, entryIndex: 0 },
];

// ============================================================================
// APOSTAS — escala Mão Fixa / Gale 1 / Gale 2
// ============================================================================
const PAYOUT = 0.89;

const calcBetProfit = (betAmount: number, isGain: boolean): number => {
  if (isGain) return parseFloat((betAmount * PAYOUT).toFixed(2));
  return -betAmount;
};

// ============================================================================
// SCORE DE RANKING — TrendScore (últimas 10) + WinRate (últimas 100)
// ============================================================================
const getScore = (history: TradeResult[], dojiRate: number = 0): number => {
  if (!history || history.length === 0) return -9999;
  const recent = history.slice(-100);
  let wins = 0;
  let trendScore = 0;

  recent.forEach((r, idx) => {
    const isWin = r.result >= 0;
    if (isWin) wins++;
    if (idx >= recent.length - 10) {
      trendScore += isWin ? 1 : -1;
    }
  });

  const winRate = wins / recent.length;
  // Penalidade pesada para Dojis: subtrai 2 pontos para cada 1% de Doji
  const liquidityPenalty = dojiRate * 2;
  // Peso ajustado: WinRate (Longo Prazo) tem peso 200, Trend (Curto Prazo) reduzido para peso 5
  return (trendScore * 5) + (winRate * 200) - liquidityPenalty;
};

// ============================================================================
// FASE 2 — SIMULADOR COM MÁQUINA DE ESTADO LIMPA
//
// Estados possíveis em stats/global_simulator:
//   phase: 'IDLE' | 'M_FIXA' | 'GALE1' | 'GALE2'
//
// Fluxo:
//   IDLE → analisa último bloco completo → sinal → entra M_FIXA
//   M_FIXA → vela fechou?
//     GAIN → registra GAIN no histórico → IDLE
//     LOSS → registra LOSS no histórico → GALE1
//   GALE1 → vela fechou?
//     GAIN → registra GAIN → IDLE
//     LOSS → registra LOSS → GALE2
//   GALE2 → vela fechou?
//     GAIN → registra GAIN → IDLE
//     LOSS → registra LOSS → IDLE
// ============================================================================


interface SimData {
  phase: string;
  bankroll: number;
  currentBet: number;
  maxBet: number;
  trades?: any[];
  lastCycleId?: string | null;
  currentPair?: string;
  currentPattern?: string;
  currentDirection?: any;
  entryCandleOpenTime?: number;
  galeCandleOpenTime?: number | null;
  statusMessage?: string;
}

async function runSimulator(prefTF: number, allSignalsData: any[]) {
  const simRef = db.collection("stats").doc("global_simulator");
  const simSnap = await simRef.get();
  const rawData = (simSnap.data() || {}) as SimData;
  
  const phase = rawData.phase || 'IDLE';
  const bankroll = (typeof rawData.bankroll === 'number' && !isNaN(rawData.bankroll)) ? rawData.bankroll : 5000;
  const currentBet = (typeof rawData.currentBet === 'number' && !isNaN(rawData.currentBet)) ? rawData.currentBet : 1;
  const maxBet = (typeof rawData.maxBet === 'number' && !isNaN(rawData.maxBet)) ? rawData.maxBet : 1;

  const simData: any = { ...rawData, phase, bankroll, currentBet, maxBet };
  const interval = prefTF === 1 ? '1m' : '5m';
  const candleIntervalMs = prefTF * 60 * 1000;

  // ── IDLE: Procura novo sinal e seta M_FIXA enquanto vela ainda está aberta ─
  if (phase === 'IDLE') {

    const fiveMinutesAgo = Date.now() - (10 * 60 * 1000); // Aumentado para 10 min para ser mais tolerante
    const liveSignals = allSignalsData.filter(s => {
      const isRecent = s.updatedAt && (s.updatedAt.toMillis ? s.updatedAt.toMillis() : s.updatedAt) > fiveMinutesAgo;
      return s.rawHistory && s.rawHistory.length > 0 && !s.isDead && isRecent;
    });

    if (liveSignals.length === 0) {
      console.log('[SIM] Nenhum sinal ativo disponível.');
      await simRef.set({
        statusMessage: `Aguardando sinais vivos... (Encontrados: ${allSignalsData.length})`,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return;
    }

    // Pre-calcula scores incluindo liquidez
    const signalsWithLiquidity = (await Promise.all(liveSignals.map(async s => {
      try {
        const candles = await fetchCandlesAny(s.pair, interval, 100);
        if (!candles || candles.length < 5) return null;

        const dojis = candles.filter(c => c.color === 'DOJI').length;
        const dojiRate = (dojis / (candles.length || 1)) * 100;
        
        const recent = s.rawHistory.slice(-100);
        const wins = recent.filter((r: any) => r.result >= 0).length;
        const winRate = (wins / (recent.length || 1)) * 100;

        return { 
          ...s, 
          dojiRate, 
          winRate,
          candles, // Cache para uso posterior
          score: getScore(s.rawHistory, dojiRate) 
        };
      } catch (err) {
        console.error(`[SIM] Erro ao processar liquidez para ${s.pair}:`, err);
        return null;
      }
    })));

    const validSignals = signalsWithLiquidity.filter((s): s is any => s !== null && s.winRate >= 92);

    const sorted = validSignals.sort((a, b) => b.score - a.score);
    const topCandidates = sorted.slice(0, 5); 

    let bestCandidate: any = null;
    let bestSignal: string | null = null;
    let bestStrategy: any = null;
    let bestAnalysisBlock: Candle[] = [];

    const strategies = prefTF === 1 ? M1_STRATEGIES : M5_STRATEGIES;

    for (const cand of topCandidates) {
      const strategy = strategies.find(s => s.name === cand.pattern);
      if (!strategy) continue;

      const candles = cand.candles;
      if (candles.length < 6) continue;

      const blocks = groupInBlocks(candles, 5);
      const completeBlocks = blocks.filter(b => b.length === 5);
      if (completeBlocks.length === 0) continue;

      const analysisBlock = completeBlocks[completeBlocks.length - 1];
      const signal = strategy.func(analysisBlock);
      
      if (signal) {
        console.log(`[SIM] Candidato Escolhido: ${cand.pair} | WinRate: ${cand.winRate.toFixed(1)}% | Score: ${cand.score.toFixed(1)}`);
        bestCandidate = cand;
        bestSignal = signal;
        bestStrategy = strategy;
        bestAnalysisBlock = analysisBlock;
        break; 
      }
    }

    if (!bestCandidate) {
      if (topCandidates.length > 0) {
        const top1 = topCandidates[0];
        const statusMsg = `Analisando ${validSignals.length} sinais... Melhor: ${top1.pair} (${top1.winRate.toFixed(1)}%) sem entrada agora.`;
        console.log(`[SIM] ${statusMsg}`);
        await simRef.set({
          currentPair: top1.pair,
          currentPattern: top1.pattern,
          currentDirection: null,
          phase: 'IDLE',
          statusMessage: statusMsg,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      } else {
        const statusMsg = `Aguardando assertividade > 92%... (Sinais vivos: ${liveSignals.length})`;
        console.log(`[SIM] ${statusMsg}`);
        await simRef.set({
          statusMessage: statusMsg,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }
      return;
    }

    const direction: 'CALL' | 'PUT' = bestSignal === 'GREEN' ? 'CALL' : 'PUT';
    const lastBlockCandle = bestAnalysisBlock[bestAnalysisBlock.length - 1];
    const entryCandleOpenTime = lastBlockCandle.openTime + candleIntervalMs + (bestStrategy.entryIndex * candleIntervalMs);
    const cycleId = `${bestCandidate.pair}_${entryCandleOpenTime}`;

    // Já processamos esse ciclo? Sai sem fazer nada.
    if (simData.lastCycleId === cycleId) {
      console.log(`[SIM] Ciclo ${cycleId} já processado.`);
      return;
    }

    const entryTimeStr = new Date(entryCandleOpenTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const statusMsg = `SINAL CONFIRMADO: ${bestCandidate.pair} | ${bestCandidate.pattern} | ${direction} às ${entryTimeStr}`;

    console.log(`[SIM] ${statusMsg}`);
    await simRef.set({
      phase: 'M_FIXA',
      lastCycleId: cycleId,
      currentPair: bestCandidate.pair,
      currentPattern: bestCandidate.pattern,
      currentDirection: direction,
      statusMessage: statusMsg,
      entryCandleOpenTime,
      galeCandleOpenTime: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return;
  }

  // ── M_FIXA: Aguarda vela de entrada fechar e processa resultado ───────────
  if (phase === 'M_FIXA') {
    const candles = await fetchCandlesAny(simData.currentPair, interval, 10);
    const entryCandle = candles.find((c: Candle) => c.openTime === simData.entryCandleOpenTime);

    if (!entryCandle) {
      console.log(`[SIM] M_FIXA aguardando vela ${new Date(simData.entryCandleOpenTime).toISOString()}`);
      return; // Vela ainda aberta — exibe M_FIXA na tela por mais 1 minuto
    }

    const direction: 'CALL' | 'PUT' = simData.currentDirection;
    const isGain = (direction === 'CALL' && entryCandle.color === 'GREEN') ||
                   (direction === 'PUT'  && entryCandle.color === 'RED');
    const profit = calcBetProfit(currentBet, isGain);
    const newBankroll = parseFloat((simData.bankroll + profit).toFixed(2));
    let nextBet = isGain ? Math.max(1, parseFloat((currentBet / 1.3).toFixed(2))) : parseFloat((currentBet * 1.3).toFixed(2));
    if (isGain && currentBet >= 50) nextBet = 10;
    const newMaxBet = Math.max(maxBet, currentBet, nextBet);

    const tradeEntry = {
      id: `${simData.lastCycleId}_MF`,
      pair: simData.currentPair,
      pattern: simData.currentPattern,
      direction,
      phase: 'Mão Fixa',
      openPrice: entryCandle.open,
      closePrice: entryCandle.close,
      result: isGain ? 'GAIN' : 'LOSS',
      profit,
      time: simData.entryCandleOpenTime,
      bankrollAfter: newBankroll
    };

    const updatedTrades = [...(simData.trades || []), tradeEntry].slice(-100);
    console.log(`[SIM] Mão Fixa | ${simData.currentPair} | ${direction} | O:${entryCandle.open} C:${entryCandle.close} | ${isGain ? 'GAIN' : 'LOSS'}`);

    if (isGain) {
      await simRef.set({
        phase: 'IDLE',
        bankroll: newBankroll,
        currentBet: nextBet,
        maxBet: newMaxBet,
        trades: updatedTrades,
        statusMessage: `GAIN em Mão Fixa! +$${profit.toFixed(2)}`,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } else {
      const gale1OpenTime = simData.entryCandleOpenTime + candleIntervalMs;
      const g1TimeStr = new Date(gale1OpenTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      await simRef.set({
        phase: 'GALE1',
        galeCandleOpenTime: gale1OpenTime,
        bankroll: newBankroll,
        currentBet: nextBet,
        maxBet: newMaxBet,
        trades: updatedTrades,
        statusMessage: `LOSS em Mão Fixa. Entrando GALE 1 (${g1TimeStr})`,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
    return;
  }

  // ── GALE 1: Aguarda vela fechar e processa ────────────────────────────────
  if (phase === 'GALE1') {
    const candles = await fetchCandlesAny(simData.currentPair, interval, 10);
    const galeCandle = candles.find((c: Candle) => c.openTime === simData.galeCandleOpenTime);

    if (!galeCandle) {
      console.log(`[SIM] GALE1 aguardando vela ${new Date(simData.galeCandleOpenTime).toISOString()}`);
      return;
    }

    const direction: 'CALL' | 'PUT' = simData.currentDirection;
    const isGain = (direction === 'CALL' && galeCandle.color === 'GREEN') ||
                   (direction === 'PUT'  && galeCandle.color === 'RED');
    const profit = calcBetProfit(currentBet, isGain);
    const newBankroll = parseFloat((simData.bankroll + profit).toFixed(2));
    let nextBet = isGain ? Math.max(1, parseFloat((currentBet / 1.3).toFixed(2))) : parseFloat((currentBet * 1.3).toFixed(2));
    if (isGain && currentBet >= 50) nextBet = 10;
    const newMaxBet = Math.max(maxBet, currentBet, nextBet);

    const tradeEntry = {
      id: `${simData.lastCycleId}_G1`,
      pair: simData.currentPair,
      pattern: simData.currentPattern,
      direction,
      phase: 'Gale 1',
      openPrice: galeCandle.open,
      closePrice: galeCandle.close,
      result: isGain ? 'GAIN' : 'LOSS',
      profit,
      time: simData.galeCandleOpenTime,
      bankrollAfter: newBankroll
    };

    const updatedTrades = [...(simData.trades || []), tradeEntry].slice(-100);
    console.log(`[SIM] Gale 1 | ${simData.currentPair} | ${direction} | ${isGain ? 'GAIN' : 'LOSS'}`);

    if (isGain) {
      await simRef.set({
        phase: 'IDLE',
        bankroll: newBankroll,
        currentBet: nextBet,
        maxBet: newMaxBet,
        trades: updatedTrades,
        statusMessage: `GAIN em Gale 1! +$${profit.toFixed(2)}`,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } else {
      const gale2OpenTime = simData.galeCandleOpenTime + candleIntervalMs;
      const g2TimeStr = new Date(gale2OpenTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      await simRef.set({
        phase: 'GALE2',
        galeCandleOpenTime: gale2OpenTime,
        bankroll: newBankroll,
        currentBet: nextBet,
        maxBet: newMaxBet,
        trades: updatedTrades,
        statusMessage: `LOSS em Gale 1. Entrando GALE 2 (${g2TimeStr})`,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
    return;
  }

  // ── GALE 2: Aguarda vela fechar e processa (último gale) ──────────────────
  if (phase === 'GALE2') {
    const candles = await fetchCandlesAny(simData.currentPair, interval, 10);
    const galeCandle = candles.find((c: Candle) => c.openTime === simData.galeCandleOpenTime);

    if (!galeCandle) {
      console.log(`[SIM] GALE2 aguardando vela ${new Date(simData.galeCandleOpenTime).toISOString()}`);
      return;
    }

    const direction: 'CALL' | 'PUT' = simData.currentDirection;
    const isGain = (direction === 'CALL' && galeCandle.color === 'GREEN') ||
                   (direction === 'PUT'  && galeCandle.color === 'RED');
    const profit = calcBetProfit(currentBet, isGain);
    const newBankroll = parseFloat((simData.bankroll + profit).toFixed(2));
    let nextBet = isGain ? Math.max(1, parseFloat((currentBet / 1.3).toFixed(2))) : parseFloat((currentBet * 1.3).toFixed(2));
    if (isGain && currentBet >= 50) nextBet = 10;
    const newMaxBet = Math.max(maxBet, currentBet, nextBet);

    const tradeEntry = {
      id: `${simData.lastCycleId}_G2`,
      pair: simData.currentPair,
      pattern: simData.currentPattern,
      direction,
      phase: 'Gale 2',
      openPrice: galeCandle.open,
      closePrice: galeCandle.close,
      result: isGain ? 'GAIN' : 'LOSS',
      profit,
      time: simData.galeCandleOpenTime,
      bankrollAfter: newBankroll
    };

    const updatedTrades = [...(simData.trades || []), tradeEntry].slice(-100);
    console.log(`[SIM] Gale 2 | ${simData.currentPair} | ${direction} | ${isGain ? 'GAIN' : 'LOSS'}`);

    const finalMsg = isGain ? `GAIN em Gale 2! +$${profit.toFixed(2)}` : `LOSS Final em Gale 2. -$${Math.abs(profit).toFixed(2)}`;
    await simRef.set({
      phase: 'IDLE',
      bankroll: newBankroll,
      currentBet: nextBet,
      maxBet: newMaxBet,
      trades: updatedTrades,
      statusMessage: finalMsg,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return;
  }
}

// ============================================================================
// FUNÇÃO PRINCIPAL — roda a cada 1 minuto
// ============================================================================
export const analyzeMarketAndSave = onSchedule({
  region: 'southamerica-east1',
  schedule: "every 1 minutes",
  timeoutSeconds: 300,
  memory: "1GiB"
}, async () => {
  console.log("Iniciando catalogação massiva via Binance...");

  // ============================================================
  // FASE 1: Catalogar todos os pares em paralelo
  // ============================================================
  const catalogingTasks: Promise<void>[] = [];

  for (const pair of PAIRS) {
    for (const tf of [1, 5]) {
      catalogingTasks.push((async () => {
        try {
          const interval = tf === 1 ? '1m' : '5m';
          const candles = await fetchCandles(pair, interval, 720);
          if (candles.length < 700) return;

          const currentStrategies = tf === 1 ? M1_STRATEGIES : M5_STRATEGIES;
          const isDead = isDeadChart(candles, tf === 1 ? 40 : 20, tf === 1 ? 8 : 15);

          if (isDead) {
            console.log(`[DEAD] ${pair} M${tf} - Baixa liquidez detectada.`);
          }

          const blocks = groupInBlocks(candles, 5);

          for (const strategy of currentStrategies) {
            const docId = `${pair}_${strategy.name.replace(/\s+/g, '').replace(/[()]/g, '')}_M${tf}`;

            try {
              if (isDead) {
                await db.collection("signals").doc(docId).set({
                  rawHistory: [],
                  isDead: true,
                  updatedAt: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
                continue;
              }

              const rawHistory = runCataloger(blocks, strategy.func, strategy.entryIndex);
              const filteredHistory = rawHistory.slice(-100);

              await db.collection("signals").doc(docId).set({
                id: docId,
                pair,
                pattern: strategy.name,
                timeframe: tf,
                rawHistory: filteredHistory,
                isDead: false,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
              });
            } catch (stratError) {
              console.error(`Erro na estratégia ${strategy.name} para ${pair} M${tf}:`, stratError);
            }
          }
        } catch (error) {
          console.error(`Erro ao processar ${pair} M${tf}:`, error);
        }
      })());
    }
  }

  await Promise.all(catalogingTasks);

  // ============================================================
  // FASE 2: Simulador — máquina de estado limpa (multi-fonte)
  // ============================================================
  try {
    const configSnap = await db.collection("stats").doc("config").get();
    const config = configSnap.exists ? configSnap.data()! : { preferredTimeframe: 5, dataSource: 'iqoption' };
    const prefTF = config.preferredTimeframe || 5;
    const dataSource: string = config.dataSource || 'iqoption';

    let allSignalsData: any[] = [];

    // Lê da coleção Binance se dataSource for 'binance' ou 'all'
    if (dataSource === 'binance' || dataSource === 'all') {
      const binanceSnap = await db.collection("signals")
        .where("timeframe", "==", prefTF)
        .get();
      allSignalsData = [...allSignalsData, ...binanceSnap.docs.map(d => d.data())];
    }

    // Lê da coleção IQ Option se dataSource for 'iqoption' ou 'all'
    if (dataSource === 'iqoption' || dataSource === 'all') {
      const iqSnap = await db.collection("signals_iq")
        .where("timeframe", "==", prefTF)
        .get();
      allSignalsData = [...allSignalsData, ...iqSnap.docs.map(d => d.data())];
    }

    // Lê da coleção Deriv se dataSource for 'deriv' ou 'all'
    if (dataSource === 'deriv' || dataSource === 'all') {
      const derivSnap = await db.collection("signals_deriv")
        .where("timeframe", "==", prefTF)
        .get();
      allSignalsData = [...allSignalsData, ...derivSnap.docs.map(d => d.data())];
    }

    if (allSignalsData.length === 0) {
      console.log(`[SIM] Nenhum sinal M${prefTF} disponível para dataSource='${dataSource}'.`);
      return;
    }

    await runSimulator(prefTF, allSignalsData);

  } catch (error) {
    console.error("Erro no Simulador Global:", error);
  }

  console.log("Catalogação finalizada.");
});
