import * as admin from 'firebase-admin';
import { onSchedule } from "firebase-functions/v2/scheduler";
import { fetchCandles, groupInBlocks, runCataloger, analyzeMHI1, analyzeMHIMaioria, analyzeTorresGemeas, analyzePadrao23, analyzeM1Trend } from './cataloger';

admin.initializeApp();
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

export const analyzeMarketAndSave = onSchedule({
  region: 'southamerica-east1',
  schedule: "every 1 minutes",
  timeoutSeconds: 300,
  memory: "512MiB"
}, async () => {
  console.log("Iniciando catalogação massiva via Binance...");

  for (const pair of PAIRS) {
    for (const tf of [1, 5]) { 
      try {
        const candles = await fetchCandles(pair, '1m', 720);
        if (candles.length < 700) continue;

        const blocks = groupInBlocks(candles, tf);
        const currentStrategies = tf === 1 ? M1_STRATEGIES : M5_STRATEGIES;

        for (const strategy of currentStrategies) {
          const rawHistory = runCataloger(blocks, strategy.func, strategy.entryIndex);
          
          // Filtra o histórico para os últimos 100 resultados
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

  // Lógica do Simulador Global Persistente (M5 Top 1)
  try {
    const allM5Signals = await db.collection("signals")
      .where("timeframe", "==", 5)
      .get();
    
    const signalsData = allM5Signals.docs.map(doc => doc.data());
    
    const sorted = signalsData.sort((a, b) => {
      const getScore = (h: number[]) => {
        const rec = h.slice(-100);
        const wins = rec.filter(r => r >= 0 && r <= 2).length;
        const trend = h.slice(-10).reduce((acc, curr) => acc + (curr >= 0 ? 1 : -2), 0);
        return wins + (trend * 10);
      };
      return getScore(b.rawHistory) - getScore(a.rawHistory);
    });

    const top1 = sorted[0];
    if (top1 && top1.rawHistory && top1.rawHistory.length > 0) {
      const lastResult = top1.rawHistory[top1.rawHistory.length - 1];
      const simRef = db.collection("stats").doc("global_simulator");
      const simSnap = await simRef.get();
      const simData = simSnap.exists ? simSnap.data() : { bankroll: 5000, lastTradeId: '' };

      const currentTradeId = `${top1.id}_${top1.rawHistory.length}`;
      if (simData?.lastTradeId !== currentTradeId) {
        let profit = 0;
        let status = '';
        if (lastResult === 0) { profit = 0.89; status = 'WIN DIRETO'; }
        else if (lastResult === 1) { profit = 0.78; status = 'WIN GALE 1'; }
        else if (lastResult === 2) { profit = 0.56; status = 'WIN GALE 2'; }
        else if (lastResult === -1 || lastResult > 2) { profit = -7; status = 'LOSS (HIT)'; }

        if (lastResult !== null) {
          const newBankroll = (simData?.bankroll || 5000) + profit;
          const currentTrades = simData?.trades || [];
          const newTrade = {
            pair: top1.pair,
            profit,
            status: lastResult >= 0 && lastResult <= 2 ? 'GAIN' : 'HIT',
            time: new Date().toISOString(),
            id: currentTradeId
          };

          // Mantém apenas os últimos 49 para adicionar o novo e totalizar 50
          const updatedTrades = [...currentTrades.slice(-49), newTrade];

          await simRef.set({
            bankroll: newBankroll,
            lastTradeId: currentTradeId,
            currentPair: top1.pair,
            currentPattern: top1.pattern,
            currentDirection: Math.random() > 0.5 ? 'COMPRADO' : 'VENDIDO',
            trades: updatedTrades,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        }
      }
    }
  } catch (error) {
    console.error("Erro no Simulador Global:", error);
  }

  console.log("Catalogação finalizada.");
});
