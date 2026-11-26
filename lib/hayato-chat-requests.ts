/**
 * lib/hayato-chat-requests.ts — file I/O for the `hayato://chat/<slug>` queue.
 *
 * The queue is `$HOME/.shelly/chat-requests.json` ({version, entries:[{id, slug, ts}]}),
 * read by the MCP server's read-only `read_chat_requests` tool. Display +
 * enqueue only (see lib/hayato-chat-link.ts): this module writes that one file
 * and does nothing else.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { CHAT_REQUESTS_DIR, CHAT_REQUESTS_FILE, createChatRequestQueue, type ChatRequestIo } from '@/lib/hayato-chat-link';

const DIR = `${FileSystem.documentDirectory}home/${CHAT_REQUESTS_DIR}`;
const FILE = `${DIR}/${CHAT_REQUESTS_FILE}`;

const fileIo: ChatRequestIo = {
  read: async () => FileSystem.readAsStringAsync(FILE).catch(() => null),
  write: async (text) => {
    await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
    const tmp = `${FILE}.tmp`;
    await FileSystem.writeAsStringAsync(tmp, text);
    await FileSystem.deleteAsync(FILE, { idempotent: true });
    await FileSystem.moveAsync({ from: tmp, to: FILE });
  },
};

let counter = 0;
const newId = () => `${Date.now().toString(36)}-${(counter++).toString(36)}`;

export const hayatoChatRequestQueue = createChatRequestQueue(fileIo, newId);
