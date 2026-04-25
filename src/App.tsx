import { useEffect, useState, useMemo } from 'react';
import { collection, onSnapshot, query } from 'firebase/firestore';
import { db } from './lib/firebase';
import { SignalCard } from './components/SignalCard';
import { TradeSimulator } from './components/TradeSimulator';
import { useAuth } from './contexts/AuthContext';
import { Filter, Clock, Activity, Search, Globe, Info, CreditCard } from 'lucide-react';

const translations = {
  pt: {
    title: 'Catalogador Probabilístico',
    remaining: 'Tempo Restante',
    premium: 'Acesso Premium',
    pair: 'Par de Moeda',
    allPairs: 'Todos os Pares',
    martingale: 'Limite de Martingale',
    noGale: 'Sem Gale (Mão Fixa)',
    gale1: 'Até Gale 1',
    gale2: 'Até Gale 2',
    gale3: 'Até Gale 3',
    timeframe: 'Timeframe',
    loading: 'Buscando análises no banco de dados...',
    noSignals: 'Nenhum sinal encontrado para os filtros atuais.',
    waiting: 'Aguardando o robô processar os padrões...',
    modalTitle: 'Bem-vindo ao Futuro da Catalogação! 🚀',
    modalBody: 'Você acaba de ganhar 15 minutos de acesso gratuito para testar nossas inteligências artificiais de mercado.',
    modalOffer: 'Gostou? Libere o acesso completo por 24 horas por apenas $ 1.00 USD!',
    startTrial: 'Começar Degustação Grátis',
    lockTitle: 'Seu tempo gratuito acabou! ⏳',
    lockBody: 'Para continuar tendo acesso às melhores recomendações em tempo real, faça a liberação.',
    lockPrice: 'Valor para 24 horas',
    lockButton: 'Liberar Acesso Total ($1.00)',
    authMsg: 'Autenticando acesso...'
  },
  en: {
    title: 'Probabilistic Cataloger',
    remaining: 'Remaining Time',
    premium: 'Premium Access',
    pair: 'Asset Pair',
    allPairs: 'All Assets',
    martingale: 'Martingale Limit',
    noGale: 'No Gale (Fixed Hand)',
    gale1: 'Up to Gale 1',
    gale2: 'Up to Gale 2',
    gale3: 'Up to Gale 3',
    timeframe: 'Timeframe',
    loading: 'Fetching analysis from database...',
    noSignals: 'No signals found for current filters.',
    waiting: 'Waiting for the robot to process patterns...',
    modalTitle: 'Welcome to the Future of Trading! 🚀',
    modalBody: 'You just earned 15 minutes of free access to test our market intelligence tools.',
    modalOffer: 'Loving it? Unlock full access for 24 hours for only $ 1.00 USD!',
    startTrial: 'Start Free Trial',
    lockTitle: 'Free trial ended! ⏳',
    lockBody: 'To continue accessing real-time recommendations, please unlock the full version.',
    lockPrice: 'Price for 24 hours',
    lockButton: 'Unlock Full Access ($1.00)',
    authMsg: 'Authenticating access...'
  }
};

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
  
  // Filtros e UI
  const [lang, setLang] = useState<'pt' | 'en'>('pt');
  const [showWelcome, setShowWelcome] = useState(true);
  const [galeLimit, setGaleLimit] = useState<number>(2);
  const [selectedPair, setSelectedPair] = useState<string>('ALL');
  const [selectedTimeframe, setSelectedTimeframe] = useState<number>(5);
  
  const t = translations[lang];

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
    return <div className="min-h-screen bg-slate-900 flex items-center justify-center text-emerald-400 font-bold">{t.authMsg}</div>;
  }

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-4 md:p-8 relative">
      {/* Modal de Boas-Vindas */}
      {showWelcome && timeRemaining !== 0 && (
        <div className="fixed inset-0 z-50 bg-slate-900/90 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-800 border border-slate-700 p-8 rounded-3xl max-w-lg w-full text-center shadow-2xl animate-in zoom-in duration-300">
            <div className="w-16 h-16 bg-emerald-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
              <Info className="w-8 h-8 text-emerald-400" />
            </div>
            <h2 className="text-2xl font-bold text-white mb-4">{t.modalTitle}</h2>
            <p className="text-slate-300 mb-6">{t.modalBody}</p>
            <div className="bg-blue-500/10 border border-blue-500/20 p-4 rounded-2xl mb-8">
              <p className="text-blue-400 font-semibold">{t.modalOffer}</p>
            </div>
            <button 
              onClick={() => setShowWelcome(false)}
              className="w-full bg-emerald-500 hover:bg-emerald-600 text-white font-bold py-4 rounded-2xl transition-all shadow-lg shadow-emerald-500/20 active:scale-95"
            >
              {t.startTrial}
            </button>
          </div>
        </div>
      )}

      {/* Tela de Bloqueio */}
      {timeRemaining === 0 && (
        <div className="fixed inset-0 z-50 bg-slate-900/90 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-800 p-8 rounded-3xl max-w-md w-full border border-slate-700 text-center shadow-2xl">
            <h2 className="text-2xl font-bold text-white mb-4">{t.lockTitle}</h2>
            <p className="text-slate-300 mb-6">{t.lockBody}</p>
            <div className="bg-slate-700/50 p-6 rounded-2xl mb-6 border border-slate-600">
              <p className="text-sm text-slate-400 mb-2">{t.lockPrice}</p>
              <p className="text-4xl font-bold text-emerald-400">$ 1.00 <span className="text-xs text-slate-500 uppercase">usd</span></p>
            </div>
            <button className="w-full bg-blue-500 hover:bg-blue-600 text-white font-bold py-4 px-4 rounded-2xl transition-all flex items-center justify-center gap-2">
              <CreditCard size={20} />
              {t.lockButton}
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 border-b border-slate-800 pb-4 gap-4">
        <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent flex items-center gap-2">
          <Activity className="text-blue-400" />
          {t.title}
        </h1>
        <div className="flex flex-wrap items-center gap-3 w-full md:w-auto">
          {/* Seletor de Idioma */}
          <button 
            onClick={() => setLang(lang === 'pt' ? 'en' : 'pt')}
            className="bg-slate-800 hover:bg-slate-700 p-2 rounded-lg border border-slate-700 transition-colors"
            title="Switch Language"
          >
            <Globe size={18} className="text-slate-300" />
          </button>

          <div className="bg-slate-800/80 px-4 py-2 rounded-lg border border-slate-700 flex items-center gap-2">
            <Clock size={16} className="text-slate-400" />
            <span className="text-slate-400 text-sm hidden sm:inline">{t.remaining}:</span>
            <span className={`font-mono font-bold ${timeRemaining !== null && timeRemaining <= 300 ? 'text-red-400' : 'text-emerald-400'}`}>
              {formatTime(timeRemaining)}
            </span>
          </div>
          <button className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg text-sm font-semibold transition-colors flex-1 md:flex-none whitespace-nowrap">
            {t.premium}
          </button>
        </div>
      </header>

      {/* Barra de Filtros */}
      <section className="bg-slate-800 rounded-xl p-4 mb-8 border border-slate-700 flex flex-wrap gap-4 items-end">
        <div className="flex-1 min-w-[200px]">
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-400 mb-2">
            <Search size={16} /> {t.pair}
          </label>
          <select 
            className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-white outline-none focus:border-blue-500 transition-colors"
            value={selectedPair}
            onChange={(e) => setSelectedPair(e.target.value)}
          >
            <option value="ALL">{t.allPairs}</option>
            {uniquePairs.map(pair => (
              <option key={pair} value={pair}>{pair}</option>
            ))}
          </select>
        </div>
        
        <div className="flex-1 min-w-[200px]">
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-400 mb-2">
            <Clock size={16} /> {t.timeframe}
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
            <Filter size={16} /> {t.martingale}
          </label>
          <select 
            className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-white outline-none focus:border-blue-500 transition-colors"
            value={galeLimit}
            onChange={(e) => setGaleLimit(Number(e.target.value))}
          >
            <option value={0}>{t.noGale}</option>
            <option value={1}>{t.gale1}</option>
            <option value={2}>{t.gale2}</option>
            <option value={3}>{t.gale3}</option>
          </select>
        </div>
      </section>

      {/* Simulador de Trades - Fixo no Melhor de M5 seguindo a ordenação oficial */}
      {!loadingData && signals.length > 0 && (
        <TradeSimulator 
          topSignal={displaySignals.find(s => s.timeframe === 5) || null} 
        />
      )}

      {/* Grid */}
      <main className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
        {loadingData ? (
          <div className="col-span-full flex flex-col justify-center items-center py-20 text-slate-400">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-emerald-500 mb-4"></div>
            {t.loading}
          </div>
        ) : displaySignals.length === 0 ? (
          <div className="col-span-full flex flex-col justify-center items-center py-20 text-slate-400 bg-slate-800/30 rounded-xl border border-slate-800 border-dashed">
            <p className="text-lg">{t.noSignals}</p>
            <p className="text-sm mt-2">{t.waiting}</p>
          </div>
        ) : (
          displaySignals.map((signal) => (
            <SignalCard
              key={signal.id}
              pair={signal.pair}
              pattern={signal.pattern}
              rawHistory={signal.rawHistory || []}
              galeLimit={galeLimit}
              timeframe={selectedTimeframe}
            />
          ))
        )}
      </main>
    </div>
  )
}

export default App
