#!/usr/bin/env node
import chalk from 'chalk';
import { Command } from 'commander';
import { semanticRelease, semanticReleaseInit } from './cmd/semantic-release';
import { affected } from './cmd/affected';
import { isAffected } from './cmd/is-affected';
import { publish } from './cmd/publish';
import { run } from './cmd/run';
import { logger } from './utils/logger';

// TODO: Validate command input

const program = new Command();

program.version('0.0.1-alpha');

const commandWrapper = async (fn: () => Promise<void> | void, keepOpen = false): Promise<void> => {
  try {
    await fn();
    if (!keepOpen) {
      process.exit(0);
    }
  } catch (e) {
    logger.error(chalk.bgRedBright('Uncaught error:'));
    logger.error(e);
    process.exit(1);
  }
};

program
  .command('list [workspace]')
  .description('start microlambda services')
  .action(
    async (cmd) =>
      await commandWrapper(async () => {
        throw new Error('Not implemented');
      }, true),
  );

  program
  .command('affected <rev1> [rev2]')
  .description('start microlambda services')
  .action(
    async (rev1, rev2) =>
      await commandWrapper(async () => {
        affected(rev1, rev2);
      }, true),
  );

  program
  .command('is-affected <workspace> <rev1> [rev2]')
  .description('start microlambda services')
  .action(
    async (workspace, rev1, rev2) =>
      await commandWrapper(async () => {
        isAffected(workspace, rev1, rev2);
      }, true),
  );

  program
  .command('run <cmd>')
  .option('-p, --parallel', 'run command in parallel in all workspaces')
  .option('-t, --topological', 'run command in dependency before')
  .option('--force', 'ignore cached outputs and checksums')
  .option('--watch', 'watch sources and run the command again on changes')
  .option('--to <workspace>', 'run the command only to a given workspace')
  .option('--affected <rev1>..[rev2]', 'only run command on workspaces affected between two revisions')
  .description('run a centipod target through the dependencies graph')
  .action(
    async (cmd, options) =>
      await commandWrapper(async () => {
        console.debug('run');
        run(cmd, options);
      }, true),
  );

  program
  .command('publish <workspace> <bump> [identifier]')
  .option('--access <access>')
  .option('--yes')
  .option('--dry')
  .description('publish package')
  .action(
    async (workspace, bump, identifier, options) =>
      await commandWrapper(async () => {
        publish(workspace, bump, identifier, options);
      }, true),
  );

  const semantic = program
    .command('semantic-release [identifier]')
    .option('--access <access>')
    .option('--yes')
    .option('--dry')
    .description('publish affected packages using semantic versioning based on coventional changelog')
    .action(
      async (identifier, _options, cmd) =>
        await commandWrapper(async () => {
          semanticRelease(identifier, cmd._optionValues);
          // TODO:
          // Take all commits since last semantic-* tag (if not, publish version 1.0.0 of each pkg and tag semantic-1.0.0)
          // Start a map with <pkg, 'none', 'patch', 'minor', 'major'>
          // For each commit check which packages are affected
          // If fix => for each affected pkg if < patch set patch
          // If feat => for each affacted pkg if < minor set minor
          // If BREAKING CHANGE => for each affected pkg if < major set major
          // Per package bump are resolved !
          // Now for each patch package, flag as patch all deps
          // Then proceed as same for minor, and finally major
          // Now that versions as been resolved, publish in topological order
          // Note that optional identifier can be used to publish rc/alpha/beta/whatever (useful for automating release of candidates on branch next while publishing true releases from main/master)
        }, true),
    );

  semantic
    .command('init')
    .description('publish affected packages using semantic versioning based on coventional changelog')
    .action(
      async (_opt, cmd) =>
        await commandWrapper(async () => {
          semanticReleaseInit(cmd.parent._optionValues);
        }, true),
    );

(async (): Promise<unknown> => program.parseAsync(process.argv))();
