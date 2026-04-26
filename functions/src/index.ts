// Robot Version 3.0 - Full Logic Overhaul
import * as admin from 'firebase-admin';
import { onSchedule } from "firebase-functions/v2/scheduler";

admin.initializeApp();

export { createPreference, mercadopagoWebhook } from './payments';
import {
  fetchCandles,
  groupInBlocks,
  runCataloger,
  analyzeMHI1,
  analyzeMHIMaioria,
  analyzeTorresGemeas,
  analyzePadrao23,
  analyzeM1Trend,
  isDeadChart,
  TradeResult
} from './cataloger';

const db = admin.firestore();

const PAIRS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'DOTUSDT'];

const M5_STRATEGIES = [
  { name: 'MHI 1',        func: analyzeMHI1,        entryIndex: 0 },
  { name: 'MHI Maioria',  func: analyzeMHIMaioria,  entryIndex: 0 },
  { name: 'Torres Gêmeas',func: analyzeTorresGemeas, entryIndex: 0 },
  { name: 'Padrão 23',    func: analyzePadrao23,     entryIndex: 0 }
];

const M1_STRATEGIES = [
  { name: 'Tendência M1', func: analyzeM1Trend, entryIndex: 0 }
];

// ============================================================================
// MODELO DE LUCRO — Mão Fixa com 2 Gales, escala 1-2-4, payout 89%
//
//  WIN direto  → apostou $1,      ganhou $1×0.89  = +$0.89
//  WIN G1      → apostou $1+$2=$3, ganhou $2×0.89 = $1.78, lucro = $1.78-$3 = -$1.22  ← ATENÇÃO: ainda é loss líquido!
//                Obs: com payout de 89%, G1 e G2 NÃO recuperam 100% da perda anterior.
//                Ajuste os valores de aposta se quiser recuperação total.
//  WIN G2      → apostou $1+$2+$4=$7, ganhou $4×0.89=$3.56, lucro=$3.56-$7 = -$3.44
//  LOSS        → perdeu $1+$2+$4 = -$7.00
//
// NOTA: Com payout de 89% é impossível recuperar completamente com Martingale 1-2-4.
// Para recuperação total você precisaria de escala ~1-3-9 (cobrindo perdas + payout).
// Mantemos 1-2-4 como estava no código original para não alterar a lógica de negócio.
// ============================================================================
const PAYOUT = 0.89;
const BET_SEQUENCE = [1, 2, 4]; // entrada, G1, G2

const calcProfit = (result: 0 | 1 | 2 | -1): { profit: number; status: string } => {
  if (result === -1) {
    const totalBet = BET_SEQUENCE.reduce((a, b) => a + b, 0); // 7
    return { profit: -totalBet, status: 'LOSS' };
  }

  // Soma de tudo que foi apostado até essa tentativa
  const totalSpent = BET_SEQUENCE.slice(0, result + 1).reduce((a, b) => a + b, 0);
  // Ganho bruto da aposta vencedora
  const winBet = BET_SEQUENCE[result];
  const grossWin = winBet * (1 + PAYOUT);
  const netProfit = parseFloat((grossWin - totalSpent).toFixed(2));

  const labels = ['WIN DIRETO', 'WIN GALE 1', 'WIN GALE 2'];
  return { profit: netProfit, status: labels[result] };
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
    const isWin = r.result >= 0; // 0, 1 ou 2 = vitória
    if (isWin) wins++;
    if (idx >= recent.length - 10) {
      trendScore += isWin ? 1 : -2;
    }
  });

  const winRate = wins / recent.length;
  return (trendScore * 10) + winRate * 100;
};

