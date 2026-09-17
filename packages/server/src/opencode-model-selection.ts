import type { VeritySettingsRecord } from '@verity/store';

type OpenCodeModelSettings = Pick<
  VeritySettingsRecord,
  'opencodeModels' | 'opencodeDisabledModels'
>;

function modelIds(value: string | null | undefined): string[] {
  return (value ?? '')
    .split(/[\n,]/u)
    .map((model) => model.trim())
    .filter((model, index, all) => model.length > 0 && all.indexOf(model) === index);
}

/** Return the discovered OpenCode catalog after applying the user's exclusions.
 * An exclusion list makes later discoveries active by default. */
export function selectedOpenCodeModels(settings: OpenCodeModelSettings | undefined): string[] {
  const disabled = new Set(modelIds(settings?.opencodeDisabledModels));
  return modelIds(settings?.opencodeModels).filter((model) => !disabled.has(model));
}
