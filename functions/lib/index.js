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
const M5_STRATEGIES = [
    { name: 'MHI 1', func: cataloger_1.analyzeMHI1, entryIndex: 0 },
    { name: 'MHI Maioria', func: cataloger_1.analyzeMHIMaioria, entryIndex: 0 },
    { name: 'Torres Gêmeas', func: cataloger_1.analyzeTorresGemeas, entryIndex: 0 },
    { name: 'Padrão 23', func: cataloger_1.analyzePadrao23, entryIndex: 0 }
];
const M1_STRATEGIES = [
    { name: 'Tendência M1', func: cataloger_1.analyzeM1Trend, entryIndex: 0 },
    { name: 'MHI 1 (M1)', func: cataloger_1.analyzeMHI1, entryIndex: 0 } // MHI também pode ser testado em blocos de 1m se adaptado, mas aqui usaremos a tendência
];
exports.analyzeMarketAndSave = functions.scheduler.onSchedule({
    region: 'southamerica-east1',
    schedule: "every 1 minutes",
    timeoutSeconds: 300
}, async (event) => {
    console.log("Iniciando catalogação massiva via Binance...");
    for (const pair of PAIRS) {
        for (const tf of [1, 5]) {
            try {
                const candles = await (0, cataloger_1.fetchCandles)(pair, '1m', 720);
                if (candles.length < 700)
                    continue;
                const blocks = (0, cataloger_1.groupInBlocks)(candles, tf);
                const currentStrategies = tf === 1 ? M1_STRATEGIES : M5_STRATEGIES;
                for (const strategy of currentStrategies) {
                    const rawHistory = (0, cataloger_1.runCataloger)(blocks, strategy.func, strategy.entryIndex);
                    const filteredHistory = rawHistory.filter(r => r !== null);
                    // O ID agora inclui o Timeframe (ex: BTCUSDT_MHI1_M5)
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
            }
            catch (error) {
                console.error(`Erro ao processar ${pair} M${tf}:`, error);
            }
        }
    }
    // Lógica do Simulador Global Persistente (Apenas para M5 Top 1)
    try {
        const allM5Signals = await db.collection("signals")
            .where("timeframe", "==", 5)
            .get();
        const signalsData = allM5Signals.docs.map(doc => doc.data());
        // Mesma lógica de ordenação do frontend
        const sorted = signalsData.sort((a, b) => {
            const getScore = (h) => {
                const rec = h.slice(-100);
                const wins = rec.filter(r => r >= 0 && r <= 2).length;
                const trend = h.slice(-10).reduce((acc, curr) => acc + (curr >= 0 ? 1 : -2), 0);
                return wins + (trend * 10); // Prioriza tendência
            };
            return getScore(b.rawHistory) - getScore(a.rawHistory);
        });
        const top1 = sorted[0];
        if (top1 && top1.rawHistory && top1.rawHistory.length > 0) {
            const lastResult = top1.rawHistory[top1.rawHistory.length - 1];
            const simRef = db.collection("stats").doc("global_simulator");
            const simSnap = await simRef.get();
            const simData = simSnap.exists ? simSnap.data() : { bankroll: 5000, lastTradeId: '' };
            // Se for um novo resultado para esse par
            const currentTradeId = `${top1.id}_${top1.rawHistory.length}`;
            if ((simData === null || simData === void 0 ? void 0 : simData.lastTradeId) !== currentTradeId) {
                let profit = 0;
                let status = '';
                if (lastResult === 0) {
                    profit = 0.89;
                    status = 'WIN DIRETO';
                }
                else if (lastResult === 1) {
                    profit = 0.78;
                    status = 'WIN GALE 1';
                }
                else if (lastResult === 2) {
                    profit = 0.56;
                    status = 'WIN GALE 2';
                }
                else if (lastResult === -1 || lastResult > 2) {
                    profit = -7;
                    status = 'LOSS (HIT)';
                }
                if (lastResult !== null) {
                    const newBankroll = ((simData === null || simData === void 0 ? void 0 : simData.bankroll) || 5000) + profit;
                    const newTrade = {
                        pair: top1.pair,
                        profit,
                        status,
                        time: new Date().toISOString(),
                        id: currentTradeId
                    };
                    await simRef.set({
                        bankroll: newBankroll,
                        lastTradeId: currentTradeId,
                        trades: admin.firestore.FieldValue.arrayUnion(newTrade),
                        updatedAt: admin.firestore.FieldValue.serverTimestamp()
                    }, { merge: true });
                }
            }
        }
    }
    catch (error) {
        console.error("Erro no Simulador Global:", error);
    }
    console.log("Catalogação finalizada.");
    return null;
});
//# sourceMappingURL=index.js.map