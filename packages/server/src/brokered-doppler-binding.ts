import { createHash } from 'node:crypto';
import { z } from 'zod';

const bindingSchema = z
  .object({
    dopplerProject: z.string().trim().min(1),
    dopplerConfig: z.string().trim().min(1),
  })
  .strict();

export type BrokeredDopplerBinding = z.infer<typeof bindingSchema>;

export function parseBrokeredDopplerBinding(snapshot: string): BrokeredDopplerBinding {
  return bindingSchema.parse(JSON.parse(snapshot));
}

export function brokeredDopplerBindingId(binding: BrokeredDopplerBinding): string {
  return `project-doppler:${createHash('sha256')
    .update(binding.dopplerProject)
    .update('\0')
    .update(binding.dopplerConfig)
    .digest('hex')}`;
}

export function assertBrokeredDopplerBinding(
  current: BrokeredDopplerBinding | undefined,
  approved: BrokeredDopplerBinding | undefined,
): asserts current is BrokeredDopplerBinding {
  if (current === undefined) throw new Error('project Doppler binding is unavailable');
  if (
    approved !== undefined &&
    brokeredDopplerBindingId(current) !== brokeredDopplerBindingId(approved)
  ) {
    throw new Error('Doppler access changed after approval; submit the operation again');
  }
}
