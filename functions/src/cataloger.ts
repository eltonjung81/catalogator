import axios from 'axios';

// Tipagem básica de um Candle
export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  color: 'GREEN' | 'RED' | 'DOJI';
}

// Retorna as últimas N velas de M1 de um par da Binance
export const fetchCandles = async (symbol: string, interval: string = '1m', limit: number = 720): Promise<Candle[]> => {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const response = await axios.get(url);

    const now = Date.now();
    const buffer = 2000; // 2 segundos de buffer para garantir que a vela fechou na API
    return response.data
      .filter((data: any[]) => (now - buffer) > data[6])
      .map((data: any[]) => {
        const open = parseFloat(data[1]);
        const close = parseFloat(data[4]);
        let color: 'GREEN' | 'RED' | 'DOJI' = 'DOJI';
        if (close > open) color = 'GREEN';
        if (close < open) color = 'RED';

        return {
          openTime: data[0],
          open,
          high: parseFloat(data[2]),
          low: parseFloat(data[3]),
          close,
          color
        };
      });
  } catch (error) {
    console.error(`Erro ao buscar candles para ${symbol}:`, error);
    return [];
  }
};

// Achata todos os blocos em uma lista plana de velas com índice global
// Isso facilita buscar a vela N posições à frente de qualquer ponto
const flattenBlocks = (blocks: Candle[][]): Candle[] => {
  return blocks.reduce((acc, block) => acc.concat(block), []);
};

// Dado um array plano de velas e um openTime de referência,
// retorna o índice dessa vela no array plano (ou -1 se não encontrar)
const findCandleIndex = (flat: Candle[], openTime: number): number => {
  return flat.findIndex(c => c.openTime === openTime);
};

// Agrupa velas em blocos. 
// Se as velas são M1, blockSize 5 = blocos de 5 min.
// Se as velas são M5, blockSize 5 = blocos de 25 min.
export const groupInBlocks = (candles: Candle[], candlesPerBlock: number = 5): Candle[][] => {
  if (candles.length === 0) return [];

  // Detecta o intervalo entre as velas (em minutos)
  const firstInterval = candles.length > 1 ? (candles[1].openTime - candles[0].openTime) : 60000;
  const candleIntervalMin = Math.round(firstInterval / 60000);

  // O tamanho do bloco em minutos é (velas por bloco * tempo de cada vela)
  const blockSizeMinutes = candlesPerBlock * candleIntervalMin;

  const blocks: Candle[][] = [];
  let currentBlock: Candle[] = [];
  // Flag para controlar se já encontramos o primeiro boundary correto.
  // Isso descarta o bloco inicial incompleto que pode começar no meio de um ciclo.
  let foundFirstBoundary = false;

  for (const candle of candles) {
    const date = new Date(candle.openTime);
    // CRÍTICO: usar UTC — os timestamps da Binance são UTC.
    // getHours()/getMinutes() usa o fuso local do servidor e quebra o boundary.
    const totalMinutes = (date.getUTCHours() * 60) + date.getUTCMinutes();
    const isOnBoundary = totalMinutes % blockSizeMinutes === 0;

    if (isOnBoundary) {
      if (!foundFirstBoundary) {
        // Descarta qualquer vela acumulada antes do primeiro boundary real
        foundFirstBoundary = true;
        currentBlock = [];
      } else if (currentBlock.length > 0) {
        blocks.push(currentBlock);
        currentBlock = [];
      }
    }

    if (foundFirstBoundary) {
      currentBlock.push(candle);
    }
  }

  // Inclui o bloco final se tiver pelo menos 5 velas (bloco completo ou quase).
  // A condição === candlesPerBlock era rígida demais e descartava blocos válidos
  // quando o boundary não era detectado corretamente (ver fix UTC acima).
  if (currentBlock.length >= 5) {
    blocks.push(currentBlock);
  }

  return blocks;
};

// ============================================================================
// LÓGICAS DOS PADRÕES
// ============================================================================

export const analyzeMHI1 = (previousBlock: Candle[]): 'GREEN' | 'RED' | null => {
  if (previousBlock.length < 5) return null;
  const last3 = previousBlock.slice(-3);
  const greens = last3.filter(c => c.color === 'GREEN').length;
  const reds = last3.filter(c => c.color === 'RED').length;

  if (greens === 0 && reds === 0) return null;
  return greens < reds ? 'GREEN' : 'RED'; // Minoria
};

