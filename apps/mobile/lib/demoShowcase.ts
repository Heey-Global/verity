import type { StreamEventFrame } from '@verity/mobile';

// A richer demo scenario for product imagery: several projects, sessions in
// different states, a brokered approval and filled Knowledge. It replaces the
// welcome sample only when the browser's storage carries the flag below, which
// the rendering script sets. Native apps have no `localStorage`, so the demo a
// reviewer opens on iPhone or iPad always stays the documented walkthrough.
export const DEMO_SHOWCASE_STORAGE_KEY = 'verity.demoShowcase.v1';

export function isDemoShowcase(): boolean {
  try {
    return globalThis.localStorage?.getItem(DEMO_SHOWCASE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

type DemoEvent = StreamEventFrame['event'];

export interface ShowcaseSession {
  projectId: string;
  name: string;
  model: string;
  branch: string;
  state: 'idle' | 'running' | 'awaiting_approval';
  events: DemoEvent[];
  /** Id of the trailing `permission` event when `state` is `awaiting_approval`. */
  pendingPermission?: string;
  /** Markdown of a plan awaiting the Implement decision. */
  plan?: string;
  /** The open pull request of the session's branch, with its CI state. */
  pullRequest?: ShowcasePullRequest;
}

interface ShowcasePullRequest {
  number: number;
  title: string;
  /** `running` leaves some checks pending; `success` makes the PR merge-ready. */
  pipeline: 'running' | 'success';
}

export const SHOWCASE_PROJECTS = [
  { id: 'showcase-shop', repo: 'Northwind Shop' },
  { id: 'showcase-research', repo: 'Customer Research' },
  { id: 'showcase-app', repo: 'Northwind App' },
] as const;

const CLAUDE = 'claude-opus-5-5';
const CODEX = 'codex/gpt-6.1-sol';
const OPENCODE = 'verity/Qwen3.8-Max';

/** The model new showcase sessions start with; listed in `SHOWCASE_MODELS`. */
export const SHOWCASE_DEFAULT_MODEL = CLAUDE;

/** Current models of every engine, so the model picker shows all three groups. */
export const SHOWCASE_MODELS = [
  'claude-fable-5-1',
  CLAUDE,
  'claude-sonnet-5-5',
  CODEX,
  'codex/gpt-6-astra',
  'codex/gpt-6-sol',
  OPENCODE,
  'verity/Kimi-K3',
  'verity/DeepSeek-V4.1-Flash-1017',
];
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

export function showcaseSessions(): ShowcaseSession[] {
  return [
    {
      projectId: 'showcase-research',
      name: 'Interview synthesis',
      model: CLAUDE,
      branch: 'main',
      state: 'awaiting_approval',
      pendingPermission: 'showcase-gmail-send',
      events: [
        {
          t: 'prompt',
          text: "Summarize this week's customer interviews and send the summary to the product team.",
        },
        {
          t: 'text',
          delta:
            'I read the three interview transcripts in Project Knowledge and saved the recurring themes as an insight. The draft below goes to the product team once you approve it.',
        },
        {
          t: 'permission',
          id: 'showcase-gmail-send',
          tool: 'verity_gmail',
          riskClass: 'ask',
          input: {
            action: 'send_draft',
            draftId: 'showcase-draft',
            from: 'research@northwind.example',
            to: ['product@northwind.example'],
            cc: [],
            bcc: [],
            subject: 'Customer interviews: week 41 summary',
            body: 'Hi team,\n\nThree themes came up in all interviews this week:\n\n1. Checkout asks for the address twice.\n2. Store owners want weekly sales reports by email.\n3. Onboarding needs a sample catalog.\n\nTranscripts and notes are in Project Knowledge.\n\nBest,\nResearch',
            externalUrls: [],
          },
        },
      ],
    },
    {
      projectId: 'showcase-shop',
      name: 'Checkout redesign',
      model: CLAUDE,
      branch: 'feat/single-page-checkout',
      state: 'running',
      pullRequest: {
        number: 218,
        title: 'feat(checkout): single-page checkout',
        pipeline: 'running',
      },
      events: [
        {
          t: 'prompt',
          text: 'Where do customers drop off in checkout? Check the interviews in Knowledge.',
        },
        {
          t: 'text',
          delta:
            'All three interviews point at the same place:\n\n- **Address step:** checkout asks for the shipping address twice.\n- **Payment step:** customers who re-enter the address there leave most often.\n- **Confirmation:** no complaints.\n\nI saved this as the insight `checkout-friction.md`.',
        },
        { t: 'result', usage, stopReason: 'end_turn' },
        {
          t: 'prompt',
          text: 'Merge the address and payment steps into a single checkout page. Keep the payment tests green.',
        },
        {
          t: 'text',
          delta:
            'The interview insight confirms the duplicate address step. I will combine both steps in `CheckoutPage` and reuse the existing validation.',
        },
        {
          t: 'tool_call',
          id: 'showcase-read',
          name: 'Read',
          input: { file_path: '/workspace/src/checkout/CheckoutPage.tsx' },
        },
        { t: 'tool_result', id: 'showcase-read', output: '182 lines', isError: false },
        {
          t: 'tool_call',
          id: 'showcase-edit',
          name: 'Edit',
          input: {
            file_path: '/workspace/src/checkout/CheckoutPage.tsx',
            old_string: '<AddressStep onNext={goToPayment} />',
            new_string: '<AddressFields form={form} />\n<PaymentFields form={form} />',
          },
        },
        { t: 'tool_result', id: 'showcase-edit', output: 'Edited', isError: false },
        {
          t: 'tool_call',
          id: 'showcase-test',
          name: 'Bash',
          input: { command: 'npm test -- checkout' },
        },
      ],
    },
    {
      projectId: 'showcase-shop',
      name: 'Fix payment retries',
      model: CODEX,
      branch: 'fix/payment-retry-backoff',
      state: 'idle',
      pullRequest: {
        number: 214,
        title: 'fix(payments): back off retries with jitter',
        pipeline: 'success',
      },
      events: [
        {
          t: 'prompt',
          text: 'How often did payments fail last night?',
        },
        {
          t: 'text',
          delta:
            '37 of 2,140 charges failed between 19:00 and 21:00. In 31 cases the provider returned `429 Too Many Requests`, and our retry failed within the same second.',
        },
        { t: 'result', usage, stopReason: 'end_turn' },
        {
          t: 'prompt',
          text: 'Payments sometimes fail twice in a row during peak hours. Find out why.',
        },
        {
          t: 'tool_call',
          id: 'showcase-retry-read',
          name: 'Read',
          input: { file_path: '/workspace/src/payments/retry.ts' },
        },
        { t: 'tool_result', id: 'showcase-retry-read', output: '64 lines', isError: false },
        {
          t: 'tool_call',
          id: 'showcase-retry-edit',
          name: 'Edit',
          input: {
            file_path: '/workspace/src/payments/retry.ts',
            old_string: 'await charge(order)',
            new_string: 'await withBackoff(() => charge(order), { jitter: true })',
          },
        },
        { t: 'tool_result', id: 'showcase-retry-edit', output: 'Edited', isError: false },
        {
          t: 'tool_call',
          id: 'showcase-retry-test',
          name: 'Bash',
          input: { command: 'npm test' },
        },
        { t: 'tool_result', id: 'showcase-retry-test', output: '214 passed', isError: false },
        {
          t: 'text',
          delta:
            'Retries fired immediately, so a busy provider rejected them again. They now back off exponentially with jitter, and a new test covers three failures in a row. All 214 tests pass, and pull request #214 is green and ready to merge.',
        },
        { t: 'result', usage, stopReason: 'end_turn' },
      ],
    },
    {
      projectId: 'showcase-shop',
      name: 'Refund duplicate charges',
      model: CLAUDE,
      branch: 'main',
      state: 'awaiting_approval',
      pendingPermission: 'showcase-refund',
      events: [
        {
          t: 'prompt',
          text: 'Refund the customers who were charged twice last night.',
        },
        {
          t: 'text',
          delta:
            "31 charges were duplicated between 19:00 and 21:00. Refunding them calls the payment provider with the project's API key, which needs your approval.",
        },
        {
          t: 'permission',
          id: 'showcase-refund',
          tool: 'verity_http_request',
          riskClass: 'ask',
          input: {
            method: 'POST',
            url: 'https://api.stripe.com/v1/refunds',
            secretAlias: 'STRIPE_API_KEY',
            auth: { kind: 'static', header: 'authorization', scheme: 'Bearer' },
            body: { charge: 'ch_3SKq1xLp2', reason: 'duplicate' },
          },
        },
      ],
    },
    {
      projectId: 'showcase-shop',
      name: 'Weekly sales email',
      model: CODEX,
      branch: 'feat/weekly-sales-email',
      state: 'idle',
      plan: [
        '# Weekly sales email',
        '',
        '## Goal',
        'Store owners get a sales summary every Monday morning.',
        '',
        '## Steps',
        '1. Add a weekly report job for Monday at 8:00.',
        '2. Summarize revenue, orders and top products per store.',
        '3. Send it through the existing mailer with an unsubscribe link.',
        '4. Test empty weeks and newly added stores.',
      ].join('\n'),
      events: [
        {
          t: 'prompt',
          text: 'Store owners want a weekly sales summary by email. Plan it first.',
        },
        {
          t: 'text',
          delta: 'Here is the plan. Nothing changes until you choose Implement.',
        },
        { t: 'result', usage, stopReason: 'end_turn' },
      ],
    },
    {
      projectId: 'showcase-research',
      name: 'Research digest',
      model: CLAUDE,
      branch: 'main',
      state: 'idle',
      events: [
        {
          t: 'prompt',
          text: 'What changed in Knowledge since last week?',
        },
        {
          t: 'text',
          delta:
            'Three new interview transcripts and the pricing survey with 412 responses. I added the insight `weekly-reporting.md`.',
        },
        { t: 'result', usage, stopReason: 'end_turn' },
        {
          t: 'prompt',
          text: 'Every Monday morning, summarize new interviews and survey answers in Knowledge.',
        },
        {
          t: 'text',
          delta: 'Confirm the schedule below and this session runs the digest on its own.',
        },
        {
          t: 'automation_proposal',
          proposal: {
            name: 'Monday research digest',
            schedule: { kind: 'weekly', weekday: 1, hour: 8, minute: 30 },
            prompt:
              'Summarize new interviews and survey answers in Project Knowledge since last Monday.',
          },
        },
        { t: 'result', usage, stopReason: 'end_turn' },
      ],
    },
    {
      projectId: 'showcase-app',
      name: 'Offline order notes',
      model: CODEX,
      branch: 'feat/offline-order-notes',
      state: 'awaiting_approval',
      pendingPermission: 'showcase-package-install',
      events: [
        {
          t: 'prompt',
          text: 'Let staff add order notes while offline and sync them later.',
        },
        {
          t: 'text',
          delta: 'Offline storage needs the `idb` package. Installing it first.',
        },
        {
          t: 'permission',
          id: 'showcase-package-install',
          tool: 'verity_package_install',
          riskClass: 'ask',
          input: { command: 'npm install idb', manager: 'npm', supported: true },
        },
      ],
    },
    {
      projectId: 'showcase-app',
      name: 'Search ranking',
      model: OPENCODE,
      branch: 'feat/search-ranking',
      state: 'awaiting_approval',
      pendingPermission: 'showcase-migrate',
      events: [
        {
          t: 'prompt',
          text: 'Rank search results by recent orders and try it on staging.',
        },
        {
          t: 'text',
          delta:
            'Ranking is implemented and covered by tests. Applying the index migration to the staging database needs your approval.',
        },
        {
          t: 'permission',
          id: 'showcase-migrate',
          tool: 'Bash',
          riskClass: 'ask',
          input: {
            command: 'npm run db:migrate -- --env staging',
            description: 'Apply the search index migration to staging',
          },
        },
      ],
    },
  ];
}

export function showcaseKnowledgeFiles(): Record<string, string> {
  return {
    'sources/meetings/2026-10-06 Interview Lena, operations lead.md':
      '# Interview: Lena, operations lead\n\nLena runs fulfilment for three stores. Checkout asks for the shipping address twice, which she calls "the moment customers leave".\n',
    'sources/meetings/2026-10-07 Interview Marco, store owner.md':
      '# Interview: Marco, store owner\n\nMarco checks sales every Monday and would prefer a weekly summary by email.\n',
    'sources/meetings/2026-10-08 Interview Aylin, new customer.md':
      '# Interview: Aylin, new customer\n\nAylin needed a sample catalog to understand the product setup during onboarding.\n',
    'sources/documents/Pricing survey 2026.md':
      '# Pricing survey 2026\n\n412 responses. Most store owners prefer monthly billing.\n',
    'insights/checkout-friction.md':
      '# Checkout friction\n\nAll three interviews mention the duplicate address step.\n\nSources: `sources/meetings/`.\n',
    'insights/weekly-reporting.md':
      '# Weekly reporting\n\nStore owners review sales weekly and want the summary delivered by email.\n',
  };
}
