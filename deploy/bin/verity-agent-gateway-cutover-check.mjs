#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { pathToFileURL, URL } from 'node:url';

const PROJECT_LABEL = 'verity.project-id';
const COMPONENT_LABEL = 'verity.component';
const GENERATION_LABEL = 'verity.container-generation';
const RELAY_COMPONENT = 'project-relay';
const GATEWAY_URL_LABEL = 'verity.claude-egress.gateway-url';
const CONTROL_SERVICE = 'verity';
const STABLE_GATEWAY_HOST = 'verity-agent-gateway';
// The Compose service key matches the DNS identity, so both are one constant.
const GATEWAY_SERVICE = STABLE_GATEWAY_HOST;
const PROJECT_NETWORK_PREFIX = 'verity-proj-';
const DEFAULT_GATEWAY_URL = `https://${STABLE_GATEWAY_HOST}:9443/`;
const INSPECT_BATCH_SIZE = 50;
const DOCKER_OUTPUT_MAX_BUFFER = 16 * 1024 * 1024;

export function analyzeAgentGatewayCutover(
  containers,
  { composeProject = 'deploy', expectedGatewayUrl = DEFAULT_GATEWAY_URL } = {},
) {
  const failures = [];
  const warnings = [];
  let expected;
  try {
    expected = normalizeGatewayUrl(expectedGatewayUrl);
    if (new URL(expected).hostname !== STABLE_GATEWAY_HOST) {
      failures.push(`expected gateway URL must use stable hostname ${STABLE_GATEWAY_HOST}`);
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : 'invalid expected gateway URL');
  }

  const controls = containers.filter(
    (container) =>
      container.labels['com.docker.compose.project'] === composeProject &&
      container.labels['com.docker.compose.service'] === CONTROL_SERVICE,
  );
  const gateways = containers.filter(
    (container) =>
      container.labels['com.docker.compose.project'] === composeProject &&
      container.labels['com.docker.compose.service'] === GATEWAY_SERVICE,
  );
  const unownedGatewayStamped = containers.filter(
    (container) => container.labels[GATEWAY_URL_LABEL] && !container.labels[PROJECT_LABEL],
  );
  const projectOwned = containers.filter((container) => container.labels[PROJECT_LABEL]);
  const relays = projectOwned.filter(
    (container) => container.labels[COMPONENT_LABEL] === RELAY_COMPONENT,
  );
  const unownedProjectComponents = containers.filter(
    (container) =>
      !controls.includes(container) &&
      !gateways.includes(container) &&
      container.labels[COMPONENT_LABEL] &&
      !container.labels[PROJECT_LABEL] &&
      container.networks.some((network) => network.startsWith(PROJECT_NETWORK_PREFIX)),
  );
  const sandboxes = containers.filter(
    (container) =>
      !controls.includes(container) &&
      !gateways.includes(container) &&
      !container.labels[COMPONENT_LABEL] &&
      (container.labels[PROJECT_LABEL] ||
        container.networks.some((network) => network.startsWith(PROJECT_NETWORK_PREFIX))),
  );
  const unknownProjectComponents = projectOwned.filter(
    (container) =>
      container.labels[COMPONENT_LABEL] && container.labels[COMPONENT_LABEL] !== RELAY_COMPONENT,
  );

  if (controls.length !== 1) {
    failures.push(
      `found ${controls.length} Verity control-plane containers in Compose project ${composeProject}; expected exactly one`,
    );
  }
  if (gateways.length !== 1) {
    failures.push(
      `found ${gateways.length} standalone gateway containers in Compose project ${composeProject}; expected exactly one ${GATEWAY_SERVICE} service`,
    );
  }
  for (const control of controls) {
    if (!control.running) failures.push(`Verity control plane ${control.name} is stopped`);
    compareConfiguredUrl(control, expected, failures);
    const projectNetworks = control.networks.filter((network) =>
      network.startsWith(PROJECT_NETWORK_PREFIX),
    );
    if (projectNetworks.length > 0) {
      failures.push(
        `Verity control plane ${control.name} is attached to project network(s): ${projectNetworks.join(', ')}`,
      );
    }
  }
  for (const gateway of gateways) {
    if (!gateway.running) failures.push(`standalone gateway ${gateway.name} is stopped`);
    compareConfiguredUrl(gateway, expected, failures);
    if (!stableAliasNetworks(gateway).length) {
      failures.push(
        `standalone gateway ${gateway.name} is missing stable DNS alias ${STABLE_GATEWAY_HOST}`,
      );
    }
  }
  if (gateways.length === 1) {
    const gateway = gateways[0];
    const gatewayAliasNetworks = stableAliasNetworks(gateway);
    for (const container of containers) {
      if (container === gateway) continue;
      const collisions = stableAliasNetworks(container).filter((network) =>
        gatewayAliasNetworks.includes(network),
      );
      if (collisions.length > 0) {
        failures.push(
          `container ${container.name} also publishes ${STABLE_GATEWAY_HOST} on ${collisions.join(', ')}`,
        );
      }
    }
    // Only the control plane talks to the gateway. A sandbox reaches Claude
    // exclusively through its generation-matched relay, which in turn reaches the
    // control plane over a Unix socket on the shared data volume — there is no
    // network path from a project network to the gateway, by design.
    for (const control of controls) {
      const sharedAliasNetwork = gatewayAliasNetworks.some((network) =>
        control.networks.includes(network),
      );
      if (!sharedAliasNetwork) {
        failures.push(
          `Verity control plane ${control.name} has no shared network where gateway ${gateway.name} publishes ${STABLE_GATEWAY_HOST}`,
        );
      }
    }
    // Reachability the other way round is a containment breach: a sandbox that
    // can address the gateway directly has escaped its project network.
    for (const sandbox of sandboxes) {
      const reachesGateway = gateway.networks.filter((network) =>
        sandbox.networks.includes(network),
      );
      if (reachesGateway.length > 0) {
        failures.push(
          `project sandbox ${sandbox.name} shares gateway network(s) ${reachesGateway.join(', ')}; it must reach Claude only through its relay`,
        );
      }
    }
  }
  for (const container of unownedGatewayStamped) {
    failures.push(`container ${container.name} has ${GATEWAY_URL_LABEL} without ${PROJECT_LABEL}`);
  }
  for (const component of unownedProjectComponents) {
    failures.push(
      `project-network component ${component.name} has ${COMPONENT_LABEL}=${component.labels[COMPONENT_LABEL]} without ${PROJECT_LABEL}`,
    );
  }
  for (const component of unknownProjectComponents) {
    failures.push(
      `project container ${component.name} has unknown ${COMPONENT_LABEL}=${component.labels[COMPONENT_LABEL]}`,
    );
  }

  // A sandbox is stamped with the relay it was provisioned against, so the stamp
  // is validated against that relay rather than against the gateway origin.
  const relayByProject = new Map();
  for (const relay of relays) {
    const projectId = relay.labels[PROJECT_LABEL];
    if (!relayByProject.has(projectId)) relayByProject.set(projectId, relay);
  }

  const projects = new Map();
  for (const sandbox of sandboxes) {
    const projectId = sandbox.labels[PROJECT_LABEL];
    if (!projectId) {
      failures.push(
        `project-network sandbox candidate ${sandbox.name} is missing ${PROJECT_LABEL}`,
      );
      continue;
    }
    const siblings = projects.get(projectId) ?? [];
    siblings.push(sandbox);
    projects.set(projectId, siblings);
    if (!sandbox.running) failures.push(`project sandbox ${sandbox.name} is stopped`);
    const expectedProjectNetwork = `${PROJECT_NETWORK_PREFIX}${projectId}`;
    if (sandbox.networks.length !== 1 || sandbox.networks[0] !== expectedProjectNetwork) {
      failures.push(
        `project sandbox ${sandbox.name} must attach only to ${expectedProjectNetwork}`,
      );
    }
    const stamped = sandbox.labels[GATEWAY_URL_LABEL];
    if (!stamped) {
      failures.push(`project sandbox ${sandbox.name} is legacy: missing ${GATEWAY_URL_LABEL}`);
      continue;
    }
    let normalizedStamp;
    try {
      normalizedStamp = normalizeGatewayUrl(stamped);
    } catch {
      failures.push(`project sandbox ${sandbox.name} has invalid ${GATEWAY_URL_LABEL}`);
      continue;
    }
    const relay = relayByProject.get(projectId);
    if (relay === undefined) {
      // Reported as a missing relay by the relay pairing checks below; skipping
      // here keeps one broken project from producing two confusing messages.
      continue;
    }
    const expectedRelayOrigin = `https://${relay.name}:8443/`;
    if (normalizedStamp !== expectedRelayOrigin) {
      failures.push(
        `project sandbox ${sandbox.name} targets ${normalizedStamp}; expected its relay ${expectedRelayOrigin}`,
      );
    }
  }
  for (const [projectId, siblings] of projects) {
    if (siblings.length !== 1) {
      failures.push(
        `project ${projectId} has ${String(siblings.length)} sandbox containers; expected exactly one`,
      );
    }
  }
  const relaysByProject = new Map();
  for (const relay of relays) {
    const projectId = relay.labels[PROJECT_LABEL];
    const siblings = relaysByProject.get(projectId) ?? [];
    siblings.push(relay);
    relaysByProject.set(projectId, siblings);
    if (!relay.running) failures.push(`project relay ${relay.name} is stopped`);
    const projectNetworks = relay.networks.filter((network) =>
      network.startsWith(PROJECT_NETWORK_PREFIX),
    );
    const expectedProjectNetwork = `${PROJECT_NETWORK_PREFIX}${projectId}`;
    if (
      relay.networks.length !== 1 ||
      projectNetworks.length !== 1 ||
      projectNetworks[0] !== expectedProjectNetwork
    ) {
      failures.push(`project relay ${relay.name} must attach only to ${expectedProjectNetwork}`);
    }
    const generation = relay.labels[GENERATION_LABEL];
    if (!generation) failures.push(`project relay ${relay.name} is missing ${GENERATION_LABEL}`);
    const matchingSandboxes = sandboxes.filter(
      (sandbox) => sandbox.labels[PROJECT_LABEL] === projectId,
    );
    if (matchingSandboxes.length !== 1) {
      failures.push(
        `project relay ${relay.name} has ${String(matchingSandboxes.length)} matching sandboxes; expected exactly one`,
      );
      continue;
    }
    const sandbox = matchingSandboxes[0];
    if (!projectNetworks.some((network) => sandbox.networks.includes(network))) {
      failures.push(
        `project relay ${relay.name} does not share its Verity project network with sandbox ${sandbox.name}`,
      );
    }
    if (generation && sandbox.labels[GENERATION_LABEL] !== generation) {
      failures.push(
        `project relay ${relay.name} does not match sandbox ${sandbox.name} generation`,
      );
    }
  }
  for (const [projectId, siblings] of relaysByProject) {
    if (siblings.length !== 1) {
      failures.push(
        `project ${projectId} has ${String(siblings.length)} relay containers; expected exactly one`,
      );
    }
  }
  for (const [projectId] of projects) {
    const matchingRelays = relaysByProject.get(projectId) ?? [];
    if (matchingRelays.length !== 1) {
      failures.push(
        `project ${projectId} has ${String(matchingRelays.length)} relay containers; expected exactly one for its sandbox`,
      );
    }
  }

  if (sandboxes.length === 0) {
    warnings.push(
      'no project sandboxes were found; cutover is vacuously safe but no project route was observed',
    );
  }
  return {
    ready: failures.length === 0,
    controls: controls.length,
    gateways: gateways.length,
    sandboxes: sandboxes.length,
    failures,
    warnings,
  };
}

