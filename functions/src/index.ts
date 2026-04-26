// Robot Version 3.0 - Full Logic Overhaul
import * as admin from 'firebase-admin';
import { onSchedule } from "firebase-functions/v2/scheduler";

admin.initializeApp();

export { createPreference, mercadopagoWebhook } from './payments';
import { fetchCandles, groupInBlocks, runCataloger, analyzeMHI1, analyzeMHIMaioria, analyzeTorresGemeas, analyzePadrao23, analyzeM1Trend } from './cataloger';

const db = admin.firestore();

const PAIRS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'DOTUSDT'];

const M5_STRATEGIES = [
  { name: 'MHI 1', func: analyzeMHI1, entryIndex: 0 },
  { name: 'MHI Maioria', func: analyzeMHIMaioria, entryIndex: 0 },
  { name: 'Torres Gêmeas', func: analyzeTorresGemeas, entryIndex: 0 },
  { name: 'Padrão 23', func: analyzePadrao23, entryIndex: 0 }
];

const M1_STRATEGIES = [
  { name: 'Tendência M1', func: analyzeM1Trend, entryIndex: 0 }
];

/**
 * Calcula o lucro líquido de uma operação com Martingale.
 * Modelo de aposta: Mão Fixa=$1, G1=$2, G2=$4 (escala 1-2-4)
 * Payout da corretora: 89% sobre o valor apostado.
 *
 * result = 0  → WIN Direto: +$0.89 (apostou $1, recebeu $1.89, lucro=$0.89)
 * result = 1  → WIN G1: apostou $1+$2=$3, recebeu $2*1.89=$3.78, lucro=$0.78
 * result = 2  → WIN G2: apostou $1+$2+$4=$7, recebeu $4*1.89=$7.56, lucro=$0.56
 * result = -1 → HIT: perdeu tudo que apostou = -$7 (G2 coberto)
 */
/**
 * Calcula o lucro líquido de uma operação com Martingale.
 * IMPORTANTE: Com payout de 89% e escala 1-2-4, o lucro diminui nos Gales.
 * Se desejar recuperação total e lucro igual à Mão Fixa, use escala 1-2.2-4.8.
 */
const calcProfit = (result: number): { profit: number; status: string } => {
  if (result === 0) return { profit: 0.89, status: 'WIN DIRETO' };
  if (result === 1) return { profit: 0.78, status: 'WIN GALE 1' };
  if (result === 2) return { profit: 0.56, status: 'WIN GALE 2' };
  // Loss: perdeu as 3 apostas (1 + 2 + 4 = 7)
  return { profit: -7, status: 'LOSS' };
};

