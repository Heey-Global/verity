import { RepositoriesPage, VERITY } from './parts';

/** One repository: its open pull requests, conflicts and failures first. */
export default function SingleRepositoryMockup() {
  return <RepositoriesPage repositories={[VERITY]} />;
}
