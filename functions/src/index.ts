import * as functions from 'firebase-functions/v2';
import * as admin from 'firebase-admin';
import { fetchCandles, groupInBlocks, runCataloger, analyzeMHI1, analyzeMHIMaioria, analyzeTorresGemeas, analyzePadrao23 } from './cataloger';

admin.initializeApp();
const db = admin.firestore();

// Pares da Binance para simularmos os gráficos 24h
const PAIRS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];

const STRATEGIES = [
  { name: 'MHI 1', func: analyzeMHI1, entryIndex: 0 },
  { name: 'MHI Maioria', func: analyzeMHIMaioria, entryIndex: 0 },
  { name: 'Torres Gêmeas', func: analyzeTorresGemeas, entryIndex: 0 },
  { name: 'Padrão 23', func: analyzePadrao23, entryIndex: 0 }
];

export const analyzeMarketAndSave = functions.scheduler.onSchedule({
  region: 'southamerica-east1',
  schedule: "every 1 minutes",
  timeoutSeconds: 300
}, async (event) => {
  console.log("Iniciando catalogação massiva via Binance...");

  for (const pair of PAIRS) {
    for (const tf of [1, 5]) { // Processa M1 e M5
      try {
        const candles = await fetchCandles(pair, '1m', 720);
        if (candles.length < 700) continue;

        const blocks = groupInBlocks(candles, tf);

        for (const strategy of STRATEGIES) {
          const rawHistory = runCataloger(blocks, strategy.func, strategy.entryIndex);
          const filteredHistory = rawHistory.filter(r => r !== null) as number[];
          
          // O ID agora inclui o Timeframe (ex: BTCUSDT_MHI1_M5)
          const docId = `${pair}_${strategy.name.replace(/\s+/g, '')}_M${tf}`;
          
          await db.collection("signals").doc(docId).set({
            pair: pair,
            pattern: strategy.name,
            timeframe: tf, // Salva se é 1 ou 5
            rawHistory: filteredHistory,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
      } catch (error) {
        console.error(`Erro ao processar ${pair} em M${tf}:`, error);
      }
    }
  }

  console.log("Catalogação finalizada.");
});