export const analyzeMarketAndSave = onSchedule({
  region: 'southamerica-east1',
  schedule: "every 1 minutes",
  timeoutSeconds: 300,
  memory: "512MiB"
}, async () => {
  console.log("Iniciando catalogação massiva via Binance...");

  // ============================================================
  // FASE 1: Catalogar todos os pares e salvar sinais no Firestore
  // ============================================================
  for (const pair of PAIRS) {
    for (const tf of [1, 5]) {
      try {
        const candles = await fetchCandles(pair, '1m', 720);
        if (candles.length < 700) continue;

        const currentStrategies = tf === 1 ? M1_STRATEGIES : M5_STRATEGIES;
        const isDead = isDeadChart(candles);

        if (isDead) {
          console.log(`[DEAD] ${pair} - Limpando sinais por baixa liquidez.`);
        }

        const blocks = groupInBlocks(candles, tf);

        for (const strategy of currentStrategies) {
          const docId = `${pair}_${strategy.name.replace(/\s+/g, '')}_M${tf}`;

          if (isDead) {
            // Se o gráfico está morto, limpamos o histórico para ele sair do ranking
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
        }
      } catch (error) {
        console.error(`Erro ao processar ${pair} M${tf}:`, error);
      }
    }
  }

  // ============================================================
  // FASE 2: Simulador Global Persistente (Top 1 de M5)
  //
  // Lógica correta:
  //   1. Pega o sinal M5 com maior score
  //   2. Compara o ÚLTIMO trade do histórico com o que já foi registrado
  //   3. Se for um trade NOVO (openTime maior que o lastProcessedTime), registra
  //   4. Nunca duplica: a trava é o openTime da vela de entrada do trade
  // ============================================================
  try {
    const allM5Signals = await db.collection("signals")
      .where("timeframe", "==", 5)
      .get();

    if (allM5Signals.empty) {
      console.log("Nenhum sinal M5 disponível.");
      return;
    }

    const signalsData = allM5Signals.docs.map(doc => doc.data());
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;

    const sorted = signalsData
      .filter(s => {
        // Só considera sinais que:
        // 1. Tenham histórico
        // 2. Não estejam marcados como mortos
        // 3. Tenham sido atualizados nos últimos 10 minutos
        const lastUpdate = s.updatedAt?.toMillis ? s.updatedAt.toMillis() : 0;
        return s.rawHistory && s.rawHistory.length > 0 && !s.isDead && lastUpdate > tenMinutesAgo;
      })
      .sort((a, b) => getScore(b.rawHistory) - getScore(a.rawHistory));

    const top1 = sorted[0];
    if (!top1) {
      console.log("Nenhum sinal M5 com histórico disponível.");
      return;
    }

    // Último trade catalogado pelo runCataloger
    const lastEntry: TradeResult = top1.rawHistory[top1.rawHistory.length - 1];

    // Documento persistente do simulador
    const simRef = db.collection("stats").doc("global_simulator");
    const simSnap = await simRef.get();
    const simData = simSnap.exists
      ? simSnap.data()!
      : { bankroll: 5000, lastProcessedTime: 0, trades: [] };

    const lastProcessedTime: number = simData.lastProcessedTime ?? 0;

    // ── Verificação de trade novo ──────────────────────────────────────────
    // `lastEntry.time` é o openTime da vela de entrada.
    // Só processamos se esse timestamp ainda não foi processado.
    if (lastEntry.time > lastProcessedTime) {
      const { profit, status } = calcProfit(lastEntry.result);
      const prevBankroll: number = simData.bankroll ?? 5000;
      const newBankroll = parseFloat((prevBankroll + profit).toFixed(2));

      const newTrade = {
        id: `${top1.id}_${lastEntry.time}`,
        pair: top1.pair,
        pattern: top1.pattern,
        direction: lastEntry.direction,
        result: lastEntry.result,
        profit,
        status,
        time: lastEntry.time,
        bankrollAfter: newBankroll
      };

      const currentTrades: any[] = simData.trades ?? [];
      const updatedTrades = [...currentTrades, newTrade].slice(-50);

      await simRef.set({
        bankroll: newBankroll,
        lastProcessedTime: lastEntry.time,  // ← trava para evitar duplicatas
        currentPair: top1.pair,
        currentPattern: top1.pattern,
        currentDirection: lastEntry.direction,
        trades: updatedTrades,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      console.log(
        `[TRADE] ${top1.pair} | ${top1.pattern} | ${lastEntry.direction} | ${status} | ` +
        `${profit >= 0 ? '+' : ''}$${profit.toFixed(2)} | Banca: $${newBankroll}`
      );
    } else {
      // Nenhum trade novo — apenas atualiza o display se o Top 1 mudou
      const changed =
        simData.currentPair !== top1.pair ||
        simData.currentPattern !== top1.pattern;

      if (changed) {
        await simRef.set({
          currentPair: top1.pair,
          currentPattern: top1.pattern,
          currentDirection: lastEntry.direction,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        console.log(`[INFO] Estratégia atualizada: ${top1.pair} (${top1.pattern})`);
      } else {
        console.log(`[INFO] Sem trade novo. Aguardando próximo ciclo M5.`);
      }
    }

  } catch (error) {
    console.error("Erro no Simulador Global:", error);
  }

  console.log("Catalogação finalizada.");
});