function compareConfiguredUrl(container, expected, failures) {
  const configured = container.environment.VERITY_AGENT_GATEWAY_URL;
  if (!configured) {
    failures.push(`container ${container.name} is missing VERITY_AGENT_GATEWAY_URL`);
    return;
  }
  try {
    const normalized = normalizeGatewayUrl(configured);
    if (expected !== undefined && normalized !== expected) {
      failures.push(`container ${container.name} configures ${normalized}; expected ${expected}`);
    }
  } catch {
    failures.push(`container ${container.name} has invalid VERITY_AGENT_GATEWAY_URL`);
  }
}

function stableAliasNetworks(container) {
  return Object.entries(container.networkAliasesByNetwork)
    .filter(([, aliases]) => aliases.includes(STABLE_GATEWAY_HOST))
    .map(([network]) => network);
}

export function normalizeGatewayUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('expected gateway URL must be an HTTPS origin without credentials or path');
  }
  if (url.hostname === 'verity' || url.hostname === 'verity-gateway') {
    throw new Error(`expected gateway URL still uses retired hostname ${url.hostname}`);
  }
  return url.href;
}

function inspectContainers() {
  const ids = execFileSync('docker', ['ps', '-aq'], {
    encoding: 'utf8',
    maxBuffer: DOCKER_OUTPUT_MAX_BUFFER,
  })
    .split(/\s+/)
    .filter(Boolean);
  if (ids.length === 0) return [];
  const containers = [];
  for (let offset = 0; offset < ids.length; offset += INSPECT_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + INSPECT_BATCH_SIZE);
    containers.push(...inspectBatch(batch).map(normalizeDockerInspect));
  }
  return containers;
}

