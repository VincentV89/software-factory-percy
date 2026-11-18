import { createContext, useContext } from 'react';
import type { Me } from './api';

export const SessionContext = createContext<Me | undefined>(undefined);

export function useMe(): Me {
  const me = useContext(SessionContext);
  if (!me) throw new Error('useMe outside a session');
  return me;
}

export function isAdmin(me: Me): boolean {
  return me.platformAdmin || me.agencyAdmin.length > 0;
}
