import React, { useMemo } from 'react';
import { LineChart, Line, ResponsiveContainer, YAxis } from 'recharts';

interface SignalCardProps {
  pair: string;
  pattern: string;
  rawHistory: number[]; // 0=Win, 1=G1, 2=G2, 3=G3, -1=Hit
  galeLimit: number; // Filtro do usuário
  timeframe: number;
}

export const SignalCard: React.FC<SignalCardProps> = ({ pair, pattern, rawHistory, galeLimit, timeframe }) => {
  // Recalcula estatísticas localmente
  const stats = useMemo(() => {
    let winDirect = 0;
    let g1 = 0;
    let g2 = 0;
    let g3 = 0;
    let hit = 0;

    let score = 0;
    const trendData: { score: number }[] = [];
    const visualBlocks: boolean[] = [];

    // Considera apenas as últimas 100 entradas para a estatística
    const recentHistory = rawHistory.slice(-100);

    for (const rawResult of recentHistory) {
      // Hit ocorre se o resultado original foi Hit, ou se a vitória exigiu mais gales do que o filtro permite
      const isHit = rawResult === -1 || rawResult > galeLimit;
      
      if (isHit) {
        hit++;
        visualBlocks.push(false);
        score -= 2; // Penalidade maior para Loss no gráfico
      } else {
        if (rawResult === 0) winDirect++;
        else if (rawResult === 1) g1++;
        else if (rawResult === 2) g2++;
        else if (rawResult === 3) g3++;
        visualBlocks.push(true);
        score += 1;
      }
      trendData.push({ score });
    }

    const totalTrades = recentHistory.length;
    const totalWins = winDirect + g1 + g2 + g3;
    const winRate = totalTrades > 0 ? Math.round((totalWins / totalTrades) * 100) : 0;

    // Tendência = delta do score nas últimas 10 operações
    const recentScoreDelta = trendData.length > 10 
      ? trendData[trendData.length - 1].score - trendData[trendData.length - 10].score 
      : 0;

    return { winDirect, g1, g2, g3, hit, winRate, totalTrades, visualBlocks, trendData, recentScoreDelta };
  }, [rawHistory, galeLimit]);

  // Calcula o tempo que 100 trades representam
  const timeContext = useMemo(() => {
    const totalMinutes = 100 * (rawHistory.length > 0 ? (rawHistory.length >= 100 ? 100 : rawHistory.length) : 0); 
    // Simplificação: Cada trade no M5 = 5min, M1 = 1min. 
    // Como o rawHistory já vem filtrado pelo timeframe, podemos inferir.
    const isM1 = rawHistory.length > 500; // Heurística simples se não passar o TF
    // Mas é melhor passar o timeframe como prop. Vou assumir que o usuário quer ver o contexto.
    return ""; // Vou ajustar abaixo passando o TF como prop
  }, [rawHistory]);

  const [showDetails, setShowDetails] = React.useState(false);

  const getPatternDescription = (name: string) => {
    const descriptions: Record<string, { desc: string, logic: string, candles: string[] }> = {
      'MHI 1': {
        desc: 'Analisa as 3 últimas velas de um quadrante de 5 minutos.',
        logic: 'Entrada na cor da MINORIA dessas 3 velas para a próxima vela.',
        candles: ['bg-slate-600', 'bg-slate-600', 'bg-green-500', 'bg-red-500', 'bg-red-500', 'bg-green-500']
      },
      'MHI Maioria': {
        desc: 'Analisa as 3 últimas velas de um quadrante de 5 minutos.',
        logic: 'Entrada na cor da MAIORIA dessas 3 velas para a próxima vela.',
        candles: ['bg-slate-600', 'bg-slate-600', 'bg-green-500', 'bg-red-500', 'bg-red-500', 'bg-red-500']
      },
      'Torres Gêmeas': {
        desc: 'Compara a primeira vela do quadrante com a última.',
        logic: 'A entrada deve ser da COR OPOSTA à primeira vela do quadrante.',
        candles: ['bg-green-500', 'bg-slate-600', 'bg-slate-600', 'bg-slate-600', 'bg-red-500']
      },
      'Padrão 23': {
        desc: 'Analisa a segunda e terceira vela do quadrante.',
        logic: 'Se a 2ª e 3ª forem iguais, entra para a mesma cor.',
        candles: ['bg-slate-600', 'bg-green-500', 'bg-green-500', 'bg-slate-600', 'bg-green-500']
      },
      'Tendência M1': {
        desc: 'Estratégia de seguimento de fluxo em 1 minuto.',
        logic: 'Entrada para a MESMA COR da vela anterior (Continuidade).',
        candles: ['bg-green-500', 'bg-green-500']
      }
    };
    return descriptions[name] || descriptions['MHI 1'];
  };

  const patternInfo = getPatternDescription(pattern);
  const last20Blocks = stats.visualBlocks.slice(-20);
  const isUpTrend = stats.recentScoreDelta >= 0;

  return (
    <div className="bg-slate-800 rounded-xl p-4 shadow-lg border border-slate-700 hover:border-blue-500 transition-colors w-full flex flex-col justify-between">
      <div>
        <div className="flex justify-between items-center mb-2">
          <div className="flex items-center gap-2">
            <span className="text-xl">🌐</span>
            <h3 className="text-white font-bold">{pair}</h3>
          </div>
          <div className="text-right">
            <p className="text-slate-400 text-xs font-medium italic mb-1">
              Últimas {(100 * timeframe / 60).toFixed(1)}h de análise
            </p>
            <p className="text-slate-400 text-sm font-bold">{pattern}</p>
            <p className={`font-bold text-lg ${stats.winRate >= 85 ? 'text-emerald-400' : 'text-amber-400'}`}>
              {stats.winRate}%
            </p>
          </div>
        </div>

        <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-2 font-bold">Desempenho por Entrada</p>
        <div className="flex justify-between text-xs text-slate-400 mb-2 text-center border-b border-slate-700 pb-2">
          <div>
            <p className="font-semibold text-slate-300 text-[9px] uppercase">Direto</p>
            <p className="text-emerald-400 text-sm font-bold">{stats.winDirect}</p>
          </div>
          {galeLimit >= 1 && (
            <div>
              <p className="font-semibold text-slate-300 text-[9px] uppercase">Gale 1</p>
              <p className="text-emerald-500 text-sm font-bold">{stats.g1}</p>
            </div>
          )}
          {galeLimit >= 2 && (
            <div>
              <p className="font-semibold text-slate-300 text-[9px] uppercase">Gale 2</p>
              <p className="text-emerald-600 text-sm font-bold">{stats.g2}</p>
            </div>
          )}
          {galeLimit >= 3 && (
            <div>
              <p className="font-semibold text-slate-300 text-[9px] uppercase">Gale 3</p>
              <p className="text-emerald-700 text-sm font-bold">{stats.g3}</p>
            </div>
          )}
          <div>
            <p className="font-semibold text-slate-300 text-[9px] uppercase">Loss</p>
            <p className="text-red-500 text-sm font-bold">{stats.hit}</p>
          </div>
        </div>
      </div>

      {/* Seção de Gráfico e Visualização do Padrão */}
      <div className="flex gap-2 items-center mb-1 mt-1">
        {/* Mini-Gráfico de Tendência (60%) */}
        <div className="h-14 flex-1 bg-slate-900/40 rounded p-1">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={stats.trendData}>
              <YAxis domain={['auto', 'auto']} hide />
              <Line 
                type="monotone" 
                dataKey="score" 
                stroke={isUpTrend ? '#10b981' : '#ef4444'} 
                strokeWidth={2} 
                dot={false} 
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Visualizador do Padrão (40%) */}
        <div 
          onClick={() => setShowDetails(true)}
          className="h-14 w-16 bg-slate-700/30 rounded flex items-end justify-center gap-[2px] p-1 cursor-pointer hover:bg-slate-700/50 transition-colors border border-slate-700/50"
          title="Ver detalhes da estratégia"
        >
          {patternInfo.candles.slice(0, 5).map((color, i) => (
            <div key={i} className={`w-1.5 rounded-full ${color}`} style={{ height: `${20 + (i * 5)}%` }}></div>
          ))}
        </div>
      </div>

      {/* Modal de Detalhes da Estratégia */}
      {showDetails && (
        <div className="fixed inset-0 z-[100] bg-slate-900/95 backdrop-blur-xl flex items-center justify-center p-4">
          <div className="bg-slate-800 border border-slate-700 p-8 rounded-3xl max-w-md w-full shadow-2xl animate-in fade-in zoom-in duration-200">
            <h2 className="text-2xl font-bold text-white mb-2">{pattern}</h2>
            <p className="text-blue-400 text-sm font-semibold mb-6 uppercase tracking-wider">Lógica da Estratégia</p>
            
            <div className="bg-slate-900 p-6 rounded-2xl flex items-end justify-center gap-2 mb-8 h-32 border border-slate-700">
              {patternInfo.candles.map((color, i) => (
                <div key={i} className={`w-4 rounded-md shadow-lg ${color} transition-all`} style={{ height: `${40 + (i % 3) * 20}%` }}>
                  {i === patternInfo.candles.length - 1 && (
                    <div className="absolute -top-6 left-1/2 -translate-x-1/2 text-emerald-400 animate-bounce">▼</div>
                  )}
                </div>
              ))}
            </div>

            <div className="space-y-4 mb-8">
              <div className="flex gap-3">
                <div className="w-6 h-6 rounded-full bg-slate-700 flex items-center justify-center text-xs text-white">1</div>
                <p className="text-slate-300 text-sm">{patternInfo.desc}</p>
              </div>
              <div className="flex gap-3">
                <div className="w-6 h-6 rounded-full bg-blue-500 flex items-center justify-center text-xs text-white font-bold">2</div>
                <p className="text-white text-sm font-medium">{patternInfo.logic}</p>
              </div>
            </div>

            <button 
              onClick={() => setShowDetails(false)}
              className="w-full bg-slate-700 hover:bg-slate-600 text-white font-bold py-4 rounded-2xl transition-all"
            >
              Fechar Explicação
            </button>
          </div>
        </div>
      )}

      {/* Histórico em Quadradinhos (4 linhas de 5 colunas) */}
      <div className="mt-2 w-full">
        <div className="grid grid-cols-5 gap-1 w-full">
          {last20Blocks.map((isWin, index) => (
            <div 
              key={index} 
              className={`w-full h-4 rounded-sm shadow-sm ${isWin ? 'bg-emerald-500' : 'bg-red-500/80'}`}
              title={isWin ? 'Win' : 'Hit'}
            ></div>
          ))}
        </div>
      </div>
    </div>
  );
};
