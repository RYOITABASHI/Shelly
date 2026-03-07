/** Generate a unique ID for messages, sessions, etc. */
let counter = 0;
export function generateId(): string {
  return `${Date.now()}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
