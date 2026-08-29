/**
 * Whether a project runs an image Verity BUILT from the repo's own
 * `.devcontainer/`, as opposed to the baked sandbox image it merely pulls.
 *
 * The distinction is what gates the "Rebuild image" action: only a built image
 * has a build to redo. The server tags every such build
 * `verity-devc-<owner>-<repo>:<hash12>` and records the selected ref on the
 * project, so the prefix is the whole test.
 *
 * `DEVCONTAINER_IMAGE_PREFIX` mirrors the constant of the same name in
 * `packages/server/src/provisioner.ts`, which is where the tags are minted and
 * where the disk GC selects them for retirement. Change one, change all three.
 */
export const DEVCONTAINER_IMAGE_PREFIX = 'verity-devc-';

/** `imageRef` records what the LAST provisioning attempt selected, so a repo
 *  that only just gained a `.devcontainer/` still reads false here. That is the
 *  right answer for the action this gates: the added directory changes the
 *  content hash, so the next ordinary Repair already builds it and there is no
 *  cache to force past. */
export function usesDevcontainerImage(imageRef: string | null | undefined): boolean {
  return typeof imageRef === 'string' && imageRef.startsWith(DEVCONTAINER_IMAGE_PREFIX);
}
