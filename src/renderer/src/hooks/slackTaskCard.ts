import type { QueuedMessage } from '@/store/store';

// Promote a genuine Slack-origin work item to a stamped kanban card the first
// time it's dispatched to the office. The card carries slack:{channel,thread_ts}
// (origin thread) so the main-process done-observer can post its one summary
// reply in-thread once the card later reaches 'done'. ADDITIVE + idempotent +
// best-effort: a failure here never affects the dispatch that already happened,
// and only dispatched work items land here (slash commands/acks never do).
type SlackTaskCard = Parameters<typeof window.cth.hiveAddTask>[0];

export async function ensureSlackCard(m: QueuedMessage): Promise<void> {
  const slack = m.slack;
  if (!slack) return;
  try {
    const raw = await window.cth.hiveTasks();
    const existing: SlackTaskCard[] =
      raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks)
        ? (raw as { tasks: SlackTaskCard[] }).tasks
        : [];
    const id = `slack-${slack.thread_ts}-${m.id}`;
    if (existing.some((t) => t.id === id)) return; // already promoted — no dup
    const title = m.text.length > 80 ? `${m.text.slice(0, 79)}…` : m.text;
    const card: SlackTaskCard = {
      id,
      title,
      description: m.text,
      status: 'todo',
      dependsOn: [],
      priority: 1,
      createdAt: new Date().toISOString(),
      slack
    };
    await window.cth.hiveAddTask(card);
  } catch { /* best-effort: card promotion must never sink dispatch */ }
}
