import { expect, expectTypeOf, it } from 'vitest';
import {
  SERVER_VERSION,
  type ProjectSettingsRecord,
  type PublicProjectRecord,
  type SessionListEnvelope,
  type SpawnResult,
} from './server.js';
import { SERVER_VERSION as version } from './server-support.js';
import type * as Types from './server-types.js';

it('keeps the composition root exports compatible after domain consumers move to their owners', () => {
  expect(SERVER_VERSION).toBe(version);
  expectTypeOf<ProjectSettingsRecord>().toEqualTypeOf<Types.ProjectSettingsRecord>();
  expectTypeOf<PublicProjectRecord>().toEqualTypeOf<Types.PublicProjectRecord>();
  expectTypeOf<SessionListEnvelope>().toEqualTypeOf<Types.SessionListEnvelope>();
  expectTypeOf<SpawnResult>().toEqualTypeOf<Types.SpawnResult>();
});
