import { z } from 'zod';

const deliveryBase = {
  environment: z.string().trim().min(1).max(64),
  objective: z.string().trim().min(1).max(2_000),
} as const;

const projectReferenceSchema = z.string().trim().min(1).max(200);

export const createDeliveryRequestSchema = z.union([
  z.object({ serviceId: z.string().trim().min(1).max(128), ...deliveryBase }).strict(),
  z
    .object({
      ...deliveryBase,
      service: z
        .object({
          name: z
            .string()
            .trim()
            .min(1)
            .max(100)
            .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
          sourceProject: projectReferenceSchema,
          deploymentProject: projectReferenceSchema,
          imageRepository: z.string().trim().min(1).max(300),
          manifestPath: z
            .string()
            .trim()
            .min(1)
            .max(500)
            .refine((path) => !path.startsWith('/') && !path.split('/').includes('..')),
          argoApplication: z.string().trim().min(1).max(200),
        })
        .strict(),
    })
    .strict(),
]);

export type CreateDeliveryRequest = z.infer<typeof createDeliveryRequestSchema>;

export const CREATE_DELIVERY_TOOL_DESCRIPTION =
  'Create and start one durable cross-project delivery from this Verity Control session. ' +
  'Use it after the user requests a delivery spanning source and GitOps projects. Prefer an existing service id. ' +
  'On first use, propose the exact known Verity source project, GitOps project, image repository, manifest directory and Argo CD application in `service`; the approval card confirms and registers that relationship. ' +
  'Project references must resolve to existing Verity projects and cannot expand authority. The call requires user approval. ' +
  'It starts the fixed source change, PR/CI, immutable image, GitOps, merge-decision, deployment, and health-verification sequence.';
