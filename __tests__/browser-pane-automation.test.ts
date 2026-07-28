import {
  BrowserPaneAutomationController,
  buildBrowserPaneActionScript,
  type BrowserPaneAction,
} from '@/lib/browser-pane-automation';

const approval = (actionId: string) => ({ approved: true as const, actionId });

describe('BrowserPane scoped automation safety boundary', () => {
  it('rejects when the current URL is not allowlisted', async () => {
    const webView = { injectJavaScript: jest.fn() };
    const controller = new BrowserPaneAutomationController(
      () => webView,
      () => 'https://evil.example/account',
    );
    await expect(controller.execute({
      action: { kind: 'click', selector: '#submit' },
      urlAllowlist: ['https://trusted.example'],
      approval: approval('deny-1'),
    })).rejects.toThrow('not allowlisted');
    expect(webView.injectJavaScript).not.toHaveBeenCalled();
  });

  it('has no raw-script action and quotes hostile selector/value input', () => {
    const hostile = `"); window.__rawAgentCodeExecuted = true; ("`;
    const actions: BrowserPaneAction[] = [
      { kind: 'click', selector: hostile },
      { kind: 'fill', selector: '#field', value: hostile },
      { kind: 'extractText', selector: '.result' },
    ];
    for (const [index, action] of actions.entries()) {
      const script = buildBrowserPaneActionScript(`safe-${index}`, action, ['https://trusted.example']);
      expect(script).toContain(`kind = ${JSON.stringify(action.kind)}`);
      expect(script).not.toContain(`selector = ${hostile}`);
      if (action.kind === 'fill') expect(script).not.toContain(`value = ${hostile}`);
    }
    expect(buildBrowserPaneActionScript.toString()).not.toMatch(/\beval\b|new Function/);
  });

  it.each([
    ['click', { kind: 'click', selector: '#go' } as const, { ok: true }],
    ['fill', { kind: 'fill', selector: 'input[name=email]', value: 'a@example.com' } as const, { ok: true }],
    ['extractText', { kind: 'extractText', selector: '.headline' } as const, { ok: true, text: 'Hello' }],
  ])('executes %s using the fixed template on an allowlisted mocked WebView', async (kind, action, outcome) => {
    let controller: BrowserPaneAutomationController;
    const webView = {
      injectJavaScript: jest.fn((script: string) => {
        expect(script).toContain('document.querySelector(selector)');
        expect(script).toContain(`kind = ${JSON.stringify(kind)}`);
        queueMicrotask(() => controller.handleMessage(
          `shelly:browser-action:${JSON.stringify({ actionId: `ok-${kind}`, kind, ...outcome })}`,
        ));
      }),
    };
    controller = new BrowserPaneAutomationController(
      () => webView,
      () => 'https://trusted.example/app/page',
    );
    await expect(controller.execute({
      action,
      urlAllowlist: ['https://trusted.example/app'],
      approval: approval(`ok-${kind}`),
    })).resolves.toMatchObject({ actionId: `ok-${kind}`, kind, tainted: true, ...outcome });
  });

  it('requires an approval-broker grant before injection', async () => {
    const webView = { injectJavaScript: jest.fn() };
    const controller = new BrowserPaneAutomationController(
      () => webView,
      () => 'https://trusted.example',
    );
    await expect(controller.execute({
      action: { kind: 'extractText', selector: 'body' },
      urlAllowlist: ['https://trusted.example'],
      approval: undefined as never,
    })).rejects.toThrow('approval-broker grant');
    expect(webView.injectJavaScript).not.toHaveBeenCalled();
  });

  it('fails closed for an unknown runtime action kind instead of injecting it', async () => {
    const webView = { injectJavaScript: jest.fn() };
    const controller = new BrowserPaneAutomationController(
      () => webView,
      () => 'https://trusted.example',
    );
    await expect(controller.execute({
      action: { kind: 'script', selector: 'body', source: 'alert(1)' } as never,
      urlAllowlist: ['https://trusted.example'],
      approval: approval('raw-1'),
    })).rejects.toThrow('Unsupported browser action');
    expect(webView.injectJavaScript).not.toHaveBeenCalled();
  });
});
