import type { HarnessConfig } from '@/store/config';
import { MCP_CATALOG } from '@shared/mcpCatalog';

export function resolveEnabledFor(
  mcpDefaults: HarnessConfig['mcpDefaults'],
  id: string,
  catalog = MCP_CATALOG
): boolean {
  return mcpDefaults?.[id]?.enabled ?? catalog.find((e) => e.id === id)?.defaultEnabled ?? false;
}

interface ApplyToggleDeps {
  updateConfig: (patch: Partial<HarnessConfig>) => Promise<unknown>;
  getConfig: () => Promise<{ mcpDefaults?: Record<string, { enabled: boolean }> }>;
}

/**
 * Persist the toggle, then RE-READ what actually landed and return that.
 *
 * Deliberately not optimistic. This is a CONSENT control: if the write did not
 * take, showing the intended value tells a human they granted something they
 * did not. The disk wins over intent, always.
 */
export async function applyToggle(
  id: string,
  next: boolean,
  currentDefaults: HarnessConfig['mcpDefaults'],
  deps: ApplyToggleDeps
): Promise<Record<string, { enabled: boolean }>> {
  await deps.updateConfig({ mcpDefaults: { ...(currentDefaults ?? {}), [id]: { enabled: next } } });
  const fresh = await deps.getConfig();
  return fresh.mcpDefaults ?? {};
}
