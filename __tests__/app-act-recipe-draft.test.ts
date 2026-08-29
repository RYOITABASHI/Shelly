import {
  draftAppActRecipeFromSnapshot,
  buildAppActRecipeSaveCommand,
  slugifyAppActRecipeName,
  SAFE_USER_APP_ACT_RECIPE_ID_RE,
  type AppActSnapshot,
  type AppActRecipeDraft,
} from '@/lib/app-act-recipe-draft';

jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

function makeSnapshot(overrides: Partial<AppActSnapshot> = {}): AppActSnapshot {
  return {
    pkg: 'jp.naver.line.android',
    nodes: [
      {
        className: 'android.widget.EditText',
        resourceId: 'jp.naver.line.android:id/chat_ui_message_edit',
        contentDescription: '',
        text: '',
        clickable: false,
        editable: true,
        bounds: '0,100,500,150',
      },
      {
        className: 'android.widget.ImageButton',
        resourceId: 'jp.naver.line.android:id/chat_ui_send_button_image',
        contentDescription: 'Send',
        text: '',
        clickable: true,
        editable: false,
        bounds: '500,100,550,150',
      },
    ],
    ...overrides,
  };
}

describe('draftAppActRecipeFromSnapshot', () => {
  it('drafts a launch+setText+click recipe from a clean field+send-button snapshot', () => {
    const result = draftAppActRecipeFromSnapshot(makeSnapshot(), 'LINE quick reply') as AppActRecipeDraft;
    expect('error' in result).toBe(false);
    expect(result.id).toBe('user.line-quick-reply');
    expect(result.pkg).toBe('jp.naver.line.android');
    expect(result.tier).toBe('draft');
    expect(result.steps.map((s) => s.op)).toEqual(['launch', 'setText', 'click']);
    expect(result.steps[1].matcher).toEqual({ resourceId: 'jp.naver.line.android:id/chat_ui_message_edit' });
    expect(result.steps[2].matcher).toEqual({ resourceId: 'jp.naver.line.android:id/chat_ui_send_button_image' });
    expect(result.steps[1].param).toBe('text');
  });

  it('propagates the snapshot error unchanged when the capture itself failed', () => {
    const result = draftAppActRecipeFromSnapshot({ error: 'Accessibility Service is not enabled/connected' }, 'x');
    expect(result).toEqual({ error: 'Accessibility Service is not enabled/connected' });
  });

  it('errors when there is no screen data at all', () => {
    const result = draftAppActRecipeFromSnapshot({ pkg: 'jp.naver.line.android', nodes: [] }, 'x');
    expect('error' in result).toBe(true);
  });

  it('errors when no editable field is present', () => {
    const snapshot = makeSnapshot({
      nodes: [
        {
          className: 'android.widget.ImageButton',
          resourceId: 'x:id/send',
          contentDescription: 'Send',
          text: '',
          clickable: true,
          editable: false,
          bounds: '0,0,10,10',
        },
      ],
    });
    const result = draftAppActRecipeFromSnapshot(snapshot, 'x');
    expect(result).toMatchObject({ error: expect.stringContaining('editable') });
  });

  it('errors when no send-like clickable node is present', () => {
    const snapshot = makeSnapshot({
      nodes: [
        {
          className: 'android.widget.EditText',
          resourceId: 'x:id/field',
          contentDescription: '',
          text: '',
          clickable: false,
          editable: true,
          bounds: '0,0,10,10',
        },
        {
          className: 'android.widget.Button',
          resourceId: 'x:id/unrelated',
          contentDescription: 'Cancel',
          text: '',
          clickable: true,
          editable: false,
          bounds: '0,0,10,10',
        },
      ],
    });
    const result = draftAppActRecipeFromSnapshot(snapshot, 'x');
    expect(result).toMatchObject({ error: expect.stringContaining('send') });
  });

  it('falls back to contentDescription then text when resourceId is absent', () => {
    const snapshot = makeSnapshot({
      nodes: [
        {
          className: 'android.widget.EditText',
          resourceId: '',
          contentDescription: 'Message box',
          text: '',
          clickable: false,
          editable: true,
          bounds: '0,0,10,10',
        },
        {
          className: 'android.widget.Button',
          resourceId: '',
          contentDescription: '',
          text: '送信',
          clickable: true,
          editable: false,
          bounds: '0,0,10,10',
        },
      ],
    });
    const result = draftAppActRecipeFromSnapshot(snapshot, 'x') as AppActRecipeDraft;
    expect(result.steps[1].matcher).toEqual({ contentDescription: 'Message box' });
    expect(result.steps[2].matcher).toEqual({ text: '送信' });
  });
});

describe('slugifyAppActRecipeName', () => {
  it('lowercases, hyphenates, and strips punctuation', () => {
    expect(slugifyAppActRecipeName('LINE Quick Reply!')).toBe('line-quick-reply');
  });

  it('falls back to "recipe" for an empty/unusable name', () => {
    expect(slugifyAppActRecipeName('   ')).toBe('recipe');
    expect(slugifyAppActRecipeName('!!!')).toBe('recipe');
  });
});

describe('buildAppActRecipeSaveCommand', () => {
  const validDraft: AppActRecipeDraft = {
    id: 'user.line-quick-reply',
    pkg: 'jp.naver.line.android',
    operation: 'custom',
    displayName: 'LINE quick reply',
    tier: 'draft',
    params: [{ name: 'text', description: 'Message text', required: true }],
    steps: [
      { op: 'launch', target: 'jp.naver.line.android', intent: 'launch' },
      { op: 'setText', matcher: { resourceId: 'x:id/field' }, param: 'text', intent: 'type' },
      { op: 'click', matcher: { resourceId: 'x:id/send' }, intent: 'tap' },
    ],
  };

  it('builds a crash-safe write command targeting the user recipe namespace', () => {
    const cmd = buildAppActRecipeSaveCommand(validDraft);
    expect(cmd).toContain('set -e');
    expect(cmd).toContain('/home/shelly-test/.shelly/app-act-recipes');
    expect(cmd).toContain('user.line-quick-reply.json');
    expect(cmd).toContain('"id": "user.line-quick-reply"');
    expect(cmd).toMatch(/\[ -s .* \] \|\|/);
  });

  it('refuses to build a command for a non-"user."-prefixed id', () => {
    expect(() => buildAppActRecipeSaveCommand({ ...validDraft, id: 'line.send-message' })).toThrow(/unsafe id/);
  });

  it('refuses an id with unsafe characters even under the user. prefix', () => {
    expect(() => buildAppActRecipeSaveCommand({ ...validDraft, id: 'user.../../etc/passwd' })).toThrow(/unsafe id/);
  });
});

describe('SAFE_USER_APP_ACT_RECIPE_ID_RE', () => {
  it('accepts a well-formed user recipe id', () => {
    expect(SAFE_USER_APP_ACT_RECIPE_ID_RE.test('user.line-quick-reply_2')).toBe(true);
  });

  it('rejects a path-traversal attempt', () => {
    expect(SAFE_USER_APP_ACT_RECIPE_ID_RE.test('user./../../etc/passwd')).toBe(false);
  });

  it('rejects a bundled (non-user.) id', () => {
    expect(SAFE_USER_APP_ACT_RECIPE_ID_RE.test('line.send-message')).toBe(false);
  });
});
