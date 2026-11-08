import { INFRA, RepositoriesPage, VERITY, WEBSITE } from './parts';

/** Several repositories, one host unreachable: it is marked, the others stay. */
export default function MultipleRepositoriesMockup() {
  return (
    <RepositoriesPage
      repositories={[
        { ...VERITY, pulls: VERITY.pulls === 'unavailable' ? [] : VERITY.pulls.slice(0, 3) },
        INFRA,
        WEBSITE,
      ]}
    />
  );
}
