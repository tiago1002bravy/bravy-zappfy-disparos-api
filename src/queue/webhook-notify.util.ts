import axios from 'axios';

export async function notifyFailure(
  url: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await axios.post(url, payload, { timeout: 5_000 });
  } catch {
    // best-effort, sem retry
  }
}