export const analyzeMHIMaioria = (previousBlock: Candle[]): 'GREEN' | 'RED' | null => {
  if (previousBlock.length < 5) return null;
  const last3 = previousBlock.slice(-3);
  const greens = last3.filter(c => c.color === 'GREEN').length;
  const reds = last3.filter(c => c.color === 'RED').length;

  if (greens === 0 && reds === 0) return null;
  return greens > reds ? 'GREEN' : 'RED'; // Maioria
};

// MHI 2 e MHI 3 usam EXATAMENTE a mesma lógica de minoria que MHI 1.
// A diferença entre elas é APENAS o entryIndex definido em index.ts:
//   MHI 1 → entrada na vela 0 do próximo bloco
//   MHI 2 → entrada na vela 1 do próximo bloco
//   MHI 3 → entrada na vela 2 do próximo bloco
// Os aliases abaixo existem apenas para clareza semântica no array de estratégias.
export const analyzeMHI2 = analyzeMHI1;
export const analyzeMHI3 = analyzeMHI1;

// Torres Gêmeas M5: lê a ÚLTIMA vela do bloco anterior.
// Sinal = a cor dessa vela (aposta que o próximo bloco abre na mesma direção).
export const analyzeTorresGemeas = (previousBlock: Candle[]): 'GREEN' | 'RED' | null => {
  if (previousBlock.length < 5) return null;
  const lastCandle = previousBlock[previousBlock.length - 1];
  return lastCandle.color !== 'DOJI' ? lastCandle.color : null;
};

// Torres Gêmeas M1: exige que as 2 ÚLTIMAS velas do bloco sejam da mesma cor.
// Isso captura o conceito de "gêmeas de verdade" — duas velas consecutivas confirmando direção.
// Retorna null se as duas são diferentes ou se alguma é DOJI.
export const analyzeTorresGemeasM1 = (previousBlock: Candle[]): 'GREEN' | 'RED' | null => {
  if (previousBlock.length < 5) return null;
  const last = previousBlock[previousBlock.length - 1];
  const secondLast = previousBlock[previousBlock.length - 2];
  if (last.color === 'DOJI' || secondLast.color === 'DOJI') return null;
  if (last.color !== secondLast.color) return null;
  return last.color;
};

// Padrão 23 M5: lê a 2ª vela do bloco (índice 1) — referência temporal dentro do quadrante de 25min.
export const analyzePadrao23 = (previousBlock: Candle[]): 'GREEN' | 'RED' | null => {
  if (previousBlock.length < 5) return null;
  const candle2 = previousBlock[1];
  return candle2.color !== 'DOJI' ? candle2.color : null;
};

// Padrão 23 M1: usa a MAIORIA entre a 2ª e a 3ª vela do bloco de 5 M1.
// Se as duas concordam → sinal na direção delas.
// Se discordam → null (sem sinal, empate).
// Se alguma é DOJI → não conta para o placar (ignora ela).
export const analyzePadrao23M1 = (previousBlock: Candle[]): 'GREEN' | 'RED' | null => {
  if (previousBlock.length < 5) return null;
  const candle2 = previousBlock[1];
  const candle3 = previousBlock[2];

  const votes: Array<'GREEN' | 'RED'> = [];
  if (candle2.color !== 'DOJI') votes.push(candle2.color);
  if (candle3.color !== 'DOJI') votes.push(candle3.color);

  if (votes.length === 0) return null;

  const greens = votes.filter(v => v === 'GREEN').length;
  const reds = votes.filter(v => v === 'RED').length;

  if (greens > reds) return 'GREEN';
  if (reds > greens) return 'RED';
  return null; // empate (1 GREEN + 1 RED) → sem sinal
};

export const analyzeM1Trend = (candles: Candle[]): 'GREEN' | 'RED' | null => {
  if (candles.length < 1) return null;
  const lastCandle = candles[candles.length - 1];
  return lastCandle.color !== 'DOJI' ? lastCandle.color : null;
};

// ============================================================================
// RESULTADO DO TRADE
//  0  = WIN direto (sem gale)
//  1  = WIN no Gale 1
//  2  = WIN no Gale 2
// -1  = LOSS (perdeu direto + G1 + G2)
// null = Não operou (sinal nulo ou velas insuficientes)
// ============================================================================

