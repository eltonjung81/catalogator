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
  analyzeMHI2,
  analyzeMHI3,
  analyzeMHIMaioria,
  analyzeTorresGemeas,
  analyzeTorresGemeasM1,
  analyzePadrao23,
  analyzePadrao23M1,
  analyzeM1Trend,
  isDeadChart,
  TradeResult
} from './cataloger';

const db = admin.firestore();

const PAIRS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'DOTUSDT'];

const M5_STRATEGIES = [
  { name: 'MHI 1',        func: analyzeMHI1,        entryIndex: 0 },
  { name: 'MHI 2',        func: analyzeMHI2,        entryIndex: 1 },
  { name: 'MHI 3',        func: analyzeMHI3,        entryIndex: 2 },
  { name: 'MHI Maioria',  func: analyzeMHIMaioria,  entryIndex: 0 },
  { name: 'Torres Gêmeas',func: analyzeTorresGemeas, entryIndex: 0 },
  { name: 'Padrão 23',    func: analyzePadrao23,     entryIndex: 0 }
];

const M1_STRATEGIES = [
  // Tendência pura: lê a última vela M1 livre (sem agrupamento necessário)
  { name: 'Tendência M1',   func: analyzeM1Trend,        entryIndex: 0 },
  // MHI opera sobre blocos de 5 velas M1 (janela de 5 minutos)
  // A mesma lógica de minoria/maioria do M5, aplicada na janela M1
  { name: 'MHI 1 (M1)',     func: analyzeMHI1,           entryIndex: 0 },
  { name: 'MHI 2 (M1)',     func: analyzeMHI2,           entryIndex: 1 },
  { name: 'MHI 3 (M1)',     func: analyzeMHI3,           entryIndex: 2 },
  { name: 'MHI Maioria M1', func: analyzeMHIMaioria,     entryIndex: 0 },
  // Padrão 23 M1: maioria entre a 2ª e 3ª vela do bloco de 5 M1
  { name: 'Padrão 23 M1',   func: analyzePadrao23M1,     entryIndex: 0 },
  // Torres Gêmeas M1: as 2 últimas velas do bloco devem ser da mesma cor
  { name: 'Torres Gêmeas M1', func: analyzeTorresGemeasM1, entryIndex: 0 },
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

  // IMPORTANTE: com payout 89% e escala 1-2-4, apenas WIN DIRETO dá lucro real.
  // WIN G1 = -$1.22 e WIN G2 = -$3.44 (prejuízo líquido apesar de "acertar").
  // Rotulamos corretamente para não enganar o simulador e o usuário.
  const labels = result === 0
    ? 'WIN DIRETO'
    : `WIN GALE ${result} (prejuízo líquido: $${Math.abs(netProfit).toFixed(2)})`;

  return { profit: netProfit, status: labels };
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
    // Janela de tendência: últimas 10 operações, peso simétrico (+1 win / -1 loss).
    // O peso assimétrico original (-2 loss) descartava boas estratégias por 1 loss recente.
    if (idx >= recent.length - 10) {
      trendScore += isWin ? 1 : -1;
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
        const interval = tf === 1 ? '1m' : '5m';
        const candles = await fetchCandles(pair, interval, 720);
        if (candles.length < 700) continue;

        const currentStrategies = tf === 1 ? M1_STRATEGIES : M5_STRATEGIES;
        const isDead = isDeadChart(candles);

        if (isDead) {
          console.log(`[DEAD] ${pair} - Limpando sinais por baixa liquidez.`);
        }

        // Ambos os timeframes usam blocos de 5 velas:
        //   M5 → blocos de 5 × 5min = 25 minutos (quadrante padrão)
        //   M1 → blocos de 5 × 1min = 5 minutos (janela de análise equivalente)
        const blocks = groupInBlocks(candles, 5);

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
    // ─── Lógica de Preferência de Timeframe ────────────────────────────────
    // Busca a configuração do usuário. Se não houver, padrão é M5.
    const configSnap = await db.collection("stats").doc("config").get();
    const config = configSnap.exists ? configSnap.data()! : { preferredTimeframe: 5 };
    const prefTF = config.preferredTimeframe || 5;

    // Busca todos os sinais do timeframe preferido
    const allPrefSignals = await db.collection("signals")
      .where("timeframe", "==", prefTF)
      .get();

    if (allPrefSignals.empty) {
      console.log(`Nenhum sinal M${prefTF} disponível.`);
      return;
    }

    const prefSignalsDataFull = allPrefSignals.docs.map(doc => doc.data());
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;

    const prefSignalsData = prefSignalsDataFull.filter(s => {
      const lastUpdate = s.updatedAt?.toMillis ? s.updatedAt.toMillis() : 0;
      return s.rawHistory && s.rawHistory.length > 0 && !s.isDead && lastUpdate > tenMinutesAgo;
    });

    const simRef = db.collection("stats").doc("global_simulator");

    if (prefSignalsData.length === 0) {
      console.log(`[INFO] Nenhum sinal M${prefTF} recente. Limpando monitor.`);
      await simRef.set({
        currentPair: null,
        currentPattern: null,
        currentDirection: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return;
    }

    const sorted = prefSignalsData.sort((a, b) => getScore(b.rawHistory) - getScore(a.rawHistory));
    const top1 = sorted[0];

    // Documento persistente do simulador
    const simSnap = await simRef.get();
    const simData = simSnap.exists
      ? simSnap.data()!
      : { bankroll: 5000, lastProcessedTime: 0, trades: [] };

    const lastProcessedTime: number = simData.lastProcessedTime ?? 0;

    // ─── Lógica de Travamento de Estratégia ────────────────────────────────
    // Se já existe uma operação em andamento (currentPair não é null),
    // verificamos se ela já terminou antes de tentar trocar de sinal.
    let activeSignal = top1;
    const isOngoing = simData.currentPair && simData.currentPattern;

    if (isOngoing) {
      // Tenta encontrar o sinal que já estava sendo operado para manter a consistência
      const existingSignal = prefSignalsDataFull.find(s =>
        s.pair === simData.currentPair && s.pattern === simData.currentPattern
      );

      if (existingSignal) {
        // O lock deve durar o tempo máximo de 3 velas (entrada + G1 + G2) no TF em uso.
        // 3 velas × intervalo do TF garante que todos os gales tenham completado.
        const candleDurationMs = prefTF * 60 * 1000;
        const galeLockDuration = 3 * candleDurationMs;
        const timeSinceStart = Date.now() - lastProcessedTime;

        if (timeSinceStart < galeLockDuration) {
          console.log(`[LOCK] Mantendo ${simData.currentPair} (${simData.currentPattern}) até o fim dos gales.`);
          activeSignal = existingSignal;
        }
      }
    }

    const lastEntry: TradeResult = activeSignal.rawHistory[activeSignal.rawHistory.length - 1];

    // Se o último trade do sinal ativo for muito antigo (mais de 1 hora), limpamos o status.
    if (Date.now() - lastEntry.time > 60 * 60 * 1000) {
      await simRef.set({
        currentPair: null,
        currentPattern: null,
        currentDirection: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return;
    }

    // ── Verificação de trade novo ──────────────────────────────────────────
    if (lastEntry.time > lastProcessedTime) {
      const { profit, status } = calcProfit(lastEntry.result);
      const prevBankroll: number = simData.bankroll ?? 5000;
      const newBankroll = parseFloat((prevBankroll + profit).toFixed(2));

      const newTrade = {
        id: `${activeSignal.pair}_${lastEntry.time}`,
        pair: activeSignal.pair,
        pattern: activeSignal.pattern,
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
        lastProcessedTime: lastEntry.time,
        currentPair: activeSignal.pair,
        currentPattern: activeSignal.pattern,
        currentDirection: lastEntry.direction,
        lastTradeId: newTrade.id,
        trades: updatedTrades,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      console.log(
        `[TRADE] ${activeSignal.pair} | ${activeSignal.pattern} | ${lastEntry.direction} | ${status} | ` +
        `${profit >= 0 ? '+' : ''}$${profit.toFixed(2)} | Banca: $${newBankroll}`
      );
    } else {
      // Nenhum trade novo — apenas atualiza o display se o Top 1 mudou e não estamos travados
      if (!isOngoing) {
        const changed =
          simData.currentPair !== activeSignal.pair ||
          simData.currentPattern !== activeSignal.pattern;

        if (changed) {
          await simRef.set({
            currentPair: activeSignal.pair,
            currentPattern: activeSignal.pattern,
            currentDirection: lastEntry.direction,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          console.log(`[INFO] Estratégia atualizada: ${activeSignal.pair} (${activeSignal.pattern})`);
        }
      }
    }

  } catch (error) {
    console.error("Erro no Simulador Global:", error);
  }

  console.log("Catalogação finalizada.");
});
