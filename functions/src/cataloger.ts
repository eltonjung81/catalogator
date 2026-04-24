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
    
    // O retorno da Binance é um array de arrays
    return response.data.map((data: any[]) => {
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

// Agrupa velas de M1 em blocos de 5 minutos
// (A vela M1 00:00, 00:01, 00:02, 00:03, 00:04 formam o bloco das 00:00)
export const groupInBlocks = (candles: Candle[], blockSize: number = 5): Candle[][] => {
  const blocks: Candle[][] = [];
  let currentBlock: Candle[] = [];

  for (const candle of candles) {
    const date = new Date(candle.openTime);
    const minute = date.getMinutes();

    // Começa um novo bloco quando o minuto é múltiplo do blockSize (ex: 0, 5, 10...)
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
// Cada função de padrão recebe o bloco anterior (para análise) 
// e retorna a COR PREVISTA ('GREEN' ou 'RED') ou null se não houver entrada
// ============================================================================

export const analyzeMHI1 = (previousBlock: Candle[]): 'GREEN' | 'RED' | null => {
  if (previousBlock.length < 5) return null;
  // Analisa as últimas 3 velas do bloco (índices 2, 3, 4)
  const last3 = previousBlock.slice(-3);
  const greens = last3.filter(c => c.color === 'GREEN').length;
  const reds = last3.filter(c => c.color === 'RED').length;
  
  if (greens === 0 && reds === 0) return null; // 3 Dojis
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
  // A previsão é igual à última vela do bloco anterior
  const lastCandle = previousBlock[previousBlock.length - 1];
  return lastCandle.color !== 'DOJI' ? lastCandle.color : null;
};

export const analyzePadrao23 = (previousBlock: Candle[]): 'GREEN' | 'RED' | null => {
  if (previousBlock.length < 5) return null;
  // Observa a vela 2 e 3. Se iguais, a entrada é a minoria entre as duas?
  // Simplificação comum: A entrada é a cor da vela 2
  const candle2 = previousBlock[1];
  return candle2.color !== 'DOJI' ? candle2.color : null;
};

// ============================================================================
// SIMULADOR DE HISTÓRICO
// Roda o padrão contra os blocos recentes e extrai a sequência crua de resultados
// ============================================================================

// O resultado será um array numérico que indica o desfecho:
// 0 = WIN (Vitória de primeira)
// 1 = GALE 1 (Vitória no primeiro gale)
// 2 = GALE 2 (Vitória no segundo gale)
// 3 = GALE 3 (Vitória no terceiro gale)
// -1 = HIT (Loss total)
// null = Não operou

export const runCataloger = (
  blocks: Candle[][], 
  patternAnalyzer: (prevBlock: Candle[]) => 'GREEN' | 'RED' | null,
  entryCandleIndex: number = 0 // 0 = 1ª vela (MHI1), 1 = 2ª vela (MHI2), etc.
): (number | null)[] => {
  
  const history: (number | null)[] = [];

  // Começa do índice 1, pois precisamos do bloco 0 como "bloco anterior" para analisar
  for (let i = 1; i < blocks.length; i++) {
    const prevBlock = blocks[i - 1];
    const currentBlock = blocks[i];

    // Se os blocos não estiverem completos (falha na API), pula
    if (prevBlock.length < 5 || currentBlock.length < 5) {
      history.push(null);
      continue;
    }

    const prediction = patternAnalyzer(prevBlock);
    
    if (!prediction) {
      history.push(null);
      continue;
    }

    let result: number | null = -1; // Assume HIT até provar o contrário

    // Tenta até o Gale 3 (são até 4 tentativas no total)
    for (let attempt = 0; attempt <= 3; attempt++) {
      const targetIndex = entryCandleIndex + attempt;
      
      // Se estourar as 5 velas do bloco, para de tentar
      if (targetIndex >= 5) break; 
      
      const tradeCandle = currentBlock[targetIndex];
      
      if (tradeCandle.color === prediction) {
        result = attempt; // Salvamos em qual tentativa deu Win (0=Win, 1=G1, 2=G2, 3=G3)
        break; // Para o laço de tentativas pois já ganhou
      }
    }

    history.push(result);
  }

  return history;
};
