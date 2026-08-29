#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PROJECT_LABEL = 'verity.project-id';
const GENERATION_LABEL = 'verity.container-generation';
const COMPONENT_LABEL = 'verity.component';
const RELAY_COMPONENT = 'project-relay';
/** Pre-ADR-0013 value of {@link COMPONENT_LABEL}. Recognised so a relay left
 *  over from an older Verity is reported as the stale relay it is, rather than
 *  falling through the `!== RELAY_COMPONENT` test into the sandbox bucket and
 *  being judged against sandbox expectations it can never meet. */
const LEGACY_RELAY_COMPONENT = 'project-broker-relay';
const PROJECT_NETWORK_PREFIX = 'verity-proj-';

const isRelayComponent = (component) =>
  component === RELAY_COMPONENT || component === LEGACY_RELAY_COMPONENT;

export function analyzeProjectRelayCutover(
  containers,
  composeProject = 'deploy',
  { allowEmpty = false } = {},
) {
  const failures = [];
  const warnings = [];
  const controls = containers.filter(
    (container) =>
      container.labels['com.docker.compose.project'] === composeProject &&
      container.labels['com.docker.compose.service'] === 'verity',
  );
  const unownedRelays = containers.filter(
    (container) =>
      isRelayComponent(container.labels[COMPONENT_LABEL]) && !container.labels[PROJECT_LABEL],
  );
  const owned = containers.filter((container) => container.labels[PROJECT_LABEL]);
  const relays = owned.filter((container) => isRelayComponent(container.labels[COMPONENT_LABEL]));
  const legacyRelays = containers.filter(
    (container) => container.labels[COMPONENT_LABEL] === LEGACY_RELAY_COMPONENT,
  );
  const sandboxes = owned.filter(
    (container) => !isRelayComponent(container.labels[COMPONENT_LABEL]),
  );

  if (controls.length !== 1) {
    // Name the Compose projects that DO run a `verity` service. Finding zero here
    // almost always means COMPOSE_PROJECT_NAME was left at the default while the
    // deployment runs under another name — without this hint that reads as a
    // broken control plane rather than a wrong argument.
    const observed = [
      ...new Set(
        containers
          .filter((container) => container.labels['com.docker.compose.service'] === 'verity')
          .map((container) => container.labels['com.docker.compose.project'])
          .filter(Boolean),
      ),
    ];
    const hint =
      controls.length === 0 && observed.length > 0
        ? `; a verity service exists in Compose project(s): ${observed.join(', ')}`
        : '';
    failures.push(
      `found ${controls.length} Verity control-plane containers in Compose project ${composeProject}; expected exactly one${hint}`,
    );
  }
  for (const control of controls) {
    if (!control.running) failures.push(`Verity control plane ${control.name} is stopped`);
  }
  for (const relay of unownedRelays) {
    failures.push(`relay ${relay.name} is missing ${PROJECT_LABEL}`);
  }
  for (const relay of legacyRelays) {
    failures.push(
      `relay ${relay.name} still carries the pre-ADR-0013 ${COMPONENT_LABEL}=${LEGACY_RELAY_COMPONENT}; recreate its sandbox to replace it`,
    );
  }
  for (const container of owned) {
    if (!container.running) failures.push(`Verity project container ${container.name} is stopped`);
  }

  for (const control of controls) {
    const projectNetworks = control.networks.filter((network) =>
      network.startsWith(PROJECT_NETWORK_PREFIX),
    );
    if (projectNetworks.length > 0) {
      failures.push(
        `control plane ${control.name} is attached to project network(s): ${projectNetworks.join(', ')}`,
      );
    }
  }

  for (const sandbox of sandboxes) {
    const projectId = sandbox.labels[PROJECT_LABEL];
    const generation = sandbox.labels[GENERATION_LABEL];
    const expectedNetwork = `${PROJECT_NETWORK_PREFIX}${projectId}`;
    if (!generation) {
      failures.push(`sandbox ${sandbox.name} is legacy: missing ${GENERATION_LABEL}`);
      continue;
    }
    if (sandbox.networks.length !== 1 || sandbox.networks[0] !== expectedNetwork) {
      failures.push(
        `sandbox ${sandbox.name} is not single-homed on ${expectedNetwork}: ${sandbox.networks.join(', ') || 'none'}`,
      );
    }
    const matchingRelays = relays.filter(
      (relay) =>
        relay.labels[PROJECT_LABEL] === projectId && relay.labels[GENERATION_LABEL] === generation,
    );
    if (matchingRelays.length !== 1) {
      failures.push(
        `sandbox ${sandbox.name} has ${matchingRelays.length} matching relays; expected exactly one`,
      );
    }
  }

  for (const relay of relays) {
    const projectId = relay.labels[PROJECT_LABEL];
    const generation = relay.labels[GENERATION_LABEL];
    const expectedNetwork = `${PROJECT_NETWORK_PREFIX}${projectId}`;
    if (!generation) failures.push(`relay ${relay.name} is missing ${GENERATION_LABEL}`);
    if (relay.networks.length !== 1 || relay.networks[0] !== expectedNetwork) {
      failures.push(
        `relay ${relay.name} is not single-homed on ${expectedNetwork}: ${relay.networks.join(', ') || 'none'}`,
      );
    }
    const matchingSandboxes = sandboxes.filter(
      (sandbox) =>
        sandbox.labels[PROJECT_LABEL] === projectId &&
        sandbox.labels[GENERATION_LABEL] === generation,
    );
    if (matchingSandboxes.length !== 1) {
      failures.push(
        `relay ${relay.name} has ${matchingSandboxes.length} matching sandboxes; expected exactly one`,
      );
    }
  }

  const projectNetworks = new Set(
    containers.flatMap((container) =>
      container.networks.filter((network) => network.startsWith(PROJECT_NETWORK_PREFIX)),
    ),
  );
  for (const network of projectNetworks) {
    const attached = containers.filter((container) => container.networks.includes(network));
    const projectId = network.slice(PROJECT_NETWORK_PREFIX.length);
    const attachedSandboxes = sandboxes.filter(
      (container) =>
        container.labels[PROJECT_LABEL] === projectId && container.networks.includes(network),
    );
    const attachedRelays = relays.filter(
      (container) =>
        container.labels[PROJECT_LABEL] === projectId && container.networks.includes(network),
    );
    const generationMatches =
      attachedSandboxes.length === 1 &&
      attachedRelays.length === 1 &&
      attachedSandboxes[0].labels[GENERATION_LABEL] === attachedRelays[0].labels[GENERATION_LABEL];
    if (
      attached.length !== 2 ||
      attachedSandboxes.length !== 1 ||
      attachedRelays.length !== 1 ||
      !generationMatches
    ) {
      failures.push(
        `project network ${network} does not contain exactly one generation-matched sandbox + relay`,
      );
    }
  }

  if (sandboxes.length === 0 && !allowEmpty) failures.push('no project sandboxes were found');
  return {
    ready: failures.length === 0,
    controls: controls.length,
    sandboxes: sandboxes.length,
    relays: relays.length,
    failures,
    warnings,
  };
}

