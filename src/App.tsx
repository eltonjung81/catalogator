import { useEffect, useState, useMemo } from 'react';
import { collection, onSnapshot, query } from 'firebase/firestore';
import { db } from './lib/firebase';
import { SignalCard } from './components/SignalCard';
import { useAuth } from './contexts/AuthContext';
import { Filter, Clock, Activity, Search } from 'lucide-react';

interface SignalData {
  id: string;
  pair: string;
  pattern: string;
  timeframe: number;
  rawHistory: number[];
  updatedAt: any;
}

function App() {
  const { loading: authLoading, timeRemaining } = useAuth();
  const [signals, setSignals] = useState<SignalData[]>([]);
  const [loadingData, setLoadingData] = useState(true);

  // Filtros
  const [galeLimit, setGaleLimit] = useState<number>(2); // Padrão: Gale 2
  const [selectedPair, setSelectedPair] = useState<string>('ALL');
  const [selectedTimeframe, setSelectedTimeframe] = useState<number>(5); // Padrão: M5

  useEffect(() => {
    const q = query(collection(db, "signals"));
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const fetchedSignals: SignalData[] = [];
      snapshot.forEach((doc) => {
        fetchedSignals.push({
          id: doc.id,
          ...doc.data()
        } as SignalData);
      });
      setSignals(fetchedSignals);
      setLoadingData(false);
    }, (error) => {
      console.error("Erro ao buscar sinais:", error);
      setLoadingData(false);
    });

    return () => unsubscribe();
  }, []);

  // Filtra e ordena os sinais (O Motor de Recomendação)
  const displaySignals = useMemo(() => {
    let filtered = signals;
    if (selectedPair !== 'ALL') {
      filtered = filtered.filter(s => s.pair === selectedPair);
    }

    // Filtra por Timeframe
    filtered = filtered.filter(s => s.timeframe === selectedTimeframe);

    const getScoreForSorting = (rawHistory: number[]) => {
      if (!rawHistory) return { rate: 0, trendScore: -999 };
      const recent = rawHistory.slice(-100);
      let wins = 0;
      let trendScore = 0;
      recent.forEach((r, idx) => {
        const isHit = r === -1 || r > galeLimit;
        if (!isHit) wins++;
        
        // Peso pesado para a tendência recente (últimos 10 resultados)
        if (idx >= recent.length - 10) {
           trendScore += isHit ? -2 : 1;
        }
      });
      const rate = recent.length > 0 ? (wins / recent.length) * 100 : 0;
      return { rate, trendScore };
    };

    return filtered.sort((a, b) => {
      const scoreA = getScoreForSorting(a.rawHistory);
      const scoreB = getScoreForSorting(b.rawHistory);
      
      // Ordenação Primária: Tendência Recente (TrendScore)
      if (scoreA.trendScore !== scoreB.trendScore) {
        return scoreB.trendScore - scoreA.trendScore; 
      }
      // Ordenação Secundária: Assertividade Global
      return scoreB.rate - scoreA.rate; 
    });
  }, [signals, galeLimit, selectedPair, selectedTimeframe]);

  const uniquePairs = useMemo(() => {
    const pairs = new Set(signals.map(s => s.pair));
    return Array.from(pairs);
  }, [signals]);

  const formatTime = (seconds: number | null) => {
    if (seconds === null) return "--:--";
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  if (authLoading) {
    return <div className="min-h-screen bg-slate-900 flex items-center justify-center text-emerald-400 font-bold">Autenticando acesso...</div>;
  }

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-4 md:p-8 relative">
      {/* Tela de Bloqueio */}
      {timeRemaining === 0 && (
        <div className="fixed inset-0 z-50 bg-slate-900/90 backdrop-blur-sm flex items-center justify-center">
          <div className="bg-slate-800 p-8 rounded-2xl max-w-md w-full border border-slate-700 text-center shadow-2xl shadow-emerald-500/10">
            <h2 className="text-2xl font-bold text-white mb-4">Seu tempo gratuito acabou! ⏳</h2>
            <p className="text-slate-300 mb-6">
              Para continuar tendo acesso às melhores recomendações probabilísticas em tempo real, faça o pagamento via PIX.
            </p>
            <div className="bg-slate-700 p-6 rounded-xl mb-6">
              <p className="text-sm text-slate-400 mb-2">Valor para 24 horas</p>
              <p className="text-4xl font-bold text-emerald-400">R$ 3,00</p>
            </div>
            <button className="w-full bg-emerald-500 hover:bg-emerald-600 text-white font-bold py-3 px-4 rounded-xl transition-colors">
              Gerar PIX Copia e Cola
            </button>
            <p className="text-xs text-slate-500 mt-4">
              O acesso é liberado automaticamente após o pagamento.
            </p>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 border-b border-slate-800 pb-4 gap-4">
        <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent flex items-center gap-2">
          <Activity className="text-blue-400" />
          Catalogador Probabilístico
        </h1>
        <div className="flex flex-wrap items-center gap-4 w-full md:w-auto">
          <div className="bg-slate-800/80 px-4 py-2 rounded-lg border border-slate-700 flex items-center gap-2">
            <Clock size={16} className="text-slate-400" />
            <span className="text-slate-400 text-sm hidden sm:inline">Tempo Restante:</span>
            <span className={`font-mono font-bold ${timeRemaining !== null && timeRemaining <= 300 ? 'text-red-400' : 'text-emerald-400'}`}>
              {formatTime(timeRemaining)}
            </span>
          </div>
          <button className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg text-sm font-semibold transition-colors flex-1 md:flex-none whitespace-nowrap">
            Acesso Premium
          </button>
        </div>
      </header>

      {/* Barra de Filtros */}
      <section className="bg-slate-800 rounded-xl p-4 mb-8 border border-slate-700 flex flex-wrap gap-4 items-end">
        <div className="flex-1 min-w-[200px]">
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-400 mb-2">
            <Search size={16} /> Par de Moeda
          </label>
          <select 
            className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-white outline-none focus:border-blue-500 transition-colors"
            value={selectedPair}
            onChange={(e) => setSelectedPair(e.target.value)}
          >
            <option value="ALL">Todos os Pares</option>
            {uniquePairs.map(pair => (
              <option key={pair} value={pair}>{pair}</option>
            ))}
          </select>
        </div>
        
        <div className="flex-1 min-w-[200px]">
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-400 mb-2">
            <Clock size={16} /> Timeframe
          </label>
          <select 
            className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-white outline-none focus:border-blue-500 transition-colors"
            value={selectedTimeframe}
            onChange={(e) => setSelectedTimeframe(Number(e.target.value))}
          >
            <option value={1}>1 Minuto (M1)</option>
            <option value={5}>5 Minutos (M5)</option>
          </select>
        </div>

        <div className="flex-1 min-w-[200px]">
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-400 mb-2">
            <Filter size={16} /> Limite de Martingale
          </label>
          <select 
            className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-white outline-none focus:border-blue-500 transition-colors"
            value={galeLimit}
            onChange={(e) => setGaleLimit(Number(e.target.value))}
          >
            <option value={0}>Sem Gale (Mão Fixa)</option>
            <option value={1}>Até Gale 1</option>
            <option value={2}>Até Gale 2</option>
            <option value={3}>Até Gale 3</option>
          </select>
        </div>
      </section>

      {/* Grid */}
      <main className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
        {loadingData ? (
          <div className="col-span-full flex flex-col justify-center items-center py-20 text-slate-400">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-emerald-500 mb-4"></div>
            Buscando análises no banco de dados...
          </div>
        ) : displaySignals.length === 0 ? (
          <div className="col-span-full flex flex-col justify-center items-center py-20 text-slate-400 bg-slate-800/30 rounded-xl border border-slate-800 border-dashed">
            <p className="text-lg">Nenhum sinal encontrado para os filtros atuais.</p>
            <p className="text-sm mt-2">Aguardando o robô processar os padrões...</p>
          </div>
        ) : (
          displaySignals.map((signal) => (
            <SignalCard
              key={signal.id}
              pair={signal.pair}
              pattern={signal.pattern}
              rawHistory={signal.rawHistory || []}
              galeLimit={galeLimit}
            />
          ))
        )}
      </main>
    </div>
  )
}

export default App
