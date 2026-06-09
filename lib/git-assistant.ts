/**
 * lib/git-assistant.ts — 自然言語Gitアシスタント
 *
 * Git初心者を自然言語で丁寧にガイドする。
 * 「コミットしたい」「変更を戻したい」等の自然言語 → 状況に応じたステップバイステップ解説。
 *
 * 設計:
 * - @git mention で起動
 * - まず git status 等で状況を把握
 * - 初心者向けに日本語で丁寧に解説
 * - 実行可能なコマンドをアクションボタンで提示
 */

// ─── Intent Detection ──────────────────────────────────────────────────────────

export type GitIntent =
  | 'commit'       // コミットしたい
  | 'push'         // プッシュしたい
  | 'pull'         // プルしたい
  | 'branch'       // ブランチ関連
  | 'merge'        // マージしたい
  | 'undo'         // 変更を戻したい
  | 'status'       // 状況を見たい
  | 'log'          // 履歴を見たい
  | 'diff'         // 差分を見たい
  | 'stash'        // 一時退避
  | 'clone'        // リポジトリをクローン
  | 'init'         // リポジトリを初期化
  | 'conflict'     // コンフリクト解決
  | 'tag'          // タグ関連
  | 'remote'       // リモート関連
  | 'help'         // 一般的なヘルプ
  | 'unknown';

/** コアインテント: アプリ側でガイドUIを出す対象（5つに厳選） */
const CORE_INTENTS: Set<GitIntent> = new Set(['commit', 'push', 'status', 'diff', 'help']);

type IntentPattern = {
  intent: GitIntent;
  patterns: RegExp[];
};

const INTENT_PATTERNS: IntentPattern[] = [
  {
    intent: 'commit',
    patterns: [
      /コミット/i, /commit/i, /保存/i, /記録/i, /変更を(確定|登録)/i,
      /セーブ/i, /save/i,
    ],
  },
  {
    intent: 'push',
    patterns: [
      /プッシュ/i, /push/i, /アップロード/i, /送信/i, /githubに/i,
      /リモートに/i, /上げ(たい|て)/i,
    ],
  },
  {
    intent: 'pull',
    patterns: [
      /プル/i, /pull/i, /取得/i, /ダウンロード/i, /最新(を|に|化)/i,
      /同期/i, /fetch/i,
    ],
  },
  {
    intent: 'branch',
    patterns: [
      /ブランチ/i, /branch/i, /枝/i, /切(りたい|って|り替え)/i,
      /新しい機能/i, /フィーチャー/i, /feature/i, /switch/i, /checkout/i,
    ],
  },
  {
    intent: 'merge',
    patterns: [
      /マージ/i, /merge/i, /統合/i, /合流/i, /取り込/i,
    ],
  },
  {
    intent: 'undo',
    patterns: [
      /戻(したい|して|す)/i, /取り消/i, /キャンセル/i, /元に戻/i,
      /undo/i, /revert/i, /reset/i, /やり直/i, /なかったことに/i,
      /間違え/i, /ミス/i, /変更を(消|削除)/i,
    ],
  },
  {
    intent: 'status',
    patterns: [
      /状態/i, /状況/i, /status/i, /今どうなっ/i, /確認/i,
      /何が変わ/i, /変更(ファイル|一覧)/i,
    ],
  },
  {
    intent: 'log',
    patterns: [
      /履歴/i, /ログ/i, /log/i, /history/i, /過去/i, /コミット(一覧|履歴)/i,
    ],
  },
  {
    intent: 'diff',
    patterns: [
      /差分/i, /diff/i, /何が変わ/i, /変更(内容|点)/i, /比較/i,
    ],
  },
  {
    intent: 'stash',
    patterns: [
      /一時(退避|保存)/i, /stash/i, /後で/i, /とっておい/i, /退避/i,
    ],
  },
  {
    intent: 'clone',
    patterns: [
      /クローン/i, /clone/i, /ダウンロード.*リポ/i, /リポ.*コピー/i,
    ],
  },
  {
    intent: 'init',
    patterns: [
      /初期化/i, /init/i, /新しいリポ/i, /git.*始め/i, /リポ.*作/i,
    ],
  },
  {
    intent: 'conflict',
    patterns: [
      /コンフリクト/i, /conflict/i, /競合/i, /衝突/i, /かぶっ/i,
    ],
  },
  {
    intent: 'tag',
    patterns: [
      /タグ/i, /tag/i, /バージョン/i, /version/i, /リリース/i, /release/i,
    ],
  },
  {
    intent: 'remote',
    patterns: [
      /リモート/i, /remote/i, /origin/i, /接続先/i, /github.*設定/i,
    ],
  },
  {
    intent: 'help',
    patterns: [
      /ヘルプ/i, /help/i, /使い方/i, /わからない/i, /教えて/i,
      /how/i, /基本/i, /初心者/i, /始め方/i, /チュートリアル/i,
    ],
  },
];

