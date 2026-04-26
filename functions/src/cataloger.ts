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
    return response.data
      .filter((data: any[]) => now > data[6])
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

// Agrupa velas de M1 em blocos de N minutos
export const groupInBlocks = (candles: Candle[], blockSize: number = 5): Candle[][] => {
  const blocks: Candle[][] = [];
  let currentBlock: Candle[] = [];

  for (const candle of candles) {
    const date = new Date(candle.openTime);
    const minute = date.getMinutes();

    if (minute % blockSize === 0 && currentBlock.length > 0) {
      blocks.push(currentBlock);
      currentBlock = [];
    }
    currentBlock.push(candle);
  }
  
  if (currentBlock.length > 0) {
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

export const analyzeTorresGemeas = (previousBlock: Candle[]): 'GREEN' | 'RED' | null => {
  if (previousBlock.length < 5) return null;
  const lastCandle = previousBlock[previousBlock.length - 1];
  return lastCandle.color !== 'DOJI' ? lastCandle.color : null;
};

export const analyzePadrao23 = (previousBlock: Candle[]): 'GREEN' | 'RED' | null => {
  if (previousBlock.length < 5) return null;
  const candle2 = previousBlock[1];
  return candle2.color !== 'DOJI' ? candle2.color : null;
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
    let tradeResult: 0 | 1 | 2 | -1 = -1; // padrão: loss se não bater em nenhuma

    for (let attempt = 0; attempt <= 2; attempt++) {
      const candleFlatIdx = entryFlatIdx + attempt;

      // Não há velas suficientes para completar esse gale (fim do histórico)
      if (candleFlatIdx >= flat.length) {
        tradeResult = -1;
        break;
      }

      const tradeCandle = flat[candleFlatIdx];

      if (tradeCandle.color === 'DOJI') {
        // DOJI: a maioria dos traders considera empate e não avança o gale.
        // Aqui tratamos como "não venceu nessa vela" e avança para o gale.
        continue;
      }

      if (tradeCandle.color === prediction) {
        tradeResult = attempt as 0 | 1 | 2;
        break;
      }

      // Se chegou na última tentativa (G2) e não ganhou: LOSS
      if (attempt === 2) {
        tradeResult = -1;
      }
    }

    history.push({
      result: tradeResult,
      time: entryCandle.openTime,
      direction: prediction === 'GREEN' ? 'CALL' : 'PUT'
    });
  }

  return history;
};

/**
 * Detecta se o gráfico está "morto" (baixa liquidez/volatilidade).
 * Baseia-se na quantidade de DOJIs e na variedade de preços.
 */
export const isDeadChart = (candles: Candle[], dojiThreshold: number = 30, uniquePriceThreshold: number = 15): boolean => {
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
