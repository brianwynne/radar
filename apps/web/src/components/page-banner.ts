// Lets a page contribute the content of the top "mode" banner (the green LIVE strip). AppShell
// provides the setter; a page calls usePageBanner(node) to take over the strip while it is mounted,
// and it reverts to the default LIVE text on unmount. Pass a memoised node so the effect is stable.
import { createContext, useContext, useEffect, type ReactNode } from 'react';

export const SetPageBanner = createContext<(node: ReactNode | null) => void>(() => {});

export function usePageBanner(node: ReactNode | null): void {
  const set = useContext(SetPageBanner);
  useEffect(() => {
    set(node);
    return () => set(null);
  }, [set, node]);
}
