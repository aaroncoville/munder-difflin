import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { PixelBadge } from './PixelBadge';
import { useStore, type AnswerAttachment } from '@/store/store';
import { withAttachedImages } from '@shared/attachedImages';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';
import { type HiveTask, type HumanQA, openQuestion, waitsOnHuman } from './TasksKanban';
import { compareByNewestAsk } from './askMeOrder';
import { isComposingKey } from '@shared/imeGuard';
import { useRtl } from '@/i18n/useDirection';

/**
 * ASK ME — first-class human feedback through the task system.
 *
 * Tasks the god can only move with the human's input sit here. An entry isn't
 * necessarily a question — it can be a TO-DO only the human can perform
 * (create an account, approve a purchase, provide credentials, test on a real
 * device). Each card shows the open ask, a place to respond (an answer, or a
 * "done, here's the result" confirmation), and the CASCADE of downstream
 * tasks stuck waiting on this one — so "why isn't X done?" reads as "ah,
 * because I still owe something here."
 *
 * An answer can carry images — paste a screenshot, drop a file, or pick one.
 * The bytes go straight to the main process, which decides where they land and
 * refuses anything that isn't an image; the answer then carries the paths it
 * got back, so the agent opens them with its own file tool.
 *
 * Sending an answer does two things:
 *   1. writes it into the card's humanQA entry in hive/tasks.json (the
 *      decision is documented ON the task, forever), and
 *   2. mails the god so it picks the answer up, unblocks the card, and the
 *      work continues — no separate HumanQuestion.md side-channel anymore.
 */

const POLL_MS = 5000;

function parse(raw: unknown): HiveTask[] {
  const list = (raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks))
    ? (raw as { tasks: HiveTask[] }).tasks
    : [];
  return list.filter((t) => !!t && typeof t === 'object');
}

/** Every file carried by a paste or a drop. `kind === 'file'` is the only
 *  filter — the file's NAME and declared type are caller data, so what these
 *  bytes really are is decided in the main process, not here. */
function filesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  return [...data.items]
    .map((item) => (item.kind === 'file' ? item.getAsFile() : null))
    .filter((f): f is File => f !== null);
}

/** The bytes as a data: URL, for the chip preview only. */
function thumbnailOf(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'));
    reader.readAsDataURL(file);
  });
}

/** All tasks transitively waiting on `id` (dependents chain), cycle-safe. */
function dependentsTree(id: string, all: HiveTask[], seen = new Set<string>()): HiveTask[] {
  if (seen.has(id)) return [];
  seen.add(id);
  const direct = all.filter((t) => Array.isArray(t.dependsOn) && t.dependsOn.includes(id) && t.status !== 'done');
  return direct.flatMap((d) => [d, ...dependentsTree(d.id, all, seen)]);
}

