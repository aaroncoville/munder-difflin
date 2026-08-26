import { useEffect, useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';

interface MemoryStatus {
  available: boolean;
  enabled: boolean;
  active: boolean;
  initialized: boolean;
  palacePath: string | null;
  backend: BackendId;
  location: string | null;
  model: 'minilm' | 'embeddinggemma';
  bin: string | null;
}

/** What the endpoint probe reported, exactly as main returned it. */
interface ConnectionTest { ok: boolean; detail: string; url: string; bank: string }

type ModelId = 'minilm' | 'embeddinggemma';
type BackendId = 'mempalace' | 'hindsight';

// Named by what the user gets, not by the product behind it — the codename is
// the sub-line, the same way the model choice below reads.
const BACKENDS: { id: BackendId; title: string; detail: string }[] = [
  { id: 'mempalace', title: 'On this machine', detail: 'MemPalace · nothing leaves the laptop' },
  { id: 'hindsight', title: 'On a server',     detail: 'Hindsight · shared across machines' },
];

// Plain-language framing of each model — lead with the benefit the user actually
// chooses between, not the model's codename.
const MODELS: { id: ModelId; title: string; detail: string }[] = [
  { id: 'minilm',         title: 'Fast',         detail: 'English only · ~90 MB' },
  { id: 'embeddinggemma', title: 'Multilingual', detail: 'all languages · ~300 MB' },
];

/**
 * Lets the human search the shared memory agents build up across sessions, turn
 * it on/off, and pick how it searches. Agents read/write it directly; this is
 * the human-facing window into the same memory.
 */
export function MemoryPanel() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState('');
  const [bank, setBank] = useState('');
  const [testing, setTesting] = useState(false);
  // ONLY ever assigned from a resolved memoryTestConnection response. The panel
  // must not claim a connection it merely attempted, so nothing here is derived
  // from the inputs above — including the address the verdict is shown against.
  const [tested, setTested] = useState<ConnectionTest | null>(null);

  const refreshStatus = async () => {
    try { setStatus(await window.cth.memoryStatus()); } catch { /* ignore */ }
  };
  const loadEndpoint = async () => {
    try {
      const cfg = await window.cth.getConfig();
      setUrl(cfg.hindsightUrl ?? '');
      setBank(cfg.hindsightBank ?? '');
    } catch { /* ignore */ }
  };
  useEffect(() => { refreshStatus(); loadEndpoint(); }, []);

  const setBackend = async (backend: BackendId) => {
    setTested(null); // a verdict about one backend says nothing about the other
    await window.cth.updateConfig({ memoryBackend: backend });
    await refreshStatus();
  };
  const saveEndpoint = async () => {
    await window.cth.updateConfig({ hindsightUrl: url.trim(), hindsightBank: bank.trim() });
    await refreshStatus();
  };
  const testConnection = async () => {
    setTesting(true);
    setTested(null);
    try {
      await saveEndpoint();
      setTested(await window.cth.memoryTestConnection(url.trim(), bank.trim()));
    } finally {
      setTesting(false);
    }
  };

  const setModel = async (model: ModelId) => {
    await window.cth.updateConfig({ embeddingModel: model });
    await refreshStatus();
  };
  const toggleEnabled = async () => {
    await window.cth.updateConfig({ semanticMemory: !(status?.enabled ?? true) });
    await refreshStatus();
  };

  const run = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setResult('');
    try {
      const res = await window.cth.searchMemory(query.trim());
      setResult(res.ok ? (res.output || 'Nothing matched yet.') : `Couldn't search: ${res.error}`);
    } finally {
      setBusy(false);
    }
  };

  const active = status?.active;
  const pill = active ? `🧠 memory · ${status?.model}` : '🧠 memory';

  // One clear state line: is memory working, off, or not set up?
  const onServer = status?.backend === 'hindsight';
  const state: { dot: string; label: string } = !status?.available
    ? { dot: 'var(--cth-coral)', label: 'Not set up' }
    : !status.enabled
      ? { dot: 'var(--cth-ink-500)', label: 'Off' }
      : status.initialized
        ? { dot: 'var(--cth-mint)', label: 'On · ready' }
        : { dot: 'var(--cth-lemon)', label: 'On · getting ready…' };

  const canSearch = !!status?.available && !!status?.enabled;
  const testDot = tested ? (tested.ok ? 'var(--cth-mint)' : 'var(--cth-coral)') : 'var(--cth-ink-300)';

  return (
    <div style={{ position: 'absolute', bottom: 12, left: 12, width: open ? 380 : 'auto', zIndex: 40 }}>
      {!open ? (
        <button
          onClick={() => { setOpen(true); refreshStatus(); }}
          title="Search the shared memory your agents build up"
          style={{
            padding: '5px 10px 3px',
            background: active ? 'var(--cth-lemon-light)' : 'var(--cth-cream-200)',
            boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500)',
            fontFamily: 'var(--cth-font-ui)',
            fontSize: 12,
            color: 'var(--cth-ink-900)',
            cursor: 'pointer',
            border: 'none'
          }}
        >
          {pill}
        </button>
      ) : (
        <PixelPanel variant="dialog" title="HIVE MEMORY" noPadding>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 14 }}>

            {/* What this is — one plain line. */}
            <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: 1.5 }}>
              What your agents remember across sessions, shared between them. Search it by meaning, not just exact words.
            </div>

            {/* Status + on/off — the two things the user controls at a glance. */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--cth-ink-900)', fontFamily: 'var(--cth-font-ui)' }}>
                <span style={{ width: 9, height: 9, background: state.dot, boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }} />
                {state.label}
              </span>
              {status?.available && (
                <PixelButton
                  variant={status.enabled ? 'secondary' : 'primary'}
                  size="sm"
                  onClick={toggleEnabled}
                >
                  {status.enabled ? 'Turn off' : 'Turn on'}
                </PixelButton>
              )}
            </div>

            {/* Where memories are kept. Everything below keys off this choice. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-display)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                Where memories are kept
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                {BACKENDS.map((b) => {
                  const sel = (status?.backend ?? 'mempalace') === b.id;
                  return (
                    <button
                      key={b.id}
                      onClick={() => setBackend(b.id)}
                      style={{
                        flex: 1, textAlign: 'left', cursor: 'pointer', border: 'none',
                        padding: '7px 9px 6px',
                        background: sel ? 'var(--cth-lemon-light)' : 'var(--cth-cream-100)',
                        boxShadow: sel ? 'inset 0 0 0 1.5px var(--cth-ink-500)' : 'inset 0 0 0 1px var(--cth-ink-300)',
                        fontFamily: 'var(--cth-font-ui)'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--cth-ink-900)' }}>
                        <span style={{
                          width: 8, height: 8, flexShrink: 0,
                          background: sel ? 'var(--cth-ink-900)' : 'transparent',
                          boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
                        }} />
                        {b.title}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--cth-ink-500)', marginTop: 3 }}>{b.detail}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Server address. Switching backends re-mines every agent's notes
                into the new one, so this is a real move, not a view toggle. */}
            {onServer && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-display)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  Server
                </span>
                <input
                  value={url}
                  onChange={(e) => { setUrl(e.target.value); setTested(null); }}
                  onBlur={saveEndpoint}
                  placeholder="http://127.0.0.1:8888"
                  style={{
                    padding: '6px 8px 4px', background: 'var(--cth-paper-100)', border: 'none',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                    fontFamily: 'var(--cth-font-mono)', fontSize: 12, color: 'var(--cth-ink-900)', outline: 'none'
                  }}
                />
                <input
                  value={bank}
                  onChange={(e) => { setBank(e.target.value); setTested(null); }}
                  onBlur={saveEndpoint}
                  placeholder="hive-memory"
                  style={{
                    padding: '6px 8px 4px', background: 'var(--cth-paper-100)', border: 'none',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                    fontFamily: 'var(--cth-font-mono)', fontSize: 12, color: 'var(--cth-ink-900)', outline: 'none'
                  }}
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <PixelButton variant="secondary" size="sm" onClick={testConnection} disabled={testing}>
                    {testing ? 'Testing…' : 'Test connection'}
                  </PixelButton>
                </div>
                {/* Rendered straight off the probe's answer — its `url`, not the
                    input's, so an edited address can't inherit an old verdict. */}
                {tested && (
                  <div style={{
                    display: 'flex', gap: 7, alignItems: 'flex-start',
                    fontSize: 12, lineHeight: 1.5, color: 'var(--cth-ink-700)',
                    background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', padding: 8
                  }}>
                    <span style={{ width: 9, height: 9, marginTop: 3, flexShrink: 0, background: testDot, boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }} />
                    <span>
                      {tested.detail}
                      <div style={{ marginTop: 3, color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-mono)', fontSize: 11, wordBreak: 'break-all' }}>
                        {tested.url || '(no address)'} · {tested.bank || '(no bank)'}
                      </div>
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Not installed: show full self-sufficient setup so any machine can follow it. */}
            {!onServer && !status?.available && (
              <div style={{
                fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: 1.6,
                background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', padding: 10
              }}>
                Meaning-based search isn't installed yet.
                {/* The commands used to be inlined here, hardcoded for macOS
                    (`curl … | sh`, `source ~/.zshrc`) — dead text under cmd.exe or
                    PowerShell, on the platform most likely to be missing the tool.
                    Setup owns the platform-correct commands now, plus the uv
                    dependency, the live detected state, and the delegate-to-Michael
                    path. One source of truth beats two that disagree by OS. */}
                <div style={{ marginTop: 8 }}>
                  <PixelButton
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      // Prerequisites moved from a Command Center tab into
                      // Settings; requesting the old tab key is now a no-op that
                      // silently does nothing on click.
                      window.dispatchEvent(new CustomEvent('cth:open-settings', {
                        detail: { section: 'Prerequisites' }
                      }));
                      setOpen(false);
                    }}
                  >
                    set it up in Prerequisites →
                  </PixelButton>
                </div>
                <div style={{ marginTop: 8, color: 'var(--cth-ink-500)' }}>
                  Agents still keep plain notes without it.
                </div>
              </div>
            )}

            {/* Model: a benefit-framed choice, not a codename dump. Local only —
                a server owns its own embeddings. */}
            {!onServer && status?.available && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-display)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  Search language
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  {MODELS.map((m) => {
                    const sel = status.model === m.id;
                    return (
                      <button
                        key={m.id}
                        onClick={() => setModel(m.id)}
                        style={{
                          flex: 1, textAlign: 'left', cursor: 'pointer', border: 'none',
                          padding: '7px 9px 6px',
                          background: sel ? 'var(--cth-lemon-light)' : 'var(--cth-cream-100)',
                          boxShadow: sel ? 'inset 0 0 0 1.5px var(--cth-ink-500)' : 'inset 0 0 0 1px var(--cth-ink-300)',
                          fontFamily: 'var(--cth-font-ui)'
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--cth-ink-900)' }}>
                          <span style={{
                            width: 8, height: 8, flexShrink: 0,
                            background: sel ? 'var(--cth-ink-900)' : 'transparent',
                            boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
                          }} />
                          {m.title}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--cth-ink-500)', marginTop: 3 }}>{m.detail}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Search the memory. */}
            {canSearch && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') run(); }}
                    placeholder="Search by meaning…"
                    style={{
                      flex: 1, padding: '6px 8px 4px',
                      background: 'var(--cth-paper-100)', border: 'none',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                      fontFamily: 'var(--cth-font-ui)', fontSize: 13,
                      color: 'var(--cth-ink-900)', outline: 'none'
                    }}
                  />
                  <PixelButton variant="primary" size="sm" onClick={run} disabled={busy}>
                    {busy ? '…' : 'Search'}
                  </PixelButton>
                </div>
                {result && (
                  <pre style={{
                    margin: 0, maxHeight: '40vh', overflow: 'auto',
                    background: 'var(--cth-cream-100)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                    padding: 8, fontFamily: 'var(--cth-font-mono)', fontSize: 12,
                    whiteSpace: 'pre-wrap', color: 'var(--cth-ink-900)'
                  }}>{result}</pre>
                )}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid var(--cth-ink-300)', paddingTop: 10 }}>
              <PixelButton variant="ghost" size="sm" onClick={() => setOpen(false)}>Close</PixelButton>
            </div>
          </div>
        </PixelPanel>
      )}
    </div>
  );
}