function inspectContainers() {
  const ids = execFileSync('docker', ['ps', '-aq'], { encoding: 'utf8' })
    .split(/\s+/)
    .filter(Boolean);
  if (ids.length === 0) return [];
  return JSON.parse(execFileSync('docker', ['inspect', ...ids], { encoding: 'utf8' })).map(
    normalizeDockerInspect,
  );
}

export function normalizeDockerInspect(inspect) {
  return {
    name: String(inspect.Name ?? '').replace(/^\//, '') || String(inspect.Id ?? '').slice(0, 12),
    running: inspect.State?.Running === true,
    labels: inspect.Config?.Labels ?? {},
    networks: Object.keys(inspect.NetworkSettings?.Networks ?? {}),
  };
}

function main() {
  const composeProject = process.env.COMPOSE_PROJECT_NAME?.trim() || 'deploy';
  const unknownArguments = process.argv.slice(2).filter((argument) => argument !== '--allow-empty');
  if (unknownArguments.length > 0) {
    throw new Error(`unknown argument: ${unknownArguments[0]}`);
  }
  const result = analyzeProjectRelayCutover(inspectContainers(), composeProject, {
    allowEmpty: process.argv.includes('--allow-empty'),
  });
  for (const warning of result.warnings) console.warn(`warning: ${warning}`);
  for (const failure of result.failures) console.error(`not ready: ${failure}`);
  console.log(
    `${result.ready ? 'READY' : 'NOT READY'}: ${result.controls} control plane, ${result.sandboxes} sandbox(es), ${result.relays} relay(s)`,
  );
  process.exitCode = result.ready ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
