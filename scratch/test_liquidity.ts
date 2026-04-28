
import { isDeadChart, Candle } from '../functions/src/cataloger';

function createMockCandles(count: number, pattern: 'dead' | 'healthy'): Candle[] {
  const candles: Candle[] = [];
  let lastPrice = 1.23456;
  
  for (let i = 0; i < count; i++) {
    let open = lastPrice;
    let close = lastPrice;
    
    if (pattern === 'healthy') {
      // Simula variação de preço
      close = open + (Math.random() - 0.5) * 0.001;
    } else {
      // Simula gráfico "morto": a maioria são DOJIs ou variam muito pouco
      if (Math.random() > 0.1) {
        close = open; // DOJI
      } else {
        close = open + 0.00001; // Degrau mínimo
      }
    }
    
    let color: 'GREEN' | 'RED' | 'DOJI' = 'DOJI';
    if (close > open) color = 'GREEN';
    if (close < open) color = 'RED';
    
    candles.push({
      openTime: Date.now() - (count - i) * 60000,
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      color
    });
    
    lastPrice = close;
  }
  
  return candles;
}

console.log("--- Testando Filtro de Liquidez ---");

const deadData = createMockCandles(100, 'dead');
const isDead = isDeadChart(deadData);
console.log(`Dados Mortos: isDead = ${isDead} (Esperado: true)`);

const healthyData = createMockCandles(100, 'healthy');
const isHealthy = isDeadChart(healthyData);
console.log(`Dados Saudáveis: isDead = ${isHealthy} (Esperado: false)`);

if (isDead === true && isHealthy === false) {
  console.log("SUCESSO: O filtro está funcionando corretamente.");
} else {
  console.log("ERRO: O filtro falhou nos testes.");
}
