import React, { createContext, useContext, useEffect, useState } from 'react';
import { type User, onAuthStateChanged } from 'firebase/auth';
import { auth, loginAnonymously } from '../lib/firebase';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  timeRemaining: number | null; // Em segundos
}

const AuthContext = createContext<AuthContextType>({ user: null, loading: true, timeRemaining: null });

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (!currentUser) {
        // Se não tem usuário, faz login anônimo automático
        await loginAnonymously();
      } else {
        setUser(currentUser);
        // Calcula o tempo restante (15 minutos = 900 segundos)
        const creationTime = new Date(currentUser.metadata.creationTime || Date.now()).getTime();
        const now = Date.now();
        const diffInSeconds = Math.floor((now - creationTime) / 1000);
        const trialDuration = 900; 

        if (diffInSeconds < trialDuration) {
          setTimeRemaining(trialDuration - diffInSeconds);
        } else {
          setTimeRemaining(0); // Tempo expirou
        }
      }
      setLoading(false);
    });

    return unsubscribe;
  }, []);

  // Timer para decrementar os segundos localmente
  useEffect(() => {
    if (timeRemaining !== null && timeRemaining > 0) {
      const timer = setInterval(() => {
        setTimeRemaining((prev) => (prev ? prev - 1 : 0));
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [timeRemaining]);

  return (
    <AuthContext.Provider value={{ user, loading, timeRemaining }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
