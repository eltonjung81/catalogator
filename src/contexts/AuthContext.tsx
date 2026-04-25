import React, { createContext, useContext, useEffect, useState } from 'react';
import { type User, onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { auth, loginWithGoogle, loginAnonymously, db } from '../lib/firebase';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  timeRemaining: number | null; // Em segundos
  login: () => Promise<void>;
  refreshPremiumStatus: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({ 
  user: null, 
  loading: true, 
  timeRemaining: null,
  login: async () => {},
  refreshPremiumStatus: async () => {}
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);

  const checkIpEligibility = async (uid: string): Promise<boolean> => {
    try {
      const response = await fetch('https://api.ipify.org?format=json');
      const data = await response.json();
      const ip = data.ip;

      const ipDocRef = doc(db, 'ips', ip);
      const ipDoc = await getDoc(ipDocRef);
      const now = Date.now();

      if (ipDoc.exists()) {
        const ipData = ipDoc.data();
        // Se o IP já foi usado por OUTRO usuário nas últimas 24h, bloqueia o trial
        if (ipData.uid !== uid) {
          const lastUsed = ipData.lastUsedAt?.toMillis ? ipData.lastUsedAt.toMillis() : ipData.lastUsedAt;
          if (now - lastUsed < 24 * 60 * 60 * 1000) {
            return false; // Bloqueado
          }
        }
      }

      // Registra/Atualiza o IP para este usuário
      await setDoc(ipDocRef, {
        uid: uid,
        lastUsedAt: now
      });

      return true;
    } catch (error) {
      console.error("Erro ao verificar IP:", error);
      return true; // Em caso de erro de rede (adblock, etc), permite por padrão
    }
  };

  const calculateRemainingTime = async (currentUser: User) => {
    const now = Date.now();
    let remaining = 0;

    try {
      if (currentUser.isAnonymous) {
        // Lógica para modo Anônimo (2 minutos) com trava de IP
        const ipEligible = await checkIpEligibility(currentUser.uid);
        
        if (!ipEligible) {
          remaining = 0; // Se o IP já usou, começa zerado
        } else {
          const creationTime = new Date(currentUser.metadata.creationTime || Date.now()).getTime();
          const trialDuration = 120; // 2 minutos em segundos
          const trialElapsed = Math.floor((now - creationTime) / 1000);
          remaining = trialElapsed < trialDuration ? trialDuration - trialElapsed : 0;
        }
      } else {
        // Lógica para modo Google (20 minutos)
        let userDoc = await getDoc(doc(db, 'users', currentUser.uid));
        let isEligibleForTrial = true;

        if (!userDoc.exists()) {
          isEligibleForTrial = await checkIpEligibility(currentUser.uid);
          
          await setDoc(doc(db, 'users', currentUser.uid), {
            uid: currentUser.uid,
            createdAt: new Date(),
            trialStartedAt: isEligibleForTrial ? new Date() : null,
            trialUsed: !isEligibleForTrial
          });
          userDoc = await getDoc(doc(db, 'users', currentUser.uid));
        }

        const data = userDoc.data();
        
        // 1. Check Google Trial (20 min)
        if (data && data.trialStartedAt) {
          const trialStart = data.trialStartedAt.toMillis ? data.trialStartedAt.toMillis() : data.trialStartedAt;
          const trialDuration = 1200; // 20 minutos
          const trialElapsed = Math.floor((now - trialStart) / 1000);
          if (trialElapsed < trialDuration) {
            remaining = trialDuration - trialElapsed;
          }
        }

        // 2. Check Premium (24h)
        if (data && data.premiumUntil) {
          const premiumUntil = data.premiumUntil.toMillis ? data.premiumUntil.toMillis() : data.premiumUntil;
          const premiumRemaining = Math.floor((premiumUntil - now) / 1000);
          if (premiumRemaining > 0) {
            remaining = premiumRemaining;
          }
        }
      }
    } catch (error) {
      console.error("Error fetching user data:", error);
    }

    setTimeRemaining(remaining);
  };


  const refreshPremiumStatus = async () => {
    if (user) {
      await calculateRemainingTime(user);
    }
  };

  const login = async () => {
    setLoading(true);
    try {
      await loginWithGoogle();
    } catch (error) {
      console.error("Erro ao logar:", error);
      setLoading(false);
      alert("Erro ao fazer login com Google. Verifique se os pop-ups estão permitidos.");
    }
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (currentUser) {
        setUser(currentUser);
        await calculateRemainingTime(currentUser);
      } else {
        await loginAnonymously();
      }
      setLoading(false);
    });

    return unsubscribe;
  }, []);

  // Timer para decrementar os segundos localmente
  useEffect(() => {
    if (timeRemaining !== null && timeRemaining > 0) {
      const timer = setInterval(() => {
        setTimeRemaining((prev) => (prev && prev > 0 ? prev - 1 : 0));
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [timeRemaining]);

  return (
    <AuthContext.Provider value={{ user, loading, timeRemaining, login, refreshPremiumStatus }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
