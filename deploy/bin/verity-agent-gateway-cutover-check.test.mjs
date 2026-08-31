import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  analyzeAgentGatewayCutover,
  normalizeDockerInspect,
  normalizeGatewayUrl,
  vanishedContainersOnly,
} from './verity-agent-gateway-cutover-check.mjs';

const stable = 'https://verity-agent-gateway:9443/';
const control = {
  name: 'deploy-verity-1',
  running: true,
  labels: {
    'com.docker.compose.project': 'deploy',
    'com.docker.compose.service': 'verity',
  },
  environment: {
    VERITY_AGENT_GATEWAY_URL: stable,
  },
  networks: ['verity-net'],
  networkAliasesByNetwork: { 'verity-net': ['verity'] },
};
const gateway = {
  name: 'deploy-verity-agent-gateway-1',
  running: true,
  labels: {
    'com.docker.compose.project': 'deploy',
    'com.docker.compose.service': 'verity-agent-gateway',
  },
  environment: { VERITY_AGENT_GATEWAY_URL: stable },
  networks: ['verity-net'],
  networkAliasesByNetwork: {
    'verity-net': ['verity-agent-gateway'],
  },
};
const relayUrl = 'https://verity-project-relay-a:8443';
// A sandbox is single-homed on its project network and stamped with the relay it
// was provisioned against — it never shares a network with the gateway and never
// carries the gateway origin.
const sandbox = {
  name: 'verity-project-a',
  running: true,
  labels: {
    'verity.project-id': 'a',
    'verity.claude-egress.gateway-url': relayUrl,
    'verity.container-generation': 'generation-a',
  },
  environment: {},
  networks: ['verity-proj-a'],
  networkAliasesByNetwork: { 'verity-proj-a': [] },
};
const relay = {
  name: 'verity-project-relay-a',
  running: true,
  labels: {
    'verity.project-id': 'a',
    'verity.component': 'project-relay',
    'verity.container-generation': 'generation-a',
  },
  environment: {},
  networks: ['verity-proj-a'],
  networkAliasesByNetwork: { 'verity-proj-a': [] },
};

test('accepts a relay-isolated fleet whose control plane reaches the gateway', () => {
  assert.deepEqual(analyzeAgentGatewayCutover([control, gateway, sandbox, relay]), {
    ready: true,
    controls: 1,
    gateways: 1,
    sandboxes: 1,
    failures: [],
    warnings: [],
  });
});

test('rejects missing, legacy, transitional, and malformed sandbox targets', () => {
  for (const target of [
    undefined,
    'https://verity:9443/',
    'https://verity-gateway:9443/',
    'https://verity-agent-gateway:9443/path',
  ]) {
    const labels = { 'verity.project-id': 'a' };
    if (target !== undefined) labels['verity.claude-egress.gateway-url'] = target;
    const result = analyzeAgentGatewayCutover([{ ...sandbox, labels }, control, gateway]);
    assert.equal(result.ready, false);
    assert.ok(result.failures.some((failure) => failure.includes('sandbox')));
  }
});

test('rejects mismatched control or gateway URLs', () => {
  for (const container of [control, gateway]) {
    const mismatched = {
      ...container,
      environment: {
        ...container.environment,
        VERITY_AGENT_GATEWAY_URL: 'https://other-gateway:9443/',
      },
    };
    const result = analyzeAgentGatewayCutover([
      container === control ? mismatched : control,
      container === gateway ? mismatched : gateway,
      sandbox,
    ]);
    assert.equal(result.ready, false);
    assert.ok(result.failures.some((failure) => failure.includes('configures')));
  }
});

test('rejects missing infrastructure, stopped containers, and an absent stable alias', () => {
  const missing = analyzeAgentGatewayCutover([sandbox]);
  assert.equal(missing.ready, false);
  assert.ok(missing.failures.some((failure) => failure.includes('control-plane')));
  assert.ok(missing.failures.some((failure) => failure.includes('standalone gateway')));

  const stopped = analyzeAgentGatewayCutover([
    { ...control, running: false },
    { ...gateway, running: false, networkAliasesByNetwork: { 'verity-net': [] } },
    { ...sandbox, running: false },
  ]);
  assert.equal(stopped.ready, false);
  assert.ok(stopped.failures.some((failure) => failure.includes('is stopped')));
  assert.ok(stopped.failures.some((failure) => failure.includes('stable DNS alias')));
});

test('rejects an alias published only on a network the control plane cannot reach', () => {
  const isolatedGateway = {
    ...gateway,
    networks: ['gateway-only'],
    networkAliasesByNetwork: {
      'gateway-only': ['verity-agent-gateway'],
    },
  };
  const result = analyzeAgentGatewayCutover([control, isolatedGateway, sandbox, relay]);
  assert.equal(result.ready, false);
  assert.ok(
    result.failures.some(
      (failure) => failure.includes(control.name) && failure.includes('has no shared network'),
    ),
  );
});

