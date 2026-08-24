export const ACCOUNT_DELETION_RETRY_DELAY_MS = 100;
export const ACCOUNT_DELETION_MAX_PAGES_PER_ATTEMPT = 128;

interface AccountDeletionPayload {
  deleted?: unknown;
  deletionPending?: unknown;
  progressToken?: unknown;
  retryAfterMs?: unknown;
  error?: unknown;
}

interface AccountDeletionOptions {
  wait?: (delayMs: number) => Promise<void>;
  maxPages?: number;
}

const waitFor = (delayMs: number) => new Promise<void>(resolve => {
  globalThis.setTimeout(resolve, delayMs);
});

/** Follow the server's bounded deletion pages without a zero-delay request
 * loop. Progress tokens make a stuck server fail closed, while the page cap
 * leaves the durable server job available for a later retry. */
export async function finishAccountDeletion(
  deletePage: () => Promise<Response>,
  options: AccountDeletionOptions = {},
): Promise<void> {
  const wait = options.wait ?? waitFor;
  const maxPages = Math.max(1, Math.min(
    ACCOUNT_DELETION_MAX_PAGES_PER_ATTEMPT,
    Math.trunc(options.maxPages ?? ACCOUNT_DELETION_MAX_PAGES_PER_ATTEMPT),
  ));
  let previousProgressToken = '';
  for (let page = 0; page < maxPages; page++) {
    const response = await deletePage();
    const data = await response.json().catch(() => ({})) as AccountDeletionPayload;
    if (!response.ok) throw new Error(String(data.error || 'delete_unavailable'));
    if (data.deleted === true) return;
    if (response.status !== 202 || data.deletionPending !== true)
      throw new Error('delete_unavailable');
    const progressToken = String(data.progressToken || '');
    if (!progressToken || progressToken === previousProgressToken)
      throw new Error('delete_progress_stalled');
    previousProgressToken = progressToken;
    const requestedDelay = Number(data.retryAfterMs);
    const delayMs = Number.isFinite(requestedDelay)
      ? Math.max(ACCOUNT_DELETION_RETRY_DELAY_MS, Math.min(1_000, Math.trunc(requestedDelay)))
      : ACCOUNT_DELETION_RETRY_DELAY_MS;
    await wait(delayMs);
  }
  throw new Error('delete_resume_required');
}