export const analyzeMarketAndSave = onSchedule({
  region: 'southamerica-east1',
  schedule: "every 1 minutes",
  timeoutSeconds: 300,
  memory: "512MiB"
}, async () => {
  console.log("Iniciando catalogação massiva via Binance...");

  // ============================================================
  // FASE 1: Catalogar todos os pares e salvar sinais
  // ============================================================
  for (const pair of PAIRS) {
    for (const tf of [1, 5]) {
      try {
        const candles = await fetchCandles(pair, '1m', 720);
        if (candles.length < 700) continue;

        const blocks = groupInBlocks(candles, tf);
        const currentStrategies = tf === 1 ? M1_STRATEGIES : M5_STRATEGIES;

        for (const strategy of currentStrategies) {
          const rawHistory = runCataloger(blocks, strategy.func, strategy.entryIndex);

          const filteredHistory = rawHistory.slice(-100);
          const docId = `${pair}_${strategy.name.replace(/\s+/g, '')}_M${tf}`;

          await db.collection("signals").doc(docId).set({
            id: docId,
            pair,
            pattern: strategy.name,
            timeframe: tf,
            rawHistory: filteredHistory,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
      } catch (error) {
        console.error(`Erro ao processar ${pair} M${tf}:`, error);
      }
    }
  }

  // ============================================================
  // FASE 2: Simulador Global Persistente (Top 1 de M5)
  // ============================================================
  try {
    const allM5Signals = await db.collection("signals")
      .where("timeframe", "==", 5)
      .get();

    const signalsData = allM5Signals.docs.map(doc => doc.data());

    // Mesma lógica de ranking do frontend: TrendScore + WinRate
    const getScore = (h: any[]): number => {
      if (!h || h.length === 0) return -9999;
      const recent100 = h.slice(-100);
      let wins = 0;
      let trendScore = 0;

      recent100.forEach((r, idx) => {
        const val = typeof r === 'number' ? r : (r?.result ?? -1);
        const isWin = val >= 0 && val <= 2; // 0=direto, 1=G1, 2=G2
        if (isWin) wins++;

        if (idx >= recent100.length - 10) {
          trendScore += isWin ? 1 : -2;
        }
      });

      const winRate = recent100.length > 0 ? wins / recent100.length : 0;
      return (trendScore * 10) + winRate * 100;
    };

    const sorted = signalsData
      .filter(s => s.rawHistory && s.rawHistory.length > 0)
      .sort((a, b) => getScore(b.rawHistory) - getScore(a.rawHistory));

    const top1 = sorted[0];

    if (!top1) {
      console.log("Nenhum sinal M5 disponível para o simulador.");
      return;
    }

    // Pega o último trade registrado pelo catalogador
    const lastEntry = top1.rawHistory[top1.rawHistory.length - 1];
    const lastResult: number = typeof lastEntry === 'number' ? lastEntry : (lastEntry?.result ?? -1);
    const lastTime: number = typeof lastEntry === 'number' ? 0 : (lastEntry?.time ?? 0);
    const lastDirection: string = typeof lastEntry === 'number' ? 'CALL' : (lastEntry?.direction ?? 'CALL');

    const simRef = db.collection("stats").doc("global_simulator");
    const simSnap = await simRef.get();
    const simData = simSnap.exists ? simSnap.data()! : { bankroll: 5000, lastTradeId: '', trades: [], lastProcessedTime: 0 };

    const currentTradeId = `${top1.id}_${lastTime > 0 ? lastTime : `len${top1.rawHistory.length}`}`;
    const lastProcessedTime = simData.lastProcessedTime || 0;

    const minute = new Date().getMinutes();
    const cyclePhase = minute % 5;
    // Fases de transição/espera: minutos 3 e 4
    const isIdlePhase = cyclePhase >= 3;

    // Se temos um novo trade que concluiu AGORA (ou seja, seu tempo é maior que o do último trade processado)
    if (lastTime > lastProcessedTime) {
      const { profit, status } = calcProfit(lastResult);
      const prevBankroll = simData.bankroll ?? 5000;
      const newBankroll = prevBankroll + profit;

      const newTrade = {
        id: currentTradeId,
        pair: top1.pair,
        pattern: top1.pattern,
        direction: lastDirection,
        result: lastResult,
        profit: parseFloat(profit.toFixed(2)),
        status,
        time: lastTime > 0 ? lastTime : Date.now()
      };

      const currentTrades: any[] = simData.trades || [];
      const updatedTrades = [...currentTrades, newTrade].slice(-50); // mantém últimos 50

      await simRef.set({
        bankroll: parseFloat(newBankroll.toFixed(2)),
        lastTradeId: currentTradeId,
        lastProcessedTime: lastTime, // TRAVA O CICLO PARA EVITAR DUPLICATAS
        lastPair: top1.id,
        currentPair: top1.pair,
        currentPattern: top1.pattern,
        currentDirection: lastDirection,
        trades: updatedTrades,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      console.log(`Trade registrado: ${top1.pair} | ${status} | ${profit >= 0 ? '+' : ''}${profit.toFixed(2)} | Banca: $${newBankroll.toFixed(2)}`);
      return;
    }

    // Se NÃO é um trade novo, só atualizamos a UI (pair/pattern) se estivermos na fase IDLE/ENTRY
    // Isso impede que a estratégia mude no meio do trade (minutos 0, 1 e 2) causando flip-flop
    if (isIdlePhase) {
      if (simData.currentPair !== top1.pair || simData.currentPattern !== top1.pattern) {
        await simRef.set({
          currentPair: top1.pair,
          currentPattern: top1.pattern,
          currentDirection: lastDirection,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        console.log(`Estratégia atualizada para o próximo ciclo: ${top1.pair} (${top1.pattern})`);
      }
    }

  } catch (error) {
    console.error("Erro no Simulador Global:", error);
  }

  console.log("Catalogação finalizada.");
});
