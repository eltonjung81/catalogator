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
  schedule: "every 5 minutes",
  timeoutSeconds: 300
}, async (event) => {
  console.log("Iniciando catalogação massiva via Binance...");

  for (const pair of PAIRS) {
    try {
      // 1. Busca as velas (12 horas = 720 minutos)
      const candles = await fetchCandles(pair, '1m', 720);
      
      if (candles.length < 700) continue; // Garante que tem dados suficientes

      // 2. Agrupa em blocos de 5 minutos
      const blocks = groupInBlocks(candles, 5);

      // 3. Simula todas as estratégias
      for (const strategy of STRATEGIES) {
        const rawHistory = runCataloger(blocks, strategy.func, strategy.entryIndex);
        
        // Filtra os momentos em que não houve entrada e mantém os números crus (0=Win, 1=G1, -1=Hit...)
        const filteredHistory = rawHistory.filter(r => r !== null) as number[];
        
        const docId = `${pair}_${strategy.name.replace(/\s+/g, '')}`;
        
        // 4. Salva no Firestore
        await db.collection("signals").doc(docId).set({
          pair: pair,
          pattern: strategy.name,
          rawHistory: filteredHistory, // O Frontend usará esse array para tudo!
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
      
    } catch (error) {
      console.error(`Erro ao processar ${pair}:`, error);
    }
  }

  console.log("Catalogação finalizada.");
});