export function AskMeTab() {
  const { t: translate } = useTranslation();
  const rtl = useRtl();
  const agents = useStore((s) => s.agents);
  const restorable = useStore((s) => s.restorableAgents);
  const [tasks, setTasks] = useState<HiveTask[]>([]);
  // Drafts live in the STORE (keyed by task id) — switching tabs unmounts this
  // view, and a half-typed answer must survive the round trip.
  const drafts = useStore((s) => s.answerDrafts);
  const setAnswerDraft = useStore((s) => s.setAnswerDraft);
  const openTaskDetail = useStore((s) => s.openTaskDetail);
  const attachments = useStore((s) => s.answerAttachments);
  const addAttachment = useStore((s) => s.addAnswerAttachment);
  const removeAttachment = useStore((s) => s.removeAnswerAttachment);
  const clearAttachments = useStore((s) => s.clearAnswerAttachments);
  const [sending, setSending] = useState<string | null>(null);
  /** Per-card rejection message from the main process ("not an image", "too
   *  large") — silently dropping a file the user just pasted is the one thing
   *  worse than refusing it. */
  const [attachError, setAttachError] = useState<Record<string, string>>({});
  const [dropping, setDropping] = useState<string | null>(null);
  /** The attachment IPC still in flight for a card, if any — one chained
   *  promise per card, so `sendAnswer` has exactly one thing to wait on. */
  const pendingAttach = useRef<Record<string, Promise<void>>>({});
  /** The same fact as a render-visible count, so the send button can say so. */
  const [attaching, setAttaching] = useState<Record<string, number>>({});
  const pickers = useRef<Record<string, HTMLInputElement | null>>({});
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try { setTasks(parse(await window.cth.hiveTasks())); } catch { /* keep last good */ }
  }, []);

  useEffect(() => {
    refresh();
    timer.current = setInterval(refresh, POLL_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [refresh]);

  const nameFor = (id?: string): string | undefined =>
    id ? (agents.find((a) => a.id === id)?.name ?? restorable.find((a) => a.id === id)?.name ?? id) : undefined;

  // Newest ask at the top, oldest at the bottom. Before this the board had no
  // comparator at all, so a question's position was an accident of where its
  // card sat in tasks.json. `filter` already returns a fresh array, so sorting
  // in place never touches the store's own ordering. The ask each card is
  // ranked by comes from openQuestion() — the same predicate waitsOnHuman uses
  // — and only this OUTER list is sorted; a card's humanQA history stays
  // chronological (see askMeOrder.ts).
  const waiting = tasks
    .filter(waitsOnHuman)
    .sort((a, b) => compareByNewestAsk(openQuestion(a), openQuestion(b)));

  /**
   * Apply `patch` to the OPEN humanQA entry of one card, on the RAW ledger.
   * Returns whether it landed.
   *
   * Re-reads tasks.json first rather than writing this view's 5s-old snapshot,
   * because `hive:writeTasks` treats the incoming array as the card MEMBERSHIP:
   * writing our snapshot back would delete any card the god added since the last
   * poll. Re-locating the open question by its text also means an answer can
   * never land on a different question the god swapped in underneath us — in
   * that case nothing is written and the draft is kept.
   */

  /**
   * Store each pasted / dropped / picked file in the hive and keep the path the
   * main process chose. The renderer proposes no path and no name: it sends
   * bytes and is told where they went, or why they were refused.
   */
  const attach = (taskId: string, files: readonly File[]): Promise<void> => {
    if (files.length === 0) return Promise.resolve();
    setAttachError((prev) => ({ ...prev, [taskId]: '' }));
    setAttaching((prev) => ({ ...prev, [taskId]: (prev[taskId] ?? 0) + 1 }));
    const run = async (): Promise<void> => {
      try {
        for (const file of files) {
          try {
            const stored = await window.cth.askAttachImage(taskId, new Uint8Array(await file.arrayBuffer()));
            if (!stored.ok) {
              setAttachError((prev) => ({ ...prev, [taskId]: stored.error }));
              continue;
            }
            addAttachment(taskId, { path: stored.path, thumb: await thumbnailOf(file) } satisfies AnswerAttachment);
          } catch {
            setAttachError((prev) => ({ ...prev, [taskId]: 'that file could not be read' }));
          }
        }
      } finally {
        setAttaching((prev) => ({ ...prev, [taskId]: Math.max(0, (prev[taskId] ?? 1) - 1) }));
      }
    };
    // CHAINED, not raced: two pastes in a row keep their order in the answer,
    // and there is only ever one promise per card for `sendAnswer` to await.
    const chained = (pendingAttach.current[taskId] ?? Promise.resolve()).then(run);
    pendingAttach.current[taskId] = chained;
    void chained.finally(() => {
      // Only the LAST link clears the slot; an earlier one settling must not
      // make a still-running paste look finished.
      if (pendingAttach.current[taskId] === chained) delete pendingAttach.current[taskId];
    });
    return chained;
  };

  const sendAnswer = async (task: HiveTask) => {
    const open = openQuestion(task);
    if (!open || sending) return;
    // Storing an image is an IPC round trip and the human does not wait for it.
    // Whatever is still in flight is part of THIS answer: snapshotting now would
    // send the answer without it, clear the draft, and leave the image sitting in
    // the hive named by nothing — silently, since the upload itself succeeded.
    // Ctrl+Enter makes that the fast path, and no `disabled` prop covers a
    // keystroke, so the wait has to live here.
    const inFlight = pendingAttach.current[task.id];
    // A screenshot on its own is a complete answer to plenty of asks, so images
    // alone are enough to send.
    if (!inFlight && !(drafts[task.id] ?? '').trim() && (attachments[task.id]?.length ?? 0) === 0) return;
    setSending(task.id);
    try {
      if (inFlight) await inFlight;
      // Read the store, not the render closure: the attachment that just landed
      // is in the former and cannot be in the latter.
      const state = useStore.getState();
      const text = (state.answerDrafts[task.id] ?? '').trim();
      const images = state.answerAttachments[task.id] ?? [];
      if (!text && images.length === 0) return;
      // ONE answer string, used for both sinks below — see @shared/attachedImages.
      const answer = withAttachedImages(text, images.map((i) => i.path));
      // 1) Document the answer ON the card.
      const next = tasks.map((t) => {
        if (t.id !== task.id) return t;
        const qa = (t.humanQA ?? []).map((e) =>
          e === open || (e.q === open.q && !e.a)
            ? { ...e, a: answer, answeredAt: new Date().toISOString() }
            : e
        );
        return { ...t, humanQA: qa };
      });
      const updated = next.find((candidate) => candidate.id === task.id);
      const result = updated
        ? await window.cth.hivePatchTask(task.id, { humanQA: updated.humanQA })
        : { ok: false };
      if (!result.ok) throw new Error('task changed before answer could be saved');
      setTasks(next);
      // 2) Tell the god, so the card gets unblocked and work continues.
      await window.cth.hiveSend({
        to: 'god',
        act: 'inform',
        subject: `HUMAN ANSWER on task "${task.title}"`,
        body: [
          `The human answered the open question on task ${task.id} ("${task.title}"):`,
          `Q: ${open.q}`,
          `A: ${answer}`,
          'The answer is also recorded in the card\'s humanQA. Act on it, unblock the card, and continue the work.'
        ].join('\n')
      }, 'human');
      setAnswerDraft(task.id, '');
      clearAttachments(task.id);
    } catch {
      /* leave the draft so the user can retry */
    } finally {
      // ALWAYS, and in a finally rather than at the end: `sending` is what
      // rejects the next send, and it is one value for the whole board, so a
      // single path out of here that forgets to clear it wedges every card
      // until the view is remounted. The refused in-flight upload above is
      // exactly such a path — it leaves early with nothing to send, which is
      // correct, and being told "not an image" and retrying with a real one is
      // what the human does next.
      setSending(null);
    }
  };

  // Dismiss the open ask off the ASK ME board WITHOUT answering it. We mark the
  // open humanQA entry `dismissedAt` (no fabricated answer) so openQuestion()
  // stops returning it and the card leaves this view — the question itself stays
  // on the card, so the Q&A history is never dropped (protocol). The task stays
  // blocked on the kanban; the god can re-ask by appending a fresh humanQA entry.
  const dismiss = async (task: HiveTask) => {
    const open = openQuestion(task);
    if (!open || sending === task.id) return;
    const next = tasks.map((t) => {
      if (t.id !== task.id) return t;
      const qa = (t.humanQA ?? []).map((e) =>
        e === open || (e.q === open.q && !e.a && !e.dismissedAt)
          ? { ...e, dismissedAt: new Date().toISOString() }
          : e
      );
      return { ...t, humanQA: qa };
    });
    setTasks(next); // optimistic — the card disappears immediately
    try {
      const updated = next.find((candidate) => candidate.id === task.id);
      const result = updated
        ? await window.cth.hivePatchTask(task.id, { humanQA: updated.humanQA })
        : { ok: false };
      if (!result.ok) throw new Error('task changed before ask could be dismissed');
    } catch {
      setTasks(tasks); // restore on failure so the user can retry
    }
  };

  return (
    // Body text is set in the mono face (VT323) — the same readable font the
    // memory viewer uses. Pixelify Sans (font-ui) is too chunky for prose like
    // questions and answers. Display/badge bits keep their explicit faces.
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: 'var(--cth-paper-200)', padding: 10, display: 'flex', flexDirection: 'column', gap: 10, fontFamily: 'var(--cth-font-mono)' }}>
      {waiting.length === 0 && (
        <div style={{ textAlign: 'center', padding: '24px 12px', color: 'var(--cth-ink-500)', fontSize: 12 }}>
          {translate('askMe.emptyTitle')}<br />
          <span style={{ fontSize: 11, color: 'var(--cth-ink-300)' }}>
            {translate('askMe.emptySub')}
          </span>
        </div>
      )}
      {waiting.map((t) => {
        const open = openQuestion(t)!;
        const stuck = dependentsTree(t.id, tasks);
        return (
          <div key={t.id} style={{
            background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
            display: 'flex', flexDirection: 'column'
          }}>
            {/* header: title + assignee */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px',
              background: 'var(--cth-lilac-light, #ece2f5)', boxShadow: 'inset 0 -1px 0 var(--cth-ink-700)'
            }}>
              <button
                onClick={() => openTaskDetail(t.id)}
                title={translate('askMe.openDetail')}
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, textAlign: 'left',
                  fontFamily: 'var(--cth-font-mono)', fontSize: 15, color: 'var(--cth-ink-900)',
                  flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                }}
              >
                {t.title}
              </button>
              {nameFor(t.assignee) && <PixelBadge status="blocked" label={nameFor(t.assignee)!} />}
              {/* Dismiss — clears this ask off the board without answering it.
                  The card's Q&A history is preserved (the question stays on the
                  card, just marked dismissed). */}
              <button
                onClick={() => void dismiss(t)}
                disabled={sending === t.id}
                title={translate('askMe.dismissTitle')}
                aria-label={translate('askMe.dismissAria')}
                style={{
                  flexShrink: 0, width: 18, height: 18, padding: 0, marginLeft: 2,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
                  border: 'none', cursor: sending === t.id ? 'default' : 'pointer',
                  background: 'transparent', color: 'var(--cth-ink-500)',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 13
                }}
                onMouseEnter={(e) => { if (sending !== t.id) e.currentTarget.style.color = 'var(--cth-coral)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--cth-ink-500)'; }}
              >✕</button>
            </div>

            <div style={{ padding: 9, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* The question, rendered as markdown. The god writes these with
                  emphasis, lists, `code` and links; as plain text the asterisks
                  and backticks were on screen literally. The card variant keeps
                  this card's mono face and turns a single newline into a break, so
                  a question with no markdown in it looks exactly as it did. */}
              <div dir={rtl ? 'auto' : undefined} style={{ fontSize: 15, lineHeight: '19px', color: 'var(--cth-ink-900)' }}>
                <MarkdownPreview source={open.q} variant="card" />
              </div>

              {/* answer box — and the drop target for images, so a screenshot can
                  be dragged anywhere onto the answer rather than onto a hairline */}
              <div
                onDragOver={(e) => { e.preventDefault(); setDropping(t.id); }}
                onDragLeave={() => setDropping((d) => (d === t.id ? null : d))}
                onDrop={(e) => {
                  e.preventDefault();
                  setDropping(null);
                  void attach(t.id, filesFrom(e.dataTransfer));
                }}
                style={{
                  display: 'flex', flexDirection: 'column', gap: 6,
                  boxShadow: dropping === t.id ? 'inset 0 0 0 2px var(--cth-sky)' : 'none'
                }}
              >
                <textarea
                  dir={rtl ? 'auto' : undefined}
                  value={drafts[t.id] ?? ''}
                  onChange={(e) => setAnswerDraft(t.id, e.target.value)}
                  onKeyDown={(e) => { if (isComposingKey(e)) return; if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void sendAnswer(t); }}
                  onPaste={(e) => {
                    // A pasted screenshot arrives as a file on the clipboard; let
                    // ordinary text paste through untouched.
                    const pasted = filesFrom(e.clipboardData);
                    if (pasted.length === 0) return;
                    e.preventDefault();
                    void attach(t.id, pasted);
                  }}
                  rows={3}
                  placeholder="Your answer — or 'done', with the result… (paste or drop an image; Ctrl+Enter to send)"
                  style={{
                    width: '100%', boxSizing: 'border-box', padding: '6px 8px', resize: 'vertical',
                    background: 'var(--cth-paper-100)', border: 'none',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                    fontFamily: 'var(--cth-font-mono)', fontSize: 15, lineHeight: '18px',
                    color: 'var(--cth-ink-900)', outline: 'none'
                  }}
                />

                {/* what's attached so far — removable right up until send */}
                {(attachments[t.id]?.length ?? 0) > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {attachments[t.id].map((img) => (
                      <div
                        key={img.path}
                        title={img.path}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 4, padding: 2,
                          background: 'var(--cth-paper-100)',
                          boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
                        }}
                      >
                        <img
                          src={img.thumb}
                          alt=""
                          style={{ width: 28, height: 28, objectFit: 'cover', display: 'block' }}
                        />
                        <button
                          onClick={() => removeAttachment(t.id, img.path)}
                          title="remove this image from the answer"
                          aria-label="remove this image from the answer"
                          style={{
                            width: 16, height: 16, padding: 0, border: 'none', background: 'transparent',
                            cursor: 'pointer', lineHeight: 1, color: 'var(--cth-ink-500)',
                            fontFamily: 'var(--cth-font-ui)', fontSize: 11
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--cth-coral)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--cth-ink-500)'; }}
                        >✕</button>
                      </div>
                    ))}
                  </div>
                )}

                {/* why the last file was refused — never silently dropped */}
                {attachError[t.id] && (
                  <div style={{ fontSize: 12, color: 'var(--cth-coral)' }}>{attachError[t.id]}</div>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {/* Held while an image is still uploading — the answer would
                    otherwise be assembled before the path it needs comes back.
                    Ctrl+Enter bypasses this entirely, which is why sendAnswer
                    waits on the same promise rather than relying on it. */}
                <PixelButton
                  variant="primary" size="sm"
                  disabled={
                    (!(drafts[t.id] ?? '').trim() && (attachments[t.id]?.length ?? 0) === 0)
                    || sending === t.id || (attaching[t.id] ?? 0) > 0
                  }
                  onClick={() => void sendAnswer(t)}
                >
                  {sending === t.id ? translate('askMe.sending') : (attaching[t.id] ?? 0) > 0 ? 'attaching…' : translate('askMe.respond')}
                </PixelButton>
                <PixelButton
                  variant="secondary" size="sm"
                  disabled={sending === t.id}
                  title="attach a screenshot or image to this answer"
                  onClick={() => pickers.current[t.id]?.click()}
                >
                  attach image…
                </PixelButton>
                <input
                  ref={(el) => { pickers.current[t.id] = el; }}
                  type="file" accept="image/*" multiple hidden
                  onChange={(e) => {
                    void attach(t.id, [...(e.target.files ?? [])]);
                    e.target.value = ''; // so the same file can be picked twice
                  }}
                />
                {(t.humanQA?.filter((e) => e.a).length ?? 0) > 0 && (
                  <button
                    onClick={() => openTaskDetail(t.id)}
                    title={translate('askMe.viewAnswersHistory')}
                    style={{
                      border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
                      fontSize: 10, color: 'var(--cth-ink-700)', fontFamily: 'var(--cth-font-display)',
                      textDecoration: 'underline'
                    }}
                  >
                    {(() => {
                      const n = t.humanQA!.filter((e) => e.a).length;
                      return n === 1
                        ? translate('askMe.viewAnswers', { count: n })
                        : translate('askMe.viewAnswersPlural', { count: n });
                    })()}
                  </button>
                )}
              </div>

              {/* the cascade: what's stuck behind this answer */}
              {stuck.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-coral)' }}>
                    {stuck.length === 1
                      ? translate('askMe.blockingDownstream', { count: stuck.length })
                      : translate('askMe.blockingDownstreamPlural', { count: stuck.length })}
                  </div>
                  {stuck.slice(0, 6).map((d, i) => (
                    <div key={d.id} style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      paddingLeft: 8 + Math.min(i, 3) * 8,
                      fontSize: 12, color: 'var(--cth-ink-700)'
                    }}>
                      <span style={{ color: 'var(--cth-ink-300)' }}>└</span>
                      <span style={{ width: 7, height: 7, flexShrink: 0, background: d.status === 'blocked' ? 'var(--cth-coral)' : 'var(--cth-sky)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
                      {nameFor(d.assignee) && <span style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>({nameFor(d.assignee)})</span>}
                    </div>
                  ))}
                  {stuck.length > 6 && (
                    <div style={{ paddingLeft: 14, fontSize: 11, color: 'var(--cth-ink-300)' }}>{translate('askMe.more', { count: stuck.length - 6 })}</div>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
