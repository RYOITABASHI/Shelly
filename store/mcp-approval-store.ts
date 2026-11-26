/**
 * store/mcp-approval-store.ts — pending-approval queue for the MCP server's
 * exec/write tools (run_command / write_file) and the typed op run_agent (see
 * lib/mcp-server-bridge.ts).
 *
 * A remote MCP client can't be trusted to gate itself, so every exec/write
 * call surfaces here and waits for a human tap in components/McpApprovalModal.tsx
 * — Approve/Deny resolves the pending promise the tool handler is awaiting.
 * Only one request is shown at a time; a second concurrent call queues
 * behind it rather than replacing it, so nothing is silently dropped.
 *
 * Launcher ingress Phase 2 (C6, phase 2 fact sheet §5 D8): a pending launcher
 * submission is decided through THIS store and the same modal, with the same
 * three decisions (deny / once / always) — no second approval store and no
 * new decision kind. The only addition is `dismiss`: closing a launcher
 * prompt without deciding (the submission stays pending until its window
 * ends, P2-B2). It resolves nothing.
 */
import { create } from 'zustand';

/** The human's answer. `'always'` is only offered when the request is
 *  `alwaysAllowable`; writing the rule is the caller's job (never the modal's). */
export type McpApprovalDecision = 'deny' | 'once' | 'always';

export interface McpApprovalRequest {
  id: string;
  kind: 'run_command' | 'write_file' | 'stage_install' | 'update_delivery_script' | 'update_pipeline_config' | 'run_agent' | 'service_control' | 'request_pipeline_refire' | 'put_stream_feed' | 'submit_instruction';
  /** Short one-line description shown as the modal title. */
  summary: string;
  /** Full command / path+content preview shown in the modal body. */
  detail: string;
  /** Risk label for run_command (from lib/command-safety.ts), if applicable. */
  riskLevel?: string;
  /** Who sent it (DEFERRED.md MCP ingress Inc 2): the token principal and the
   *  client's self-reported, unverified name. Every MCP request is external. */
  origin?: { principal: string; clientNameSelfReported: string };
  /** Present only for typed operations that may be remembered: shows the
   *  "always allow" button and a scope line (op + target label). Raw tools
   *  (run_command / write_file) never set it. */
  alwaysAllowable?: { op: string; targetLabel: string };
  /** Launcher submissions only (kind 'submit_instruction'): the owner's own
   *  text is in `detail`; these are shown instead of the MCP origin lines. */
  launcher?: { submissionId: string; sentAt: number; expiresAt: number; untrusted: boolean };
  /** Called instead of `resolve` when the prompt is closed without a decision (dismiss). */
  onDismiss?: () => void;
  resolve: (decision: McpApprovalDecision) => void;
}

interface McpApprovalState {
  current: McpApprovalRequest | null;
  queue: McpApprovalRequest[];
  enqueue: (request: McpApprovalRequest) => void;
  respond: (id: string, decision: McpApprovalDecision) => void;
  /** Closes the request without a decision (launcher prompts: it stays pending). Resolves nothing. */
  dismiss: (id: string) => void;
  /** Denies the shown request and every queued one, closing the modal
   *  (MCP token regeneration: nothing accepted under the old token may
   *  still be approvable). */
  denyAll: () => void;
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
  respond: (id, decision) => {
    const { current, queue } = get();
    if (current?.id === id) {
      current.resolve(decision);
      const [next, ...rest] = queue;
      set({ current: next ?? null, queue: rest });
    } else {
      // Already resolved (e.g. timed out) — just drop it from the queue if still there.
      set({ queue: queue.filter((r) => r.id !== id) });
    }
  },
  dismiss: (id) => {
    const { current, queue } = get();
    const target = current?.id === id ? current : queue.find((r) => r.id === id);
    if (current?.id === id) {
      const [next, ...rest] = queue;
      set({ current: next ?? null, queue: rest });
    } else {
      set({ queue: queue.filter((r) => r.id !== id) });
    }
    try {
      target?.onDismiss?.();
    } catch {
      // closing never fails
    }
  },
  denyAll: () => {
    const { current, queue } = get();
    // Clear first so the modal closes even if a resolver throws.
    set({ current: null, queue: [] });
    for (const request of current ? [current, ...queue] : queue) {
      try {
        // A launcher submission is not under the MCP token: closed, not denied.
        if (request.kind === 'submit_instruction') request.onDismiss?.();
        else request.resolve('deny');
      } catch {
        // keep denying the rest
      }
    }
  },
}));