/**
 * ユーザー入力からGitの意図を検出する。
 */
export function detectGitIntent(input: string): GitIntent {
  const lower = input.toLowerCase();
  for (const { intent, patterns } of INTENT_PATTERNS) {
    if (patterns.some((p) => p.test(lower))) {
      return intent;
    }
  }
  return 'unknown';
}

// ─── Guide Generation ──────────────────────────────────────────────────────────

export type GitGuideStep = {
  /** ステップの説明（日本語） */
  explanation: string;
  /** 実行するコマンド（ワンタップ実行用） */
  command?: string;
  /** このステップの種類 */
  type: 'info' | 'command' | 'warning' | 'tip';
};

export type GitGuide = {
  /** ガイドタイトル */
  title: string;
  /** ガイド概要（初心者向け解説） */
  overview: string;
  /** ステップ一覧 */
  steps: GitGuideStep[];
  /** まず実行すべき調査コマンド（自動実行用） */
  prereqCommand?: string;
};

/**
 * Gitの意図に基づいて、初心者向けガイドを生成する。
 * prereqCommand は自動実行され、結果に基づいて追加のガイドが出る。
 */
export function generateGuide(intent: GitIntent, userInput: string): GitGuide {
  // コアインテント以外はLLMに委譲する案内を返す
  if (!CORE_INTENTS.has(intent) && intent !== 'unknown') {
    return {
      title: `Git: ${intent}`,
      overview:
        `「${userInput}」は高度なGit操作です。\n` +
        `AIエージェントに任せるとより正確にガイドできます。`,
      steps: [
        {
          type: 'tip',
          explanation:
            '以下のように聞いてみてください:\n' +
            `  @codex ${userInput}\n` +
            `  @perplexity ${userInput}\n\n` +
            'AIがGitの状態を確認しながら最適な手順を教えてくれます。',
        },
        {
          type: 'command',
          explanation: 'まずは現在の状態を確認:',
          command: 'git status',
        },
      ],
    };
  }

  switch (intent) {
    case 'commit':
      return {
        title: 'コミット（変更の記録）',
        overview:
          'コミットは「今の変更をセーブポイントとして保存する」操作です。\n' +
          'ゲームのセーブと同じで、いつでもこの時点に戻れるようになります。',
        prereqCommand: 'git status',
        steps: [
          {
            type: 'info',
            explanation: 'まず、どのファイルが変更されているか確認しましょう。\n上の git status の結果を見てください。',
          },
          {
            type: 'command',
            explanation:
              '変更したファイルを「ステージ」に追加します。\n' +
              'ステージ = 「次のコミットに含めるファイルの控え室」です。\n' +
              '全ファイルを追加する場合:',
            command: 'git add .',
          },
          {
            type: 'tip',
            explanation:
              '特定のファイルだけ追加したい場合:\n' +
              '  git add ファイル名\n' +
              '  git add src/  (フォルダ単位もOK)',
          },
          {
            type: 'command',
            explanation:
              'コミットメッセージを付けて保存します。\n' +
              'メッセージは「何を変えたか」を短く書きましょう。\n' +
              '例: 「ログイン画面のデザインを修正」',
            command: 'git commit -m "変更内容をここに書く"',
          },
          {
            type: 'tip',
            explanation:
              'コミットメッセージのコツ:\n' +
              '  - 「〇〇を修正」「〇〇を追加」のように動詞で始める\n' +
              '  - 50文字以内が理想\n' +
              '  - 英語なら "Fix login bug" のように命令形',
          },
        ],
      };

    case 'push':
      return {
        title: 'プッシュ（リモートに送信）',
        overview:
          'プッシュは「ローカルのコミットをGitHub等のリモートに送る」操作です。\n' +
          'チームメンバーがあなたの変更を見られるようになります。',
        prereqCommand: 'git status && git log --oneline -3',
        steps: [
          {
            type: 'info',
            explanation: 'プッシュ前に確認:\n  - コミットしていない変更はありませんか？\n  - 正しいブランチにいますか？',
          },
          {
            type: 'command',
            explanation: '現在のブランチをリモート（origin）にプッシュします。',
            command: 'git push origin HEAD',
          },
          {
            type: 'tip',
            explanation:
              '初めてプッシュする場合:\n' +
              '  git push -u origin ブランチ名\n' +
              '「-u」を付けると、次回から「git push」だけでOKになります。',
          },
          {
            type: 'warning',
            explanation: 'プッシュ拒否された場合:\n  リモートに新しい変更がある可能性があります。\n  まず「git pull」で最新を取得してください。',
          },
        ],
      };

    case 'pull':
      return {
        title: 'プル（最新を取得）',
        overview:
          'プルは「リモート（GitHub等）の最新変更を手元に取り込む」操作です。\n' +
          'チームメンバーの変更を自分の環境に反映できます。',
        prereqCommand: 'git status',
        steps: [
          {
            type: 'info',
            explanation: 'プル前に:\n  - コミットしていない変更がある場合、先にコミットするかstashしましょう。\n  - 未コミットの変更があるとコンフリクトの原因になります。',
          },
          {
            type: 'command',
            explanation: 'リモートの最新を取得してマージします。',
            command: 'git pull',
          },
          {
            type: 'tip',
            explanation: 'コンフリクト（競合）が起きた場合:\n  「@git コンフリクト解決」と聞いてください。丁寧にガイドします。',
          },
        ],
      };

    case 'branch':
      return {
        title: 'ブランチ（作業の分岐）',
        overview:
          'ブランチは「メインの流れとは別に、安全に作業できる枝」です。\n' +
          '新機能やバグ修正を、他の人の作業に影響を与えずに進められます。',
        prereqCommand: 'git branch -a',
        steps: [
          {
            type: 'info',
            explanation: '上の結果で「*」がついているのが今いるブランチです。',
          },
          {
            type: 'command',
            explanation: '新しいブランチを作って、そこに移動します。\n名前は「feature/〇〇」が慣習です。',
            command: 'git checkout -b feature/新機能名',
          },
          {
            type: 'tip',
            explanation:
              'ブランチ名のコツ:\n' +
              '  feature/login-page  → 新機能\n' +
              '  fix/header-bug      → バグ修正\n' +
              '  hotfix/security     → 緊急修正',
          },
          {
            type: 'command',
            explanation: '既存のブランチに切り替える場合:',
            command: 'git checkout ブランチ名',
          },
          {
            type: 'warning',
            explanation: 'ブランチ切替前に:\n  未コミットの変更があると切替できません。\n  先にコミットするか、stashしてください。',
          },
        ],
      };

    case 'merge':
      return {
        title: 'マージ（ブランチの統合）',
        overview:
          'マージは「別ブランチの変更を今のブランチに取り込む」操作です。\n' +
          '機能が完成したら、mainブランチにマージします。',
        prereqCommand: 'git branch && git status',
        steps: [
          {
            type: 'info',
            explanation: 'まず、マージ先のブランチ（例: main）に移動します。',
          },
          {
            type: 'command',
            explanation: 'mainブランチに移動:',
            command: 'git checkout main',
          },
          {
            type: 'command',
            explanation: '作業ブランチの内容をmainに取り込みます。',
            command: 'git merge ブランチ名',
          },
          {
            type: 'tip',
            explanation: 'マージ後、不要になったブランチは削除できます:\n  git branch -d ブランチ名',
          },
        ],
      };

    case 'undo':
      return {
        title: '変更の取り消し',
        overview:
          'Gitでは色々な「元に戻す」方法があります。\n' +
          '状況によって使うコマンドが違うので、まず状況を確認しましょう。',
        prereqCommand: 'git status && git log --oneline -5',
        steps: [
          {
            type: 'info',
            explanation:
              'どの段階の変更を戻したいですか？\n\n' +
              '1. まだコミットしていない変更を戻す\n' +
              '   → 下の「ファイルを元に戻す」を使用\n\n' +
              '2. ステージに追加した変更を取り消す\n' +
              '   → 「ステージ解除」を使用\n\n' +
              '3. 直前のコミットを取り消す\n' +
              '   → 「コミット取消し」を使用',
          },
          {
            type: 'command',
            explanation: '【1】特定ファイルの変更を元に戻す:\n  (コミット前の編集内容が消えます!)',
            command: 'git checkout -- ファイル名',
          },
          {
            type: 'command',
            explanation: '【2】ステージから取り消す（ファイルの変更は残る）:',
            command: 'git reset HEAD ファイル名',
          },
          {
            type: 'command',
            explanation: '【3】直前のコミットを取り消す（変更は残す）:',
            command: 'git reset --soft HEAD~1',
          },
          {
            type: 'warning',
            explanation:
              '注意: 「git reset --hard」は変更が完全に消えます!\n' +
              '初心者には「--soft」が安全です（変更はステージに残ります）。',
          },
        ],
      };

    case 'status':
      return {
        title: '現在の状況を確認',
        overview: 'git status で、どのファイルが変更・追加・削除されているか確認できます。',
        prereqCommand: 'git status',
        steps: [
          {
            type: 'info',
            explanation:
              '結果の読み方:\n\n' +
              '赤色のファイル → まだステージに追加していない変更\n' +
              '緑色のファイル → ステージ済み（次のコミットに含まれる）\n' +
              '「Untracked files」→ Gitが追跡していない新規ファイル',
          },
          {
            type: 'tip',
            explanation: 'よく使うコマンド:\n  git status -s  (短い表示)\n  git diff       (変更内容を詳しく見る)',
          },
        ],
      };

    case 'log':
      return {
        title: 'コミット履歴を確認',
        overview: 'これまでのコミット（変更の記録）を一覧で見られます。',
        prereqCommand: 'git log --oneline -10',
        steps: [
          {
            type: 'info',
            explanation: '各行は1つのコミットです。\n左の英数字はコミットID（固有の識別番号）です。',
          },
          {
            type: 'command',
            explanation: 'もっと詳しく見たい場合:',
            command: 'git log --oneline --graph --all -20',
          },
          {
            type: 'tip',
            explanation: '特定のコミットの詳細:\n  git show コミットID\n  (IDは最初の7文字だけでもOK)',
          },
        ],
      };

    case 'diff':
      return {
        title: '変更内容の確認',
        overview: 'どのファイルの何行目がどう変わったか、詳しく確認できます。',
        prereqCommand: 'git diff --stat',
        steps: [
          {
            type: 'command',
            explanation: '全ての変更内容を表示:',
            command: 'git diff',
          },
          {
            type: 'command',
            explanation: 'ステージ済みの変更を表示:',
            command: 'git diff --cached',
          },
          {
            type: 'tip',
            explanation:
              '差分の読み方:\n' +
              '  緑色（+）→ 追加された行\n' +
              '  赤色（-）→ 削除された行\n' +
              '  白色     → 変更なし（前後の文脈）',
          },
        ],
      };

    case 'stash':
      return {
        title: 'Stash（一時退避）',
        overview:
          'stashは「今の作業を一時的にしまっておく」機能です。\n' +
          'ブランチ切替前に、まだコミットしたくない変更を退避できます。',
        prereqCommand: 'git stash list',
        steps: [
          {
            type: 'command',
            explanation: '現在の変更を一時退避:',
            command: 'git stash',
          },
          {
            type: 'command',
            explanation: '退避した変更を戻す:',
            command: 'git stash pop',
          },
          {
            type: 'tip',
            explanation: '名前付きで退避:\n  git stash push -m "ログイン画面の途中"\n\n一覧を確認:\n  git stash list',
          },
        ],
      };

    case 'clone':
      return {
        title: 'クローン（リポジトリのコピー）',
        overview: 'GitHubなどのリモートリポジトリを、手元にコピーします。',
        steps: [
          {
            type: 'command',
            explanation: 'リポジトリをクローン:\n  URLはGitHubのリポジトリページからコピーできます。',
            command: 'git clone https://github.com/ユーザー/リポジトリ.git',
          },
          {
            type: 'tip',
            explanation: 'クローン後は自動的にそのフォルダに入ります:\n  cd リポジトリ名',
          },
        ],
      };

    case 'init':
      return {
        title: 'リポジトリの初期化',
        overview: '今いるフォルダをGitリポジトリにします。\n新しいプロジェクトを始める時に使います。',
        steps: [
          {
            type: 'command',
            explanation: 'Gitリポジトリを初期化:',
            command: 'git init',
          },
          {
            type: 'command',
            explanation: '最初のコミットを作成:',
            command: 'git add . && git commit -m "Initial commit"',
          },
          {
            type: 'tip',
            explanation:
              '.gitignore ファイルを作ると、Git管理から除外するファイルを指定できます:\n' +
              '  例: node_modules/ や .env など',
          },
        ],
      };

    case 'conflict':
      return {
        title: 'コンフリクト（競合）の解決',
        overview:
          'コンフリクトは「同じファイルの同じ場所を2人が編集した時」に起きます。\n' +
          'Gitが自動でマージできない部分を、手動で解決する必要があります。',
        prereqCommand: 'git status',
        steps: [
          {
            type: 'info',
            explanation:
              'コンフリクトが起きたファイルには以下のマークが入ります:\n\n' +
              '<<<<<<< HEAD\n' +
              '  (あなたの変更)\n' +
              '=======\n' +
              '  (相手の変更)\n' +
              '>>>>>>> ブランチ名\n\n' +
              'この部分を手動で編集して、正しい内容に書き換えます。',
          },
          {
            type: 'command',
            explanation: '解決後、ファイルをステージに追加:',
            command: 'git add .',
          },
          {
            type: 'command',
            explanation: 'マージを完了:',
            command: 'git commit -m "Merge conflict resolved"',
          },
          {
            type: 'tip',
            explanation: 'コンフリクトを避けるコツ:\n  - こまめにpull/pushする\n  - 小さい単位でコミットする\n  - チームでファイル担当を分ける',
          },
        ],
      };

    case 'tag':
      return {
        title: 'タグ（バージョン管理）',
        overview: 'タグはコミットに「v1.0.0」のようなラベルを付ける機能です。\nリリース時に使います。',
        prereqCommand: 'git tag',
        steps: [
          {
            type: 'command',
            explanation: 'タグを作成:',
            command: 'git tag v1.0.0',
          },
          {
            type: 'command',
            explanation: 'メッセージ付きタグ（推奨）:',
            command: 'git tag -a v1.0.0 -m "バージョン1.0.0リリース"',
          },
          {
            type: 'command',
            explanation: 'タグをリモートにプッシュ:',
            command: 'git push origin --tags',
          },
        ],
      };

    case 'remote':
      return {
        title: 'リモート設定',
        overview: 'リモートは「GitHub等の接続先」のことです。\n通常「origin」という名前で設定されます。',
        prereqCommand: 'git remote -v',
        steps: [
          {
            type: 'info',
            explanation: '上の結果に何も表示されなければ、まだリモートが設定されていません。',
          },
          {
            type: 'command',
            explanation: 'リモートを追加:',
            command: 'git remote add origin https://github.com/ユーザー/リポジトリ.git',
          },
          {
            type: 'command',
            explanation: 'リモートURLを変更:',
            command: 'git remote set-url origin 新しいURL',
          },
        ],
      };

    case 'help':
      return {
        title: 'Git ガイド',
        overview:
          'Gitは「ファイルの変更履歴を管理するツール」です。\n' +
          'セーブポイントを作ったり、チームで共同作業したりできます。\n\n' +
          '使い方: 「@git 〇〇したい」と入力してください。',
        steps: [
          {
            type: 'info',
            explanation:
              '基本的な流れ:\n\n' +
              '  1. ファイルを編集する\n' +
              '  2. 「@git コミットしたい」→ 変更を記録\n' +
              '  3. 「@git プッシュしたい」→ GitHubに送信\n\n' +
              'よく使うコマンド:\n' +
              '  @git 状況を確認   → 今の状態を見る\n' +
              '  @git 差分を見たい → 何が変わったか確認\n' +
              '  @git 履歴を見たい → 過去のコミット一覧\n' +
              '  @git 変更を戻す   → 編集を元に戻す\n' +
              '  @git ブランチ     → 作業を分岐する',
          },
          {
            type: 'tip',
            explanation: 'Git用語メモ:\n  リポジトリ = プロジェクトフォルダ\n  コミット = セーブポイント\n  ブランチ = 作業の枝分かれ\n  プッシュ = サーバーに送る\n  プル = サーバーから取得',
          },
        ],
      };

    case 'unknown':
    default:
      return {
        title: 'Gitアシスタント',
        overview:
          '基本操作は @git で、複雑な操作はAIエージェントに聞くのがおすすめです。',
        steps: [
          {
            type: 'info',
            explanation:
              '@git で対応できる操作:\n' +
              '  @git コミットしたい\n' +
              '  @git プッシュしたい\n' +
              '  @git 状況を確認\n' +
              '  @git 差分を見たい\n\n' +
              '複雑な操作はAIに任せましょう:\n' +
              '  @codex ブランチ戦略を教えて\n' +
              '  @perplexity rebaseの調査をして',
          },
        ],
      };
  }
}
