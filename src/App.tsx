import { useEffect, useState, useMemo, useCallback } from 'react';
import { collection, onSnapshot, query } from 'firebase/firestore';
import { PayPalScriptProvider } from '@paypal/react-paypal-js';
import { db, trackEvent } from './lib/firebase';
import { SignalCard } from './components/SignalCard';
import { TradeSimulator } from './components/TradeSimulator';
import { PayPalPayment } from './components/PayPalPayment';
import { MercadoPagoPayment } from './components/MercadoPagoPayment';
import { useAuth } from './contexts/AuthContext';
import { Filter, Clock, Activity, Search, Info, LogIn, Zap } from 'lucide-react';

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
    lockTitle: 'Teste Grátis Encerrado! ⏳',
    lockBody: 'Para liberar mais 20 minutos de acesso gratuito e conhecer todas as nossas ferramentas, faça login com o Google abaixo.',
    lockPrice: 'Internacional ($1.00 USD)',
    lockPriceBRL: 'Brasil (R$ 3,00 BRL)',
    authMsg: 'Autenticando acesso...',
    loginTitle: 'Acesso Restrito',
    loginBody: 'Faça login com o Google para liberar seus 15 minutos de acesso gratuito e começar a lucrar com nossas IAs.',
    loginBtn: 'Ganhar +20 Minutos Grátis',
    lockPremiumTitle: 'Acesso Premium Expirado 💎',
    lockPremiumBody: 'Seu tempo de 20 minutos acabou. Para continuar lucrando 24h por dia, escolha seu método de pagamento.',
    m1: '1 Minuto (M1)',
    m5: '5 Minutos (M5)',
    activeRobot: 'Robô Ativo 24h',
    immediateRelease: 'A liberação é imediata após a confirmação do pagamento.',
    monitorTitle: 'Monitor de Alta Performance (M5)',
    bankrollLabel: 'Banca Atual (Real)',
    profitLabel: 'Lucro Acumulado',
    timeLabel: 'Tempo de Operação',
    daysLabel: 'Dias',
    historyTitle: 'Histórico de Operações'
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
    lockTitle: 'Free Trial Ended! ⏳',
    lockBody: 'To unlock 20 more minutes of free access and explore all our tools, please log in with Google below.',
    lockPrice: 'International ($1.00 USD)',
    lockPriceBRL: 'Brazil (R$ 3,00 BRL)',
    authMsg: 'Authenticating access...',
    loginTitle: 'Restricted Access',
    loginBody: 'Log in with Google to unlock your 15 minutes of free access and start profiting with our AI.',
    loginBtn: 'Get +20 Free Minutes',
    lockPremiumTitle: 'Premium Access Expired 💎',
    lockPremiumBody: 'Your 20-minute trial has ended. To continue profiting 24/7, please choose your payment method.',
    m1: '1 Minute (M1)',
    m5: '5 Minutes (M5)',
    activeRobot: 'Robot Active 24/7',
    immediateRelease: 'Access is released immediately after payment confirmation.',
    monitorTitle: 'High Performance Monitor (M5)',
    bankrollLabel: 'Current Bankroll (Real)',
    profitLabel: 'Accumulated Profit',
    timeLabel: 'Operating Time',
    daysLabel: 'Days',
    historyTitle: 'Trade History'
  }
};

interface SignalData {
  id: string;
  pair: string;
  pattern: string;
  timeframe: number;
  rawHistory: any[];      // TradeResult[] = {result: number, time: number}
  updatedAt: any;
}

const normalizeResult = (r: any): number => {
  if (typeof r === 'number') return r;
  if (r && typeof r === 'object' && 'result' in r) return r.result;
  return -1;
};

function App() {
  const { user, loading: authLoading, timeRemaining, login } = useAuth();
  const [signals, setSignals] = useState<SignalData[]>([]);
  const [loadingData, setLoadingData] = useState(true);

  const [lang, setLang] = useState<'pt' | 'en'>(() => {
    // Detecta o idioma do navegador
    const browserLang = navigator.language.toLowerCase();
    return browserLang.startsWith('pt') ? 'pt' : 'en';
  });
  const [showWelcome, setShowWelcome] = useState(true);
  const [galeLimit, setGaleLimit] = useState<number>(2);
  const [selectedPair, setSelectedPair] = useState<string>('ALL');
  const [selectedTimeframe, setSelectedTimeframe] = useState<number>(5);
  const [paymentMethod, setPaymentMethod] = useState<'mercadopago' | 'paypal'>('mercadopago');

  const t = translations[lang];

  useEffect(() => {
    trackEvent('page_view', { language: lang });
  }, [lang]);

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

  const getScoreForSorting = useCallback((rawHistory: any[], limit: number): { rate: number; trendScore: number } => {
    if (!rawHistory || rawHistory.length === 0) return { rate: 0, trendScore: -999 };
    const recent = rawHistory.slice(-100);
    let wins = 0;
    let trendScore = 0;

    recent.forEach((r, idx) => {
      const val = normalizeResult(r);
      const isWin = val >= 0 && val <= limit; 
      if (isWin) wins++;

      if (idx >= recent.length - 10) {
        trendScore += isWin ? 1 : -2;
      }
    });

    const rate = recent.length > 0 ? (wins / recent.length) * 100 : 0;
    return { rate, trendScore };
  }, []);

  const displaySignals = useMemo(() => {
    let filtered = signals;
    if (selectedPair !== 'ALL') {
      filtered = filtered.filter(s => s.pair === selectedPair);
    }

    filtered = filtered.filter(s => s.timeframe === selectedTimeframe);

    return filtered.sort((a, b) => {
      const scoreA = getScoreForSorting(a.rawHistory, galeLimit);
      const scoreB = getScoreForSorting(b.rawHistory, galeLimit);

      if (scoreA.trendScore !== scoreB.trendScore) {
        return scoreB.trendScore - scoreA.trendScore;
      }
      return scoreB.rate - scoreA.rate;
    });
  }, [signals, galeLimit, selectedPair, selectedTimeframe, getScoreForSorting]);

  const uniquePairs = useMemo(() => {
    const pairs = new Set(signals.map(s => s.pair));
    return Array.from(pairs).sort();
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
    <PayPalScriptProvider options={{ clientId: import.meta.env.VITE_PAYPAL_CLIENT_ID, currency: "USD" }}>
      <div className="min-h-screen bg-slate-900 text-slate-100 p-4 md:p-8 relative">
        {/* Modal de Boas-Vindas */}
        {showWelcome && timeRemaining !== null && timeRemaining > 0 && (
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
                onClick={() => {
                  setShowWelcome(false);
                  trackEvent('start_trial_click');
                }}
                className="w-full bg-emerald-500 hover:bg-emerald-600 text-white font-bold py-4 rounded-2xl transition-all shadow-lg shadow-emerald-500/20 active:scale-95"
              >
                {t.startTrial}
              </button>
            </div>
          </div>
        )}

        {/* Tela de Bloqueio / Login */}
        {timeRemaining === 0 && (
          <div className="fixed inset-0 z-50 bg-slate-900/90 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto">
            <div className="bg-slate-800 p-8 rounded-3xl max-w-md w-full border border-slate-700 text-center shadow-2xl my-8">
              {user?.isAnonymous ? (
                // Fase 1: Pedir Login com Google para ganhar 20 min
                <>
                  <div className="w-16 h-16 bg-blue-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
                    <LogIn className="w-8 h-8 text-blue-400" />
                  </div>
                  <h2 className="text-2xl font-bold text-white mb-4">{t.lockTitle}</h2>
                  <p className="text-slate-300 mb-8">{t.lockBody}</p>
                  <button
                    onClick={() => {
                      login();
                      trackEvent('google_login_click');
                    }}
                    className="w-full flex items-center justify-center gap-3 bg-white hover:bg-slate-100 text-slate-800 font-bold py-4 px-6 rounded-2xl transition-all shadow-lg active:scale-95"
                  >
                    <svg className="w-6 h-6" viewBox="0 0 24 24">
                      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                    </svg>
                    {t.loginBtn}
                  </button>
                </>
              ) : (
                // Fase 2: Já logou no Google e o tempo de 20 min acabou, pedir pagamento
                <>
                  <h2 className="text-2xl font-bold text-white mb-4">{t.lockPremiumTitle}</h2>
                  <p className="text-slate-300 mb-6">{t.lockPremiumBody}</p>
                  
                  {/* Seletor de Pagamento */}
                  <div className="flex bg-slate-900/50 p-1 rounded-xl mb-6 border border-slate-700">
                    <button
                      onClick={() => {
                        setPaymentMethod('mercadopago');
                        trackEvent('select_payment', { method: 'mercadopago' });
                      }}
                      className={`flex-1 py-2 rounded-lg text-sm font-bold transition-all ${paymentMethod === 'mercadopago' ? 'bg-blue-500 text-white shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                      Mercado Pago (PIX)
                    </button>
                    <button
                      onClick={() => {
                        setPaymentMethod('paypal');
                        trackEvent('select_payment', { method: 'paypal' });
                      }}
                      className={`flex-1 py-2 rounded-lg text-sm font-bold transition-all ${paymentMethod === 'paypal' ? 'bg-blue-500 text-white shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                      PayPal
                    </button>
                  </div>

                  <div className="bg-slate-700/50 p-6 rounded-2xl mb-6 border border-slate-600">
                    <p className="text-sm text-slate-400 mb-2">
                      {paymentMethod === 'paypal' ? t.lockPrice : t.lockPriceBRL}
                    </p>
                    <p className="text-4xl font-bold text-emerald-400">
                      {paymentMethod === 'paypal' ? '$ 1.00' : 'R$ 3,00'}
                      <span className="text-xs text-slate-500 uppercase ml-2">
                        {paymentMethod === 'paypal' ? 'usd' : 'brl'}
                      </span>
                    </p>
                  </div>
                  
                  {paymentMethod === 'paypal' ? <PayPalPayment /> : <MercadoPagoPayment />}
                  
                  <p className="text-xs text-slate-500 mt-6">
                    {t.immediateRelease}
                  </p>
                </>
              )}
            </div>
          </div>
        )}

        {/* Header */}
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 border-b border-slate-800 pb-4 gap-4">
          <div>
            <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent flex items-center gap-2">
              <Activity className="text-blue-400" />
              {t.title}
            </h1>
            <p className="text-xs text-slate-500 mt-1 max-w-md">
              {lang === 'pt' 
                ? 'O mais avançado robô de sinais em tempo real para Opções Binárias e IQ Option. Estratégias probabilísticas M1 e M5 com alta assertividade.' 
                : 'The most advanced real-time signals bot for Binary Options and IQ Option. High-accuracy M1 and M5 probabilistic strategies.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 w-full md:w-auto">
            <button
              onClick={() => {
                const newLang = lang === 'pt' ? 'en' : 'pt';
                setLang(newLang);
                trackEvent('change_language', { language: newLang });
              }}
              className="bg-slate-800 hover:bg-slate-700 p-2 rounded-lg border border-slate-700 transition-colors flex items-center gap-2"
              title="Switch Language"
            >
              {lang === 'pt' ? (
                <span className="text-xl" title="Português">🇵🇹</span>
              ) : (
                <span className="text-xl" title="English">🇺🇸</span>
              )}
            </button>

            <div className="bg-slate-800/80 px-4 py-2 rounded-lg border border-slate-700 flex items-center gap-2">
              <Clock size={16} className="text-slate-400" />
              <span className="text-slate-400 text-sm hidden sm:inline">{t.remaining}:</span>
              <span className={`font-mono font-bold ${timeRemaining !== null && timeRemaining <= 300 ? 'text-red-400' : 'text-emerald-400'}`}>
                {formatTime(timeRemaining)}
              </span>
            </div>
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
              <option value={1}>{t.m1}</option>
              <option value={5}>{t.m5}</option>
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

        {!loadingData && signals.length > 0 && (
          <TradeSimulator
            topSignal={displaySignals.find(s => s.timeframe === 5) || null}
            galeLimit={galeLimit}
            lang={lang}
          />
        )}

        <h2 className="text-xl font-bold text-slate-400 mb-6 flex items-center gap-2">
          <Zap size={20} className="text-emerald-400" />
          {lang === 'pt' ? 'Melhores Sinais Ativos' : 'Best Active Signals'}
        </h2>

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
                updatedAt={signal.updatedAt}
                lang={lang}
              />
            ))
          )}
        </main>

        {/* SEO Footer */}
        <footer className="mt-20 pt-8 border-t border-slate-800 text-slate-400 text-sm">
          <article className="max-w-4xl mx-auto space-y-6">
            <div>
              <h3 className="text-white font-bold mb-2">
                {lang === 'pt' ? 'O que é um Catalogador Probabilístico para Opções Binárias?' : 'What is a Probabilistic Cataloger for Binary Options?'}
              </h3>
              <p className="leading-relaxed">
                {lang === 'pt' 
                  ? 'Um catalogador probabilístico é uma ferramenta essencial para traders de opções binárias que operam em corretoras como IQ Option, Quotex e Pocket Option. Nossa inteligência artificial analisa milhares de padrões em gráficos de velas (candlesticks) em tempo real, identificando estratégias consagradas como MHI, Padrão 23, Torres Gêmeas e Sequência de Cores. Com foco em timeframes de 1 minuto (M1) e 5 minutos (M5), o robô extrai as melhores probabilidades matemáticas de vitória, permitindo que você pare de operar "no escuro" e comece a basear suas entradas em dados estatísticos reais e monitorados 24 horas por dia.'
                  : 'A probabilistic cataloger is an essential tool for binary options traders operating on brokers like IQ Option, Quotex, and Pocket Option. Our artificial intelligence analyzes thousands of patterns in real-time candlestick charts, identifying renowned strategies such as MHI, Pattern 23, Twin Towers, and Color Sequences. Focusing on 1-minute (M1) and 5-minute (M5) timeframes, the bot extracts the highest mathematical probabilities of winning, allowing you to stop trading blindly and start basing your entries on real statistical data monitored 24/7.'}
              </p>
            </div>
            
            <div className="grid md:grid-cols-2 gap-6">
              <div>
                <h3 className="text-white font-bold mb-2">
                  {lang === 'pt' ? 'Sinais VIP com Mão Fixa e Martingale' : 'VIP Signals with Fixed Hand and Martingale'}
                </h3>
                <p className="leading-relaxed">
                  {lang === 'pt'
                    ? 'Diferente de salas de sinais comuns, nosso robô de sinais entrega as oportunidades diretamente no painel. Você tem a flexibilidade de aplicar filtros rigorosos: prefere entradas conservadoras em Mão Fixa (Sem Gale)? Ou utiliza gerenciamentos com Gale 1 e Gale 2? O painel calcula a assertividade (Win Rate) ao vivo para cada par de moedas (ex: EUR/USD, GBP/JPY), mostrando o fluxo de tendência e histórico recente para garantir a maior taxa de acerto.'
                    : 'Unlike standard signal rooms, our signal bot delivers opportunities directly to your dashboard. You have the flexibility to apply strict filters: do you prefer conservative Fixed Hand (No Gale) entries? Or do you use Gale 1 and Gale 2 money management? The dashboard calculates live Win Rate accuracy for each currency pair (e.g., EUR/USD, GBP/JPY), showing the trend flow and recent history to ensure the highest success rate.'}
                </p>
              </div>
              <div>
                <h3 className="text-white font-bold mb-2">
                  {lang === 'pt' ? 'Vantagem Competitiva no Mercado' : 'Competitive Advantage in the Market'}
                </h3>
                <p className="leading-relaxed">
                  {lang === 'pt'
                    ? 'A consistência nas opções binárias depende de eliminar o fator emocional. Ao confiar em um catalogador automático M1 e M5, você acessa uma análise matemática fria e calculista. As estratégias probabilísticas são atualizadas segundo a segundo. Seja você um trader iniciante buscando seu primeiro lucro ou um profissional em busca de automatização, nossa ferramenta oferece o backtest automático mais rápido do mercado.'
                    : 'Consistency in binary options depends on eliminating the emotional factor. By relying on an automatic M1 and M5 cataloger, you access cold, calculating mathematical analysis. Probabilistic strategies are updated second by second. Whether you are a beginner trader looking for your first profit or a professional seeking automation, our tool offers the fastest automatic backtesting on the market.'}
                </p>
              </div>
            </div>
            <div className="text-center mt-8 text-xs text-slate-500 pb-8">
              &copy; {new Date().getFullYear()} Catalogador Probabilístico. {lang === 'pt' ? 'Todos os direitos reservados.' : 'All rights reserved.'}
            </div>
          </article>
        </footer>
      </div>
    </PayPalScriptProvider>
  )
}

export default App