test('rejects a control plane attached to any project network', () => {
  const escapedControl = {
    ...control,
    networks: ['verity-net', 'verity-proj-a'],
    networkAliasesByNetwork: { 'verity-net': [], 'verity-proj-a': [] },
  };
  const result = analyzeAgentGatewayCutover([escapedControl, gateway, sandbox, relay]);
  assert.equal(result.ready, false);
  assert.ok(
    result.failures.some(
      (failure) =>
        failure.includes(escapedControl.name) &&
        failure.includes('attached to project network(s): verity-proj-a'),
    ),
  );
});

test('rejects a sandbox that can address the gateway directly', () => {
  const escaped = {
    ...sandbox,
    networks: ['verity-proj-a', 'verity-net'],
    networkAliasesByNetwork: { 'verity-proj-a': [], 'verity-net': [] },
  };
  const result = analyzeAgentGatewayCutover([control, gateway, escaped, relay]);
  assert.equal(result.ready, false);
  assert.ok(
    result.failures.some(
      (failure) =>
        failure.includes(escaped.name) &&
        failure.includes('must reach Claude only through its relay'),
    ),
  );
});

test('rejects a sandbox sharing any gateway network, even without the stable alias', () => {
  const gatewayWithPrivateNetwork = {
    ...gateway,
    networks: ['verity-net', 'gateway-private'],
    networkAliasesByNetwork: {
      ...gateway.networkAliasesByNetwork,
      'gateway-private': ['verity-agent-gateway-private'],
    },
  };
  const escaped = {
    ...sandbox,
    networks: ['verity-proj-a', 'gateway-private'],
    networkAliasesByNetwork: { 'verity-proj-a': [], 'gateway-private': [] },
  };
  const result = analyzeAgentGatewayCutover([control, gatewayWithPrivateNetwork, escaped, relay]);
  assert.equal(result.ready, false);
  assert.ok(
    result.failures.some(
      (failure) =>
        failure.includes(escaped.name) &&
        failure.includes('gateway-private') &&
        failure.includes('must reach Claude only through its relay'),
    ),
  );
});

test('rejects any second sandbox or relay network as an unvalidated escape path', () => {
  const sandboxWithExtraNetwork = {
    ...sandbox,
    networks: ['verity-proj-a', 'unrelated-network'],
    networkAliasesByNetwork: { 'verity-proj-a': [], 'unrelated-network': [] },
  };
  const sandboxResult = analyzeAgentGatewayCutover([
    control,
    gateway,
    sandboxWithExtraNetwork,
    relay,
  ]);
  assert.equal(sandboxResult.ready, false);
  assert.ok(
    sandboxResult.failures.some(
      (failure) =>
        failure.includes(sandbox.name) && failure.includes('must attach only to verity-proj-a'),
    ),
  );

  const relayWithExtraNetwork = {
    ...relay,
    networks: ['verity-proj-a', 'unrelated-network'],
    networkAliasesByNetwork: { 'verity-proj-a': [], 'unrelated-network': [] },
  };
  const relayResult = analyzeAgentGatewayCutover([
    control,
    gateway,
    sandbox,
    relayWithExtraNetwork,
  ]);
  assert.equal(relayResult.ready, false);
  assert.ok(
    relayResult.failures.some(
      (failure) =>
        failure.includes(relay.name) && failure.includes('must attach only to verity-proj-a'),
    ),
  );
});

test('rejects sandbox and relay networks belonging to another project id', () => {
  const misplacedSandbox = {
    ...sandbox,
    networks: ['verity-proj-b'],
    networkAliasesByNetwork: { 'verity-proj-b': [] },
  };
  const misplacedRelay = {
    ...relay,
    networks: ['verity-proj-b'],
    networkAliasesByNetwork: { 'verity-proj-b': [] },
  };
  const result = analyzeAgentGatewayCutover([control, gateway, misplacedSandbox, misplacedRelay]);
  assert.equal(result.ready, false);
  assert.ok(
    result.failures.some(
      (failure) =>
        failure.includes(misplacedSandbox.name) &&
        failure.includes('must attach only to verity-proj-a'),
    ),
  );
  assert.ok(
    result.failures.some(
      (failure) =>
        failure.includes(misplacedRelay.name) &&
        failure.includes('must attach only to verity-proj-a'),
    ),
  );
});

