import {
  DEFAULT_SERVER_MONITORING_SETTINGS,
  type DetailModeStarter,
  type ServerMonitoringSettings,
} from '@verity/store';

/** The durations detail mode can run for, in minutes. */
export const DETAIL_MODE_MINUTES = [15, 60, 240] as const;
export type DetailModeMinutes = (typeof DETAIL_MODE_MINUTES)[number];

export interface MonitoringSettingsStore {
  get(): Promise<ServerMonitoringSettings>;
  setMeasurementEnabled(enabled: boolean): Promise<ServerMonitoringSettings>;
  setDetailMode(
    until: Date | null,
    startedBy: DetailModeStarter | null,
  ): Promise<ServerMonitoringSettings>;
}

export interface MonitoringState {
  measurementEnabled: boolean;
  detailMode: {
    active: boolean;
    until: string | null;
    startedBy: DetailModeStarter | null;
    remainingSeconds: number;
  };
}

/** Holds the monitoring settings in memory, so a request reads two fields
 *  instead of the database. Writes go to the store first, then to memory. */
export class MonitoringControl {
  private settings: ServerMonitoringSettings = { ...DEFAULT_SERVER_MONITORING_SETTINGS };

  constructor(
    private readonly store: MonitoringSettingsStore | undefined,
    private readonly now: () => number = Date.now,
    private readonly onMeasurementChange: (enabled: boolean) => void = () => undefined,
    /** A new detail period starts; runs only once the setting is stored. */
    private readonly onDetailStart: () => void = () => undefined,
  ) {}

  /** Loads the stored settings; without a store the defaults apply. */
  async load(): Promise<void> {
    if (this.store === undefined) return;
    this.apply(await this.store.get());
  }

  get measuring(): boolean {
    return this.settings.measurementEnabled;
  }

  /** Detail mode counts only while measurement is on and its deadline lies ahead. */
  get detailActive(): boolean {
    const until = this.settings.detailUntil;
    return this.measuring && until !== null && until.getTime() > this.now();
  }

  state(): MonitoringState {
    const active = this.detailActive;
    const until = this.settings.detailUntil;
    return {
      measurementEnabled: this.settings.measurementEnabled,
      detailMode: {
        active,
        until: active && until !== null ? until.toISOString() : null,
        startedBy: active ? this.settings.detailStartedBy : null,
        remainingSeconds:
          active && until !== null ? Math.ceil((until.getTime() - this.now()) / 1000) : 0,
      },
    };
  }

  /** Runs changes one after another, so memory ends with the row stored last. */
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(change: () => Promise<T>): Promise<T> {
    const result = this.queue.then(change, change);
    this.queue = result.catch(() => undefined);
    return result;
  }

  setMeasurementEnabled(enabled: boolean): Promise<MonitoringState> {
    return this.serial(() => this.writeMeasurement(enabled));
  }

  startDetailMode(
    minutes: DetailModeMinutes,
    startedBy: DetailModeStarter,
  ): Promise<MonitoringState> {
    return this.serial(() => this.writeDetailStart(minutes, startedBy));
  }

  stopDetailMode(): Promise<MonitoringState> {
    return this.serial(() => this.writeDetailStop());
  }

  private async writeMeasurement(enabled: boolean): Promise<MonitoringState> {
    const next = this.store
      ? await this.store.setMeasurementEnabled(enabled)
      : { ...this.settings, measurementEnabled: enabled };
    this.apply(next);
    return this.state();
  }

  private async writeDetailStart(
    minutes: DetailModeMinutes,
    startedBy: DetailModeStarter,
  ): Promise<MonitoringState> {
    const until = new Date(this.now() + minutes * 60_000);
    const next = this.store
      ? await this.store.setDetailMode(until, startedBy)
      : { ...this.settings, detailUntil: until, detailStartedBy: startedBy };
    this.onDetailStart();
    this.apply(next);
    return this.state();
  }

  private async writeDetailStop(): Promise<MonitoringState> {
    const next = this.store
      ? await this.store.setDetailMode(null, null)
      : { ...this.settings, detailUntil: null, detailStartedBy: null };
    this.apply(next);
    return this.state();
  }

  private apply(next: ServerMonitoringSettings): void {
    const changed = next.measurementEnabled !== this.settings.measurementEnabled;
    this.settings = next;
    if (changed) this.onMeasurementChange(next.measurementEnabled);
  }
}
