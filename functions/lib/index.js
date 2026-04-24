"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeMarketAndSave = void 0;
const functions = require("firebase-functions/v2");
const admin = require("firebase-admin");
const cataloger_1 = require("./cataloger");
admin.initializeApp();
const db = admin.firestore();
// Pares da Binance para simularmos os gráficos 24h
const PAIRS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
const STRATEGIES = [
    { name: 'MHI 1', func: cataloger_1.analyzeMHI1, entryIndex: 0 },
    { name: 'MHI Maioria', func: cataloger_1.analyzeMHIMaioria, entryIndex: 0 },
    { name: 'Torres Gêmeas', func: cataloger_1.analyzeTorresGemeas, entryIndex: 0 },
    { name: 'Padrão 23', func: cataloger_1.analyzePadrao23, entryIndex: 0 }
];
exports.analyzeMarketAndSave = functions.scheduler.onSchedule({
    region: 'southamerica-east1',
    schedule: "every 1 minutes",
    timeoutSeconds: 300
}, async (event) => {
    console.log("Iniciando catalogação massiva via Binance...");
    for (const pair of PAIRS) {
        for (const tf of [1, 5]) { // Processa M1 e M5
            try {
                const candles = await (0, cataloger_1.fetchCandles)(pair, '1m', 720);
                if (candles.length < 700)
                    continue;
                const blocks = (0, cataloger_1.groupInBlocks)(candles, tf);
                for (const strategy of STRATEGIES) {
                    const rawHistory = (0, cataloger_1.runCataloger)(blocks, strategy.func, strategy.entryIndex);
                    const filteredHistory = rawHistory.filter(r => r !== null);
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
            }
            catch (error) {
                console.error(`Erro ao processar ${pair} em M${tf}:`, error);
            }
        }
    }
    console.log("Catalogação finalizada.");
});
//# sourceMappingURL=index.js.map