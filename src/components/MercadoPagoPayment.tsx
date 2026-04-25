import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { Loader2, CreditCard } from 'lucide-react';

export const MercadoPagoPayment: React.FC = () => {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePayment = async () => {
    if (!user) return;
    
    setLoading(true);
    setError(null);

    try {
      // Chama a Cloud Function para criar a preferência
      // Chama a Cloud Function para criar a preferência
      const response = await fetch('https://createpreference-6m5t75on6q-rj.a.run.app', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ uid: user.uid }),
      });

      if (!response.ok) {
        throw new Error('Erro ao gerar link de pagamento');
      }

      const { init_point } = await response.json();
      
      // Redireciona para o checkout do Mercado Pago
      window.location.href = init_point;
    } catch (err) {
      console.error('Erro no Mercado Pago:', err);
      setError('Não foi possível iniciar o pagamento. Tente novamente.');
      setLoading(false);
    }
  };

  return (
    <div className="w-full">
      {error && (
        <p className="text-red-400 text-xs mb-3 text-center bg-red-400/10 p-2 rounded-lg border border-red-400/20">
          {error}
        </p>
      )}
      
      <button
        onClick={handlePayment}
        disabled={loading}
        className="w-full bg-blue-500 hover:bg-blue-600 disabled:bg-slate-700 text-white font-bold py-4 px-4 rounded-2xl transition-all flex items-center justify-center gap-2 shadow-lg shadow-blue-500/20 active:scale-95"
      >
        {loading ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : (
          <CreditCard size={20} />
        )}
        {loading ? 'Gerando PIX...' : 'Pagar com PIX ou Cartão (R$ 3,00)'}
      </button>
      
      <p className="text-[10px] text-slate-500 mt-3 text-center uppercase tracking-wider">
        Processado por Mercado Pago
      </p>
    </div>
  );
};