test('rejects a relay stamp with the correct hostname but wrong port', () => {
  const wrongPort = {
    ...sandbox,
    labels: {
      ...sandbox.labels,
      'verity.claude-egress.gateway-url': 'https://verity-project-relay-a:9443',
    },
  };
  const result = analyzeAgentGatewayCutover([control, gateway, wrongPort, relay]);
  assert.equal(result.ready, false);
  assert.ok(
    result.failures.some(
      (failure) =>
        failure.includes(wrongPort.name) &&
        failure.includes('https://verity-project-relay-a:8443/'),
    ),
  );
});

test('rejects any second container publishing the stable gateway alias', () => {
  const collision = {
    ...sandbox,
    name: 'legacy-gateway',
    labels: {},
    networkAliasesByNetwork: {
      'verity-net': ['verity-agent-gateway'],
    },
  };
  const result = analyzeAgentGatewayCutover([control, gateway, sandbox, collision]);
  assert.equal(result.ready, false);
  assert.ok(
    result.failures.some(
      (failure) =>
        failure.includes(collision.name) && failure.includes('also publishes verity-agent-gateway'),
    ),
  );
});

test('rejects duplicate sandboxes and unowned or unknown stamped components', () => {
  const duplicate = { ...sandbox, name: 'verity-project-a-old' };
  const unowned = {
    ...sandbox,
    name: 'unowned',
    labels: { 'verity.claude-egress.gateway-url': stable },
  };
  const unknown = {
    ...sandbox,
    name: 'unknown-component',
    labels: {
      ...sandbox.labels,
      'verity.project-id': 'component',
      'verity.component': 'unexpected',
    },
  };
  const result = analyzeAgentGatewayCutover([
    control,
    gateway,
    sandbox,
    duplicate,
    unowned,
    unknown,
  ]);
  assert.equal(result.ready, false);
  assert.ok(result.failures.some((failure) => failure.includes('2 sandbox containers')));
  assert.ok(result.failures.some((failure) => failure.includes('without verity.project-id')));
  assert.ok(result.failures.some((failure) => failure.includes('unknown verity.component')));
});

test('rejects an unlabeled legacy sandbox discovered through its Verity project network', () => {
  const legacy = {
    ...sandbox,
    name: 'legacy-unlabeled',
    labels: {},
    networks: ['verity-proj-legacy'],
    networkAliasesByNetwork: { 'verity-proj-legacy': [] },
  };
  const result = analyzeAgentGatewayCutover([control, gateway, sandbox, legacy]);
  assert.equal(result.ready, false);
  assert.ok(
    result.failures.some(
      (failure) =>
        failure.includes(legacy.name) && failure.includes('is missing verity.project-id'),
    ),
  );
});

test('rejects an orphaned component discovered through its Verity project network', () => {
  const orphaned = {
    ...sandbox,
    name: 'orphaned-component',
    labels: { 'verity.component': 'project-relay' },
    networks: ['verity-proj-orphaned'],
    networkAliasesByNetwork: { 'verity-proj-orphaned': [] },
  };
  const result = analyzeAgentGatewayCutover([control, gateway, sandbox, orphaned]);
  assert.equal(result.ready, false);
  assert.ok(
    result.failures.some(
      (failure) => failure.includes(orphaned.name) && failure.includes('without verity.project-id'),
    ),
  );
});

test('validates existing project relays against sandbox network and generation', () => {
  const generation = 'generation-a';
  const routedSandbox = {
    ...sandbox,
    labels: {
      ...sandbox.labels,
      'verity.container-generation': generation,
    },
    networks: ['verity-proj-a'],
    networkAliasesByNetwork: { 'verity-proj-a': [] },
  };
  const matchingRelay = {
    ...sandbox,
    name: 'verity-project-relay-a',
    labels: {
      'verity.project-id': 'a',
      'verity.component': 'project-relay',
      'verity.container-generation': generation,
    },
    networks: ['verity-proj-a'],
    networkAliasesByNetwork: { 'verity-proj-a': [] },
  };
  assert.equal(
    analyzeAgentGatewayCutover([control, gateway, routedSandbox, matchingRelay]).ready,
    true,
  );

  const staleRelay = {
    ...matchingRelay,
    running: false,
    labels: {
      ...relay.labels,
      'verity.container-generation': 'stale',
    },
  };
  const result = analyzeAgentGatewayCutover([
    control,
    gateway,
    routedSandbox,
    staleRelay,
    { ...matchingRelay, name: 'verity-project-relay-a-duplicate' },
  ]);
  assert.equal(result.ready, false);
  assert.ok(
    result.failures.some((failure) => failure.includes('relay') && failure.includes('stopped')),
  );
  assert.ok(
    result.failures.some(
      (failure) => failure.includes('does not match') && failure.includes('generation'),
    ),
  );
  assert.ok(result.failures.some((failure) => failure.includes('2 relay containers')));
});

