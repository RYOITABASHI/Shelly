/** A deliberately closed, BrowserPane-only alternative to general automation. */
export type BrowserPaneAction =
  | { kind: 'click'; selector: string }
  | { kind: 'fill'; selector: string; value: string }
  | { kind: 'extractText'; selector: string };

export interface BrowserPaneApprovalGrant {
  /** Set only after the existing capability broker approves the action. */
  approved: true;
  actionId: string;
}

export interface BrowserPaneActionRequest {
  action: BrowserPaneAction;
  urlAllowlist: readonly string[];
  approval: BrowserPaneApprovalGrant;
}

export interface BrowserPaneActionResult {
  actionId: string;
  kind: BrowserPaneAction['kind'];
  ok: boolean;
  /** Page-derived output is always untrusted at the next capability boundary. */
  tainted: true;
  text?: string;
  error?: string;
}

export interface BrowserPaneWebViewRef {
  injectJavaScript(script: string): void;
}

interface PendingAction {
  kind: BrowserPaneAction['kind'];
  resolve: (result: BrowserPaneActionResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const MESSAGE_PREFIX = 'shelly:browser-action:';

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/** Exact origin match; an allowlist path narrows access to that subtree. */
export function isBrowserUrlAllowlisted(currentUrl: string, allowlist: readonly string[]): boolean {
  const current = parseHttpUrl(currentUrl);
  if (!current) return false;
  return allowlist.some((entry) => {
    const allowed = parseHttpUrl(entry);
    if (!allowed || allowed.username || allowed.password || allowed.hash) return false;
    if (current.origin !== allowed.origin) return false;
    const path = allowed.pathname.replace(/\/+$/, '') || '/';
    return path === '/' || current.pathname === path || current.pathname.startsWith(`${path}/`);
  });
}

/**
 * Fixed templates only. JSON.stringify makes selector/value string literals;
 * no agent-provided value can become executable source.
 */
export function buildBrowserPaneActionScript(
  actionId: string,
  action: BrowserPaneAction,
  urlAllowlist: readonly string[],
): string {
  const id = JSON.stringify(actionId);
  const kind = JSON.stringify(action.kind);
  const selector = JSON.stringify(action.selector);
  const value = action.kind === 'fill' ? JSON.stringify(action.value) : 'null';
  const allowedUrls = JSON.stringify(urlAllowlist);
  return `
(function() {
  var actionId = ${id}, kind = ${kind}, selector = ${selector}, value = ${value}, allowedUrls = ${allowedUrls};
  var send = function(result) {
    window.ReactNativeWebView.postMessage(${JSON.stringify(MESSAGE_PREFIX)} + JSON.stringify(result));
  };
  try {
    var current = new URL(window.location.href);
    var allowed = allowedUrls.some(function(entry) {
      try {
        var target = new URL(entry);
        if (!/^https?:$/.test(target.protocol) || target.username || target.password || target.hash) return false;
        if (current.origin !== target.origin) return false;
        var path = target.pathname.replace(/\\/+$/, '') || '/';
        return path === '/' || current.pathname === path || current.pathname.indexOf(path + '/') === 0;
      } catch (_) { return false; }
    });
    if (!allowed) return send({actionId:actionId,kind:kind,ok:false,error:'Current WebView URL is not allowlisted.'});
    var element = document.querySelector(selector);
    if (!element) return send({actionId:actionId,kind:kind,ok:false,error:'Element not found.'});
    if (kind === 'click') {
      element.click();
      return send({actionId:actionId,kind:kind,ok:true});
    }
    if (kind === 'fill') {
      if (!('value' in element)) return send({actionId:actionId,kind:kind,ok:false,error:'Element is not fillable.'});
      var proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor && descriptor.set) descriptor.set.call(element, value);
      else element.value = value;
      element.dispatchEvent(new Event('input', {bubbles:true}));
      element.dispatchEvent(new Event('change', {bubbles:true}));
      return send({actionId:actionId,kind:kind,ok:true});
    }
    if (kind === 'extractText') {
      return send({actionId:actionId,kind:kind,ok:true,text:element.textContent || ''});
    }
    send({actionId:actionId,kind:kind,ok:false,error:'Unsupported action.'});
  } catch (error) {
    send({actionId:actionId,kind:kind,ok:false,error:error instanceof Error ? error.message : 'Browser action failed.'});
  }
})();
true;
`;
}

export class BrowserPaneAutomationController {
  private readonly pending = new Map<string, PendingAction>();

  constructor(
    private readonly getWebView: () => BrowserPaneWebViewRef | null,
    private readonly getCurrentUrl: () => string,
    private readonly timeoutMs = 10_000,
  ) {}

  execute(request: BrowserPaneActionRequest): Promise<BrowserPaneActionResult> {
    const { action, approval } = request;
    if (!approval?.approved || !approval.actionId) {
      return Promise.reject(new Error('Browser action requires an approval-broker grant.'));
    }
    if (!isBrowserUrlAllowlisted(this.getCurrentUrl(), request.urlAllowlist)) {
      return Promise.reject(new Error('Current WebView URL is not allowlisted.'));
    }
    if (action.kind !== 'click' && action.kind !== 'fill' && action.kind !== 'extractText') {
      return Promise.reject(new Error('Unsupported browser action.'));
    }
    if (!action.selector || action.selector.length > 2_048) {
      return Promise.reject(new Error('Invalid CSS selector.'));
    }
    if (action.kind === 'fill' && action.value.length > 100_000) {
      return Promise.reject(new Error('Fill value is too large.'));
    }
    if (this.pending.has(approval.actionId)) {
      return Promise.reject(new Error('Browser action id is already pending.'));
    }
    const webView = this.getWebView();
    if (!webView) return Promise.reject(new Error('Browser WebView is not available.'));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(approval.actionId);
        reject(new Error('Browser action timed out.'));
      }, this.timeoutMs);
      this.pending.set(approval.actionId, { kind: action.kind, resolve, reject, timer });
      webView.injectJavaScript(
        buildBrowserPaneActionScript(approval.actionId, action, request.urlAllowlist),
      );
    });
  }

  handleMessage(data: string): boolean {
    if (!data.startsWith(MESSAGE_PREFIX)) return false;
    try {
      const result = JSON.parse(data.slice(MESSAGE_PREFIX.length)) as BrowserPaneActionResult;
      const pending = result && this.pending.get(result.actionId);
      if (!pending || result.kind !== pending.kind || typeof result.ok !== 'boolean') return true;
      clearTimeout(pending.timer);
      this.pending.delete(result.actionId);
      pending.resolve({ ...result, tainted: true });
    } catch {}
    return true;
  }

  dispose(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Browser pane was closed.'));
    }
    this.pending.clear();
  }
}

const controllers = new Map<string, BrowserPaneAutomationController>();

export function registerBrowserPaneAutomation(
  paneId: string,
  controller: BrowserPaneAutomationController,
): () => void {
  if (!paneId) return () => {};
  controllers.set(paneId, controller);
  return () => {
    if (controllers.get(paneId) === controller) controllers.delete(paneId);
    controller.dispose();
  };
}

/** Integration point for the existing approval-gated shared executor. */
export function executeBrowserPaneAction(
  paneId: string,
  request: BrowserPaneActionRequest,
): Promise<BrowserPaneActionResult> {
  const controller = controllers.get(paneId);
  return controller
    ? controller.execute(request)
    : Promise.reject(new Error('Browser pane is not available.'));
}
