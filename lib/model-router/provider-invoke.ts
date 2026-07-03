// MODEL-001 model router — provider invocation port (DEFERRED).
//
// Interface-conformant skeleton only. The router SELECTS a model; it never calls
// providers or reads secrets. Actual invocation is a separate, deferred concern
// that, when wired (flag-ON cutover), must go through the CAP-001 capability
// broker so egress stays mediated and allowlisted. This file pulls NO network
// dependency at module load and is NOT re-exported from index.ts until cutover.

import { ModelCandidate } from './types';

const NOT_WIRED =
  'ModelInvoker is deferred until the MODEL-001 flag-ON cutover (egress must be broker-mediated)';

// Opaque request/response — the router does not define the wire format; the
// broker-backed implementation supplies it at cutover.
export interface ModelRequest {
  prompt: string;
  system?: string;
}
export interface ModelResponse {
  text: string;
}

export interface ModelInvoker {
  invoke(candidate: ModelCandidate, request: ModelRequest): Promise<ModelResponse>;
}

// Placeholder that refuses until wired. Never constructed by the dormant router.
export class UnwiredModelInvoker implements ModelInvoker {
  async invoke(_candidate: ModelCandidate, _request: ModelRequest): Promise<ModelResponse> {
    throw new Error(NOT_WIRED);
  }
}
