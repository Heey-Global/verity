import { expect, it } from 'vitest';
import { localPreviewIngressMigration } from './local-preview-ingress.js';

const gateway = {
  id: 'gateway',
  running: true,
  portBindings: { '8082/tcp': [{ HostIp: '100.85.209.118', HostPort: '8082' }] },
};

it('adds legacy ingress on all interfaces by default and configures listeners', () => {
  const migration = localPreviewIngressMigration(gateway)!;
  expect(migration.env).toEqual({
    VERITY_LOCAL_PREVIEW_PORT_RANGE: '8100-8119',
    VERITY_LOCAL_PREVIEW_BIND_ADDRESS: '0.0.0.0',
  });
  expect(Object.keys(migration.portBindings)).toHaveLength(20);
  expect(migration.portBindings['8100/tcp']).toEqual([{ HostIp: '0.0.0.0', HostPort: '8100' }]);
  expect(
    localPreviewIngressMigration({
      ...gateway,
      env: ['VERITY_LOCAL_PREVIEW_PORT_RANGE=8100-8119'],
      portBindings: { ...gateway.portBindings, ...migration.portBindings },
    }),
  ).toBeUndefined();
});

it('uses the running Server range and replaces old loopback preview bindings', () => {
  const migration = localPreviewIngressMigration(
    {
      ...gateway,
      env: ['VERITY_LOCAL_PREVIEW_PORT_RANGE=8100-8119'],
      portBindings: {
        ...gateway.portBindings,
        '9200/tcp': [{ HostIp: '127.0.0.1', HostPort: '19200' }],
      },
    },
    '9200-9201',
  )!;
  expect(migration.env.VERITY_LOCAL_PREVIEW_PORT_RANGE).toBe('9200-9201');
  expect(migration.portBindings).toEqual({
    '9200/tcp': [{ HostIp: '0.0.0.0', HostPort: '9200' }],
    '9201/tcp': [{ HostIp: '0.0.0.0', HostPort: '9201' }],
  });
});

it.each(['', '0.0.0.0', '::', '203.0.113.2', '100.85.209.118'])(
  'does not infer preview exposure from API binding %s',
  (HostIp) => {
    const migration = localPreviewIngressMigration(
      {
        ...gateway,
        portBindings: { '8082/tcp': [{ HostIp, HostPort: '8082' }] },
      },
      '9200-9200',
    )!;
    expect(migration.portBindings['9200/tcp']).toEqual([{ HostIp: '0.0.0.0', HostPort: '9200' }]);
  },
);

it.each(['100.85.209.118', '::1'])(
  'supports an explicitly configured preview interface %s',
  (address) => {
    expect(
      localPreviewIngressMigration(
        {
          ...gateway,
          env: [`VERITY_LOCAL_PREVIEW_BIND_ADDRESS=${address}`],
        },
        '9200-9200',
      )!.portBindings['9200/tcp'],
    ).toEqual([{ HostIp: address, HostPort: '9200' }]);
  },
);

it('refuses invalid binding configuration and API port overlap', () => {
  expect(() => localPreviewIngressMigration(gateway, '9200-9200', 'verity')).toThrow('IP address');
  expect(() => localPreviewIngressMigration(gateway, '8082-8083')).toThrow('overlap');
});

it('reconciles existing bindings when the range is already configured', () => {
  const migration = localPreviewIngressMigration({
    ...gateway,
    env: ['VERITY_LOCAL_PREVIEW_PORT_RANGE=9200-9200'],
    portBindings: {
      ...gateway.portBindings,
      '9200/tcp': [{ HostIp: '127.0.0.1', HostPort: '9200' }],
    },
  })!;
  expect(migration.portBindings).toEqual({ '9200/tcp': [{ HostIp: '0.0.0.0', HostPort: '9200' }] });
  expect(migration.portBindings['8082/tcp']).toBeUndefined();
});

it('persists an override for post-replacement reconciliation', () => {
  const migration = localPreviewIngressMigration(
    { ...gateway, env: ['VERITY_LOCAL_PREVIEW_BIND_ADDRESS=127.0.0.1'] },
    '9200-9200',
    '100.85.209.118',
  )!;
  expect(migration.env.VERITY_LOCAL_PREVIEW_BIND_ADDRESS).toBe('100.85.209.118');
  expect(
    localPreviewIngressMigration({
      ...gateway,
      env: Object.entries(migration.env).map(([key, value]) => `${key}=${value}`),
      portBindings: { ...gateway.portBindings, ...migration.portBindings },
    }),
  ).toBeUndefined();
});
