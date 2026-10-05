/**
 * store/mcp-approval-store.ts — pending-approval queue for the MCP server's
 * exec/write tools (run_command / write_file, see lib/mcp-server-bridge.ts).
 *
 * A remote MCP client can't be trusted to gate itself, so every exec/write
 * call surfaces here and waits for a human tap in components/McpApprovalModal.tsx
 * — Approve/Deny resolves the pending promise the tool handler is awaiting.
 * Only one request is shown at a time; a second concurrent call queues
 * behind it rather than replacing it, so nothing is silently dropped.
 */
import { create } from 'zustand';

export interface McpApprovalRequest {
  id: string;
  kind: 'run_command' | 'write_file';
  /** Short one-line description shown as the modal title. */
  summary: string;
  /** Full command / path+content preview shown in the modal body. */
  detail: string;
  /** Risk label for run_command (from lib/command-safety.ts), if applicable. */
  riskLevel?: string;
  resolve: (approved: boolean) => void;
}

interface McpApprovalState {
  current: McpApprovalRequest | null;
  queue: McpApprovalRequest[];
  enqueue: (request: McpApprovalRequest) => void;
  respond: (id: string, approved: boolean) => void;
}

export const useMcpApprovalStore = create<McpApprovalState>((set, get) => ({
  current: null,
  queue: [],
  enqueue: (request) => {
    const { current, queue } = get();
    if (current) {
      set({ queue: [...queue, request] });
    } else {
      set({ current: request });
    }
  },
  respond: (id, approved) => {
    const { current, queue } = get();
    if (current?.id === id) {
      current.resolve(approved);
      const [next, ...rest] = queue;
      set({ current: next ?? null, queue: rest });
    } else {
      // Already resolved (e.g. timed out) — just drop it from the queue if still there.
      set({ queue: queue.filter((r) => r.id !== id) });
    }
  },
}));
