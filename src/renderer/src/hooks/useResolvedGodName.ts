import { useEffect, useState } from 'react';
import { godNameFromRegistry, DEFAULT_GOD_NAME } from '@shared/godIdentity';

/**
 * God's persisted display name, for the boot screens shown BEFORE the store
 * has god's live agent object (so before `agent.name` exists anywhere to
 * read). Reads the registry directly, the same way useHive.ts's spawn effect
 * does, rather than assuming the default — otherwise a renamed god's own
 * "clocking in" screen would flash the wrong name every launch.
 */
export function useResolvedGodName(): string {
  const [godName, setGodName] = useState(DEFAULT_GOD_NAME);
  useEffect(() => {
    let cancelled = false;
    void window.cth.hiveRegistry().then((reg) => {
      if (!cancelled) setGodName(godNameFromRegistry(reg));
    }).catch(() => { /* keep the default while unknown */ });
    return () => { cancelled = true; };
  }, []);
  return godName;
}
