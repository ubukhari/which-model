/**
 * How to run which-model: the one constant behind every place the command is shown or printed
 * (`--help` and the CLI's own hints, the README and its picture, the plugin skill and marketplace,
 * and agentcheck's /which-model pages).
 *
 * npm does not serve `which-model` yet, so it runs from the public repo, whose committed dist/ needs
 * no build (scripts/sync-oss-repos.sh). npm 12 refuses a git spec unless `--allow-git` permits it
 * (its default is `none`); `root` permits only the spec named on the command line, and npm 10 and
 * 11 accept the flag (checked 8 Oct 2026), so the GitHub form carries it. The day npm serves the
 * package, flip ON_NPM and rewrite the rest:
 *
 *   WHICH_MODEL_WRITE_INSTALL=1 pnpm --filter which-model exec vitest run src/distribution
 *
 * src/distribution.test.ts fails while any surface names another form of the command.
 */
export const ON_NPM: boolean = false;

export const NAME = "which-model";
export const REPO = `https://github.com/agentwares/${NAME}`;

/** What a person types. */
export const INSTALL = ON_NPM ? `npx ${NAME}` : `npx --allow-git=root github:agentwares/${NAME}`;

/** What an agent runs unattended: no install prompt, and on npm the newest version, not a cached one. */
export const RUN = ON_NPM
  ? `npx -y ${NAME}@latest`
  : `npx -y --allow-git=root github:agentwares/${NAME}`;
