export class BackupFileChangedError extends Error {
  constructor() {
    super('Backup file changed during capture');
    this.name = 'BackupFileChangedError';
  }
}
