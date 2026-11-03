import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { ACTIVATION_GATE_DIRECTORY } from './activation-gate.js';
import {
  MANAGED_SERVER_DEFAULT_RESOURCES,
  type ServerDeploymentSpecBody,
} from './deployment-spec.js';
import { initializeManagedDeployment, readManagedDeployment } from './managed-deployment.js';
import { runManagedBootstrap } from './managed-bootstrap.js';

// Execute the fixture functions actually shipped by the driver without starting
// its CLI or copying a second deployment specification into this guard.
const source = ts.createSourceFile(
  'self-update-live-smoke.ts',
  readFileSync('packages/server/src/self-update-live-smoke.ts', 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
function fixtureFunction(name: string, dependencies: Record<string, unknown> = {}): unknown {
  const declaration = source.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (declaration === undefined) throw new Error(`Missing smoke fixture function: ${name}`);
  const { outputText } = ts.transpileModule(declaration.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.None },
  });
  return new Function(...Object.keys(dependencies), `${outputText}\nreturn ${name};`)(
    ...Object.values(dependencies),
  ) as unknown;
}
function fixtureConstant(name: string): string {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer !== undefined &&
        ts.isStringLiteral(declaration.initializer)
      )
        return declaration.initializer.text;
    }
  }
  throw new Error(`Missing smoke fixture constant: ${name}`);
}

it('keeps the live-smoke deployment seal unchanged when re-adopting the selected image', async () => {
  const deploymentSpec = fixtureFunction('deploymentSpec', {
    required: () => '2',
    MANAGED_SERVER_DEFAULT_RESOURCES,
    UPDATER_CONTROL_VOLUME: fixtureConstant('UPDATER_CONTROL_VOLUME'),
    SECRET_FILE: fixtureConstant('SECRET_FILE'),
    ACTIVATION_GATE_DIRECTORY,
  }) as (image: string) => Omit<ServerDeploymentSpecBody, 'schemaVersion' | 'deploymentId'>;
  const serverEnvironment = fixtureFunction('serverEnvironment') as (
    databaseUrl: string,
    deploymentId: string,
  ) => NodeJS.ProcessEnv;
  const parent = await mkdtemp(join(tmpdir(), 'live-smoke-bootstrap-'));
  const root = join(parent, 'managed-deployment');
  const image = `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`;
  try {
    const before = await initializeManagedDeployment({ root, spec: deploymentSpec(image) });
    if (!before.managed) throw new Error(before.reason);
    await runManagedBootstrap(
      {
        ...serverEnvironment(
          'postgres://verity@verity-postgres:5432/verity',
          before.spec.deploymentId,
        ),
        VERITY_MANAGED_ROOT: root,
        VERITY_SERVER_IMAGE: image,
        VERITY_DOCKER_SOCKET_PATH: '/var/run/docker.sock',
        VERITY_PAIRING_STATE_HOST_PATH: '/etc/verity',
        VERITY_SERVER_UID: '1000',
        VERITY_SERVER_GID: '1000',
      },
      'amd64',
      root,
    );
    const after = await readManagedDeployment(root);
    if (!after.managed) throw new Error(after.reason);
    expect(after.spec).toEqual(before.spec);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
