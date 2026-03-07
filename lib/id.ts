/** Generate a unique ID for messages, sessions, etc. */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
