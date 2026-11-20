/** Durable operation signal used while a cacheless devcontainer image build
 * runs alongside the still-serving project container. */
export const PROJECT_IMAGE_REBUILDING_WARNING = 'Project image rebuild is in progress.';

/** Provision warning for a devcontainer that asks to run as root. Shared so the
 * app can name it briefly ("Runs as root") instead of matching on free text. */
export const DEVCONTAINER_ROOT_USER_WARNING =
  'Devcontainer requests remoteUser=root. The project is running, but root containers have a larger blast radius; prefer a non-root remoteUser when possible.';
