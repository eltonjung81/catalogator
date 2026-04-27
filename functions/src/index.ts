// Robot Version 4.0 — Clean State Machine Simulator
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

const PAIRS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'DOTUSDT'];

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
const BET_SEQUENCE = [1, 2, 4]; // MF, G1, G2

const calcBetProfit = (betIndex: number, isGain: boolean): number => {
  const bet = BET_SEQUENCE[betIndex];
  if (isGain) return parseFloat((bet * PAYOUT).toFixed(2));
  return -bet;
};

// ============================================================================
// SCORE DE RANKING — TrendScore (últimas 10) + WinRate (últimas 100)
// ============================================================================
const getScore = (history: TradeResult[]): number => {
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
  return (trendScore * 10) + winRate * 100;
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

async function runSimulator(prefTF: number, allSignalsData: any[]) {
  const simRef = db.collection("stats").doc("global_simulator");
  const simSnap = await simRef.get();
  const simData = simSnap.exists
    ? simSnap.data()!
    : { phase: 'IDLE', bankroll: 5000, trades: [], lastCycleId: null };

  const phase: string = simData.phase || 'IDLE';
  const interval = prefTF === 1 ? '1m' : '5m';
  const candleIntervalMs = prefTF * 60 * 1000;

  // ── IDLE: Procura novo sinal ──────────────────────────────────────────────
  if (phase === 'IDLE') {

    // Seleciona o Top 1 pelo score
    const liveSignals = allSignalsData.filter(s =>
      s.rawHistory && s.rawHistory.length > 0 && !s.isDead
    );
    if (liveSignals.length === 0) {
      console.log('[SIM] Nenhum sinal ativo disponível.');
      return;
    }
    const sorted = liveSignals.sort((a, b) => getScore(b.rawHistory) - getScore(a.rawHistory));
    const top1 = sorted[0];

    // Busca estratégia correspondente
    const strategies = prefTF === 1 ? M1_STRATEGIES : M5_STRATEGIES;
    const strategy = strategies.find(s => s.name === top1.pattern);
    if (!strategy) {
      console.log(`[SIM] Estratégia "${top1.pattern}" não encontrada.`);
      return;
    }

    // Busca velas frescas
    const candles = await fetchCandles(top1.pair, interval, 30);
    if (candles.length < 6) return;

    // Agrupa em blocos de 5 — usa APENAS blocos completos para análise
    const blocks = groupInBlocks(candles, 5);
    const completeBlocks = blocks.filter(b => b.length === 5);
    if (completeBlocks.length === 0) {
      console.log('[SIM] Nenhum bloco completo ainda.');
      return;
    }

    // Bloco mais recente e completo → é o bloco de análise (como faz o operador manual)
    const analysisBlock = completeBlocks[completeBlocks.length - 1];

    // Corre a função da estratégia EXATAMENTE como o catalogador faz
    const signal = strategy.func(analysisBlock);
    if (!signal) {
      console.log(`[SIM] Sem sinal para ${top1.pair} com ${top1.pattern}.`);
      return;
    }

    const direction: 'CALL' | 'PUT' = signal === 'GREEN' ? 'CALL' : 'PUT';

    // A vela de entrada é a primeira vela APÓS o bloco de análise
    // = a vela com openTime = último openTime do bloco + 1 intervalo
    const lastBlockCandle = analysisBlock[analysisBlock.length - 1];
    const entryCandleOpenTime = lastBlockCandle.openTime + candleIntervalMs + (strategy.entryIndex * candleIntervalMs);

    // Verifica se essa vela já fechou (deve estar no array de candles)
    const entryCandle = candles.find(c => c.openTime === entryCandleOpenTime);
    if (!entryCandle) {
      console.log(`[SIM] Vela de entrada ${new Date(entryCandleOpenTime).toISOString()} ainda não fechou.`);
      // Apenas registra que estamos aguardando esta vela (display para o usuário)
      const changed = simData.currentPair !== top1.pair || simData.currentPattern !== top1.pattern;
      if (changed) {
        await simRef.set({
          currentPair: top1.pair,
          currentPattern: top1.pattern,
          currentDirection: direction,
          phase: 'IDLE',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }
      return;
    }

    // Checa se já processamos esse ciclo (evita duplicação)
    const cycleId = `${top1.pair}_${entryCandleOpenTime}`;
    if (simData.lastCycleId === cycleId) {
      console.log(`[SIM] Ciclo ${cycleId} já processado.`);
      return;
    }

    // Determina o resultado da Mão Fixa
    const isGain = (direction === 'CALL' && entryCandle.color === 'GREEN') ||
                   (direction === 'PUT'  && entryCandle.color === 'RED');
    const profit = calcBetProfit(0, isGain);
    const newBankroll = parseFloat((simData.bankroll + profit).toFixed(2));

    const tradeEntry = {
      id: `${cycleId}_MF`,
      pair: top1.pair,
      pattern: top1.pattern,
      direction,
      phase: 'Mão Fixa',
      openPrice: entryCandle.open,
      closePrice: entryCandle.close,
      result: isGain ? 'GAIN' : 'LOSS',
      profit,
      time: entryCandleOpenTime,
      bankrollAfter: newBankroll
    };

    const updatedTrades = [...(simData.trades || []), tradeEntry].slice(-100);

    console.log(`[SIM] Mão Fixa | ${top1.pair} | ${direction} | O:${entryCandle.open} C:${entryCandle.close} | ${isGain ? 'GAIN' : 'LOSS'} | ${profit >= 0 ? '+' : ''}$${profit}`);

    if (isGain) {
      await simRef.set({
        phase: 'IDLE',
        lastCycleId: cycleId,
        currentPair: top1.pair,
        currentPattern: top1.pattern,
        currentDirection: direction,
        bankroll: newBankroll,
        trades: updatedTrades,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } else {
      // Gale 1: próxima vela
      const gale1OpenTime = entryCandleOpenTime + candleIntervalMs;
      await simRef.set({
        phase: 'GALE1',
        lastCycleId: cycleId,
        currentPair: top1.pair,
        currentPattern: top1.pattern,
        currentDirection: direction,
        galeCandleOpenTime: gale1OpenTime,
        bankroll: newBankroll,
        trades: updatedTrades,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
    return;
  }

  // ── GALE 1 ────────────────────────────────────────────────────────────────
  if (phase === 'GALE1') {
    const candles = await fetchCandles(simData.currentPair, interval, 10);
    const galeCandle = candles.find((c: Candle) => c.openTime === simData.galeCandleOpenTime);

    if (!galeCandle) {
      console.log(`[SIM] Gale 1 aguardando vela ${new Date(simData.galeCandleOpenTime).toISOString()}`);
      return;
    }

    const direction: 'CALL' | 'PUT' = simData.currentDirection;
    const isGain = (direction === 'CALL' && galeCandle.color === 'GREEN') ||
                   (direction === 'PUT'  && galeCandle.color === 'RED');
    const profit = calcBetProfit(1, isGain);
    const newBankroll = parseFloat((simData.bankroll + profit).toFixed(2));

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

    console.log(`[SIM] Gale 1 | ${simData.currentPair} | ${direction} | O:${galeCandle.open} C:${galeCandle.close} | ${isGain ? 'GAIN' : 'LOSS'} | ${profit >= 0 ? '+' : ''}$${profit}`);

    if (isGain) {
      await simRef.set({
        phase: 'IDLE',
        bankroll: newBankroll,
        trades: updatedTrades,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } else {
      const gale2OpenTime = simData.galeCandleOpenTime + candleIntervalMs;
      await simRef.set({
        phase: 'GALE2',
        galeCandleOpenTime: gale2OpenTime,
        bankroll: newBankroll,
        trades: updatedTrades,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
    return;
  }

  // ── GALE 2 ────────────────────────────────────────────────────────────────
  if (phase === 'GALE2') {
    const candles = await fetchCandles(simData.currentPair, interval, 10);
    const galeCandle = candles.find((c: Candle) => c.openTime === simData.galeCandleOpenTime);

    if (!galeCandle) {
      console.log(`[SIM] Gale 2 aguardando vela ${new Date(simData.galeCandleOpenTime).toISOString()}`);
      return;
    }

    const direction: 'CALL' | 'PUT' = simData.currentDirection;
    const isGain = (direction === 'CALL' && galeCandle.color === 'GREEN') ||
                   (direction === 'PUT'  && galeCandle.color === 'RED');
    const profit = calcBetProfit(2, isGain);
    const newBankroll = parseFloat((simData.bankroll + profit).toFixed(2));

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

    console.log(`[SIM] Gale 2 | ${simData.currentPair} | ${direction} | O:${galeCandle.open} C:${galeCandle.close} | ${isGain ? 'GAIN' : 'LOSS'} | ${profit >= 0 ? '+' : ''}$${profit}`);

    // Após Gale 2 sempre volta a IDLE (máximo de 2 gales)
    await simRef.set({
      phase: 'IDLE',
      bankroll: newBankroll,
      trades: updatedTrades,
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
  memory: "512MiB"
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
  // FASE 2: Simulador — máquina de estado limpa
  // ============================================================
  try {
    const configSnap = await db.collection("stats").doc("config").get();
    const config = configSnap.exists ? configSnap.data()! : { preferredTimeframe: 5 };
    const prefTF = config.preferredTimeframe || 5;

    const allSignalsSnap = await db.collection("signals")
      .where("timeframe", "==", prefTF)
      .get();

    if (allSignalsSnap.empty) {
      console.log(`[SIM] Nenhum sinal M${prefTF} disponível.`);
      return;
    }

    const allSignalsData = allSignalsSnap.docs.map(doc => doc.data());
    await runSimulator(prefTF, allSignalsData);

  } catch (error) {
    console.error("Erro no Simulador Global:", error);
  }

  console.log("Catalogação finalizada.");
});