test('rejects a project sandbox without its required relay', () => {
  const result = analyzeAgentGatewayCutover([control, gateway, sandbox]);
  assert.equal(result.ready, false);
  assert.ok(
    result.failures.some(
      (failure) =>
        failure.includes('project a has 0 relay containers') &&
        failure.includes('expected exactly one for its sandbox'),
    ),
  );
});

test('does not classify known control or gateway infrastructure on project networks as sandboxes', () => {
  const projectAttachedControl = {
    ...control,
    networks: ['verity-net', 'verity-proj-a'],
    networkAliasesByNetwork: {
      'verity-net': ['verity'],
      'verity-proj-a': ['verity'],
    },
  };
  const projectAttachedGateway = {
    ...gateway,
    networks: ['verity-net', 'verity-proj-a'],
    networkAliasesByNetwork: {
      'verity-net': ['verity-gateway', 'verity-agent-gateway'],
      'verity-proj-a': ['verity-gateway', 'verity-agent-gateway'],
    },
  };
  const result = analyzeAgentGatewayCutover([
    projectAttachedControl,
    projectAttachedGateway,
    sandbox,
    relay,
  ]);
  // Classification is the point here: infrastructure sitting on a project network
  // is still control plane and gateway, not a second sandbox.
  assert.equal(result.sandboxes, 1);
  assert.equal(result.controls, 1);
  assert.equal(result.gateways, 1);
  // Publishing the gateway alias onto a project network is itself a breach: the
  // sandbox could then address the gateway without passing its relay.
  assert.equal(result.ready, false);
  assert.ok(
    result.failures.some(
      (failure) =>
        failure.includes(sandbox.name) &&
        failure.includes('must reach Claude only through its relay'),
    ),
  );
});

test('allows an empty project fleet only with an explicit warning', () => {
  const result = analyzeAgentGatewayCutover([control, gateway]);
  assert.equal(result.ready, true);
  assert.equal(result.sandboxes, 0);
  assert.equal(result.warnings.length, 1);
});

test('normalizes Docker inspect without exposing environment values in results', () => {
  assert.deepEqual(
    normalizeDockerInspect({
      Id: 'abcdef1234567890',
      Name: '/raw-container',
      State: { Running: true },
      Config: {
        Labels: { example: 'yes' },
        Env: ['FIRST=one=two', 'EMPTY'],
      },
      NetworkSettings: {
        Networks: {
          first: { Aliases: ['raw-container', 'stable'] },
          second: { Aliases: null },
        },
      },
    }),
    {
      name: 'raw-container',
      running: true,
      labels: { example: 'yes' },
      environment: { FIRST: 'one=two', EMPTY: '' },
      networks: ['first', 'second'],
      networkAliasesByNetwork: {
        first: ['raw-container', 'stable'],
        second: [],
      },
    },
  );
});

test('normalizes safe origins and rejects retired or path-bearing URLs', () => {
  assert.equal(normalizeGatewayUrl('https://verity-agent-gateway:9443'), stable);
  assert.throws(() => normalizeGatewayUrl('https://verity:9443/'), /retired hostname/u);
  assert.throws(() => normalizeGatewayUrl('https://verity-gateway:9443/'), /retired hostname/u);
  assert.throws(() => normalizeGatewayUrl('http://verity-agent-gateway:9443/'), /HTTPS origin/u);
  assert.throws(
    () => normalizeGatewayUrl('https://verity-agent-gateway:9443/path'),
    /HTTPS origin/u,
  );
});

test('fails closed when the expected URL overrides the stable hostname', () => {
  const result = analyzeAgentGatewayCutover([control, gateway, sandbox, relay], {
    expectedGatewayUrl: 'https://other-gateway:9443/',
  });
  assert.equal(result.ready, false);
  assert.ok(
    result.failures.some((failure) =>
      failure.includes('must use stable hostname verity-agent-gateway'),
    ),
  );
});

test('tolerates containers that vanish between listing and inspection', () => {
  // Every `--rm` run races the two Docker calls this preflight makes. Losing a
  // throwaway container must not blind the check to the whole fleet.
  assert.equal(vanishedContainersOnly('Error: No such object: 4c3c2bfd7bda\n'), true);
  assert.equal(
    vanishedContainersOnly('Error: No such object: 4c3c2bfd7bda\nError: No such object: 18dcb4e\n'),
    true,
  );

  // Anything else is a real Docker failure and must still fail closed.
  assert.equal(vanishedContainersOnly(''), false);
  assert.equal(vanishedContainersOnly(undefined), false);
  assert.equal(vanishedContainersOnly('Cannot connect to the Docker daemon'), false);
  assert.equal(
    vanishedContainersOnly('Error: No such object: abc\nCannot connect to the Docker daemon'),
    false,
  );
});
