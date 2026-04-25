import React, { useMemo } from 'react';
import { LineChart, Line, ResponsiveContainer, YAxis } from 'recharts';

interface SignalCardProps {
  pair: string;
  pattern: string;
  rawHistory: number[]; // 0=Win, 1=G1, 2=G2, 3=G3, -1=Hit
  galeLimit: number; // Filtro do usuário
}

export const SignalCard: React.FC<SignalCardProps> = ({ pair, pattern, rawHistory, galeLimit }) => {
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

  // Exibe apenas as últimas 20 bolinhas
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
            <p className="text-slate-400 text-sm font-semibold">{pattern}</p>
            <p className={`font-bold text-lg ${stats.winRate >= 85 ? 'text-emerald-400' : 'text-amber-400'}`}>
              {stats.winRate}%
            </p>
          </div>
        </div>

        <div className="flex justify-between text-xs text-slate-400 mb-2 text-center border-b border-slate-700 pb-2">
          <div>
            <p className="font-semibold text-slate-300">WIN</p>
            <p className="text-emerald-400 text-sm font-bold">{stats.winDirect}</p>
          </div>
          {galeLimit >= 1 && (
            <div>
              <p className="font-semibold text-slate-300">G1</p>
              <p className="text-emerald-500 text-sm font-bold">{stats.g1}</p>
            </div>
          )}
          {galeLimit >= 2 && (
            <div>
              <p className="font-semibold text-slate-300">G2</p>
              <p className="text-emerald-600 text-sm font-bold">{stats.g2}</p>
            </div>
          )}
          {galeLimit >= 3 && (
            <div>
              <p className="font-semibold text-slate-300">G3</p>
              <p className="text-emerald-700 text-sm font-bold">{stats.g3}</p>
            </div>
          )}
          <div>
            <p className="font-semibold text-slate-300">HIT</p>
            <p className="text-red-500 text-sm font-bold">{stats.hit}</p>
          </div>
        </div>
      </div>

      {/* Mini-Gráfico de Tendência (Sparkline) */}
      <div className="h-14 w-full my-1 bg-slate-900/40 rounded p-1">
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
