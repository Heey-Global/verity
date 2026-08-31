import { createHash } from 'node:crypto';

const value = process.env.CANARY_ENV;
if (value === undefined) throw new Error('canary environment injection is missing');
process.stdout.write(`${createHash('sha256').update(value).digest('hex')}\n`);
