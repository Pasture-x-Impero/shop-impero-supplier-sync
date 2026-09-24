import { execFileSync } from 'child_process';

/**
 * Oppdater en GitHub Actions secret via `gh` CLI.
 *
 * Bruker execFileSync (ingen shell) og --body-flagget i stedet for å pipe
 * verdien gjennom `echo` i en shell-streng — en cookie-/tokenverdi som
 * inneholder shell-metategn (`` ` ``, `$(...)`, `"`) ville ellers kunne
 * bryte ut av kommandoen.
 */
export function updateGitHubSecret(secretName: string, secretValue: string, token: string, repo: string) {
  execFileSync('gh', ['secret', 'set', secretName, '--repo', repo, '--body', secretValue], {
    env: { ...process.env, GH_TOKEN: token },
  });
}
