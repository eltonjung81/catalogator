import React, { useState } from 'react';
import { PayPalButtons } from '@paypal/react-paypal-js';
import { doc, updateDoc, Timestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../contexts/AuthContext';
import { Loader2, CheckCircle2, AlertCircle } from 'lucide-react';

export const PayPalPayment: React.FC = () => {
  const { user, refreshPremiumStatus } = useAuth();
  const [status, setStatus] = useState<'idle' | 'processing' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const handleApprove = async (_data: any, actions: any) => {
    if (!user) return;
    
    setStatus('processing');
    try {
      const details = await actions.order.capture();
      
      // Pagamento aprovado! Vamos liberar 24 horas de acesso
      const premiumUntil = new Date();
      premiumUntil.setHours(premiumUntil.getHours() + 24);

      await updateDoc(doc(db, 'users', user.uid), {
        premiumUntil: Timestamp.fromDate(premiumUntil),
        lastPaymentId: details.id,
        updatedAt: Timestamp.now()
      });

      setStatus('success');
      await refreshPremiumStatus();
    } catch (error) {
      console.error('Erro ao processar pagamento:', error);
      setStatus('error');
      setErrorMessage('Ocorreu um erro ao processar seu pagamento. Por favor, tente novamente.');
    }
  };

  if (status === 'processing') {
    return (
      <div className="flex flex-col items-center justify-center p-8 bg-slate-700/30 rounded-2xl border border-slate-600">
        <Loader2 className="w-12 h-12 text-blue-400 animate-spin mb-4" />
        <p className="text-white font-semibold text-lg">Processando seu pagamento...</p>
        <p className="text-slate-400 text-sm mt-2">Não feche esta janela.</p>
      </div>
    );
  }

  if (status === 'success') {
    return (
      <div className="flex flex-col items-center justify-center p-8 bg-emerald-500/10 rounded-2xl border border-emerald-500/20">
        <CheckCircle2 className="w-12 h-12 text-emerald-400 mb-4" />
        <p className="text-emerald-400 font-bold text-xl">Acesso Liberado! 🎉</p>
        <p className="text-slate-300 text-sm mt-2 text-center">
          Você agora tem acesso total por 24 horas. Aproveite as melhores recomendações!
        </p>
      </div>
    );
  }

  return (
    <div className="w-full space-y-4">
      {status === 'error' && (
        <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-3 mb-4">
          <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
          <p className="text-red-400 text-sm">{errorMessage}</p>
        </div>
      )}

      <PayPalButtons
        style={{ 
          layout: 'vertical',
          color: 'blue',
          shape: 'rect',
          label: 'pay'
        }}
        createOrder={(_data, actions) => {
          return actions.order.create({
            intent: 'CAPTURE',
            purchase_units: [
              {
                description: 'Acesso Premium 24h - Catalogador Probabilístico',
                amount: {
                  currency_code: 'USD',
                  value: '1.00',
                },
              },
            ],
          });
        }}
        onApprove={handleApprove}
        onError={(err) => {
          console.error('PayPal Error:', err);
          setStatus('error');
          setErrorMessage('Erro na comunicação com o PayPal. Tente novamente mais tarde.');
        }}
      />
    </div>
  );
};