function inspectBatch(batch) {
  try {
    return JSON.parse(
      execFileSync('docker', ['inspect', ...batch], {
        encoding: 'utf8',
        maxBuffer: DOCKER_OUTPUT_MAX_BUFFER,
      }),
    );
  } catch (error) {
    // Listing ids and inspecting them are two calls. On a busy host a container
    // can be gone in between — every `--rm` run does exactly that — and Docker
    // then exits non-zero while still printing the containers it did find. A
    // preflight that dies on this reports nothing at all about a fleet that is
    // almost certainly fine, so tolerate exactly that case and nothing else.
    if (!vanishedContainersOnly(error?.stderr)) throw error;
    const stdout = String(error?.stdout ?? '').trim();
    return stdout.length > 0 ? JSON.parse(stdout) : [];
  }
}

export function vanishedContainersOnly(stderr) {
  const lines = String(stderr ?? '')
    .split('\n')
    .filter((line) => line.trim().length > 0);
  return (
    lines.length > 0 && lines.every((line) => /^error: no such object: \S+$/iu.test(line.trim()))
  );
}

export function normalizeDockerInspect(inspect) {
  const networks = inspect.NetworkSettings?.Networks ?? {};
  return {
    name: String(inspect.Name ?? '').replace(/^\//, '') || String(inspect.Id ?? '').slice(0, 12),
    running: inspect.State?.Running === true,
    labels: inspect.Config?.Labels ?? {},
    environment: Object.fromEntries(
      (inspect.Config?.Env ?? []).map((entry) => {
        const separator = entry.indexOf('=');
        return separator < 0
          ? [entry, '']
          : [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
    ),
    networks: Object.keys(networks),
    networkAliasesByNetwork: Object.fromEntries(
      Object.entries(networks).map(([name, network]) => [name, network.Aliases ?? []]),
    ),
  };
}

function main() {
  const composeProject = process.env.COMPOSE_PROJECT_NAME?.trim() || 'deploy';
  const expectedGatewayUrl = process.env.VERITY_AGENT_GATEWAY_URL?.trim() || DEFAULT_GATEWAY_URL;
  const result = analyzeAgentGatewayCutover(inspectContainers(), {
    composeProject,
    expectedGatewayUrl,
  });
  for (const warning of result.warnings) console.warn(`warning: ${warning}`);
  for (const failure of result.failures) console.error(`not ready: ${failure}`);
  console.log(
    `${result.ready ? 'READY' : 'NOT READY'}: ${result.controls} control plane, ${result.gateways} gateway, ${result.sandboxes} sandbox(es)`,
  );
  process.exitCode = result.ready ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
