import React, { createContext, useContext, useEffect, useState } from 'react';
import { type User, onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { auth, loginAnonymously, db } from '../lib/firebase';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  timeRemaining: number | null; // Em segundos
  refreshPremiumStatus: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({ 
  user: null, 
  loading: true, 
  timeRemaining: null,
  refreshPremiumStatus: async () => {}
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);

  const calculateRemainingTime = async (currentUser: User) => {
    // 1. Check Trial (15 minutes)
    const creationTime = new Date(currentUser.metadata.creationTime || Date.now()).getTime();
    const now = Date.now();
    const trialDuration = 900; 
    const trialElapsed = Math.floor((now - creationTime) / 1000);
    let remaining = trialElapsed < trialDuration ? trialDuration - trialElapsed : 0;

    // 2. Check Premium status from Firestore
    try {
      const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
      if (userDoc.exists()) {
        const data = userDoc.data();
        if (data.premiumUntil) {
          const premiumUntil = data.premiumUntil.toMillis ? data.premiumUntil.toMillis() : data.premiumUntil;
          const premiumRemaining = Math.floor((premiumUntil - now) / 1000);
          if (premiumRemaining > 0) {
            remaining = premiumRemaining;
          }
        }
      } else {
        // Create user doc if it doesn't exist
        await setDoc(doc(db, 'users', currentUser.uid), {
          uid: currentUser.uid,
          createdAt: new Date(),
          trialStartedAt: new Date(creationTime)
        });
      }
    } catch (error) {
      console.error("Error fetching premium status:", error);
    }

    setTimeRemaining(remaining);
  };

  const refreshPremiumStatus = async () => {
    if (user) {
      await calculateRemainingTime(user);
    }
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (!currentUser) {
        await loginAnonymously();
      } else {
        setUser(currentUser);
        await calculateRemainingTime(currentUser);
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
    <AuthContext.Provider value={{ user, loading, timeRemaining, refreshPremiumStatus }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