export interface TradeResult {
  result: 0 | 1 | 2 | -1;
  time: number;
  direction: 'CALL' | 'PUT';
}

// ============================================================================
// CATALOGADOR CORRIGIDO
//
// Estratégia com 2 gales:
//   - Entrada principal  → vela [entryCandleIndex] do bloco atual
//   - Gale 1             → próxima vela após a entrada
//   - Gale 2             → vela seguinte ao Gale 1
//
// A busca da vela usa o array plano para nunca perder o fio
// entre blocos (ex: entrada é última vela do bloco, gales caem no bloco seguinte).
// ============================================================================

export const runCataloger = (
  blocks: Candle[][],
  patternAnalyzer: (prevBlock: Candle[]) => 'GREEN' | 'RED' | null,
  entryCandleIndex: number = 0
): TradeResult[] => {

  const history: TradeResult[] = [];

  // Array plano: facilita navegar N velas à frente sem se preocupar com fronteiras de bloco
  const flat = flattenBlocks(blocks);

  for (let i = 1; i < blocks.length; i++) {
    const prevBlock = blocks[i - 1];
    const currentBlock = blocks[i];

    // Precisa de blocos com conteúdo suficiente
    if (prevBlock.length < 1 || currentBlock.length <= entryCandleIndex) {
      continue;
    }

    // Analisa o bloco anterior para decidir a direção
    const prediction = patternAnalyzer(prevBlock);
    if (!prediction) continue;

    // Vela de entrada: posição `entryCandleIndex` dentro do bloco atual
    const entryCandle = currentBlock[entryCandleIndex];
    const entryFlatIdx = findCandleIndex(flat, entryCandle.openTime);

    // Se não encontramos a vela no array plano, pula
    if (entryFlatIdx === -1) continue;

    // Simula até 3 tentativas: entrada + G1 + G2
    let tradeResult: 0 | 1 | 2 | -1 | null = null;

    for (let attempt = 0; attempt <= 2; attempt++) {
      const candleFlatIdx = entryFlatIdx + attempt;

      // Se não há velas suficientes para completar esse gale (fim do histórico),
      // não definimos o resultado ainda (fica null) e paramos a análise deste trade.
      if (candleFlatIdx >= flat.length) {
        tradeResult = null;
        break;
      }

      const tradeCandle = flat[candleFlatIdx];

      if (tradeCandle.color === 'DOJI') {
        // DOJI: se ainda há gale disponível, continua para o próximo.
        // Se este é o último attempt (G2), é LOSS — não há mais chances.
        if (attempt === 2) {
          tradeResult = -1;
        }
        continue;
      }

      if (tradeCandle.color === prediction) {
        tradeResult = attempt as 0 | 1 | 2;
        break;
      }

      // Vela adversária na última tentativa (G2): LOSS
      if (attempt === 2) {
        tradeResult = -1;
      }
    }

    // Só adicionamos ao histórico se o trade foi REALMENTE finalizado
    // (Ou ganhou em algum nível, ou perdeu todos os gales disponíveis)
    if (tradeResult !== null) {
      history.push({
        result: tradeResult,
        time: entryCandle.openTime,
        direction: prediction === 'GREEN' ? 'CALL' : 'PUT'
      });
    }
  }

  return history;
};

/**
 * Detecta se o gráfico está "morto" (baixa liquidez/volatilidade).
 * Baseia-se na quantidade de DOJIs e na variedade de preços.
 */
export const isDeadChart = (candles: Candle[], dojiThreshold: number = 20, uniquePriceThreshold: number = 15): boolean => {
  if (candles.length < 60) return false; // Pouco dado, não bloqueia ainda

  // Analisamos as últimas 100 velas (ou o que tiver disponível)
  const recent = candles.slice(-100);
  const total = recent.length;

  const dojis = recent.filter(c => c.color === 'DOJI').length;
  const dojiRate = (dojis / total) * 100;

  // Conta quantos níveis de preço de fechamento diferentes existem
  const uniquePrices = new Set(recent.map(c => c.close)).size;

  // Critérios:
  // 1. Mais de X% das velas são DOJI (preço não se moveu entre abertura e fechamento)
  // 2. Menos de Y preços diferentes em 100 velas (movimento em degraus fixos)
  if (dojiRate > dojiThreshold || uniquePrices < uniquePriceThreshold) {
    return true;
  }

  return false;
};