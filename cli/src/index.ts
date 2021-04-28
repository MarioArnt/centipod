#!/usr/bin/env node
import chalk from 'chalk';
import { Command } from 'commander';
import { affected } from './cmd/affected';
import { isAffected } from './cmd/is-affected';
import { run } from './cmd/run';

const program = new Command();

program.version('0.0.1-alpha');

const commandWrapper = async (fn: () => Promise<void> | void, keepOpen = false): Promise<void> => {
  try {
    await fn();
    if (!keepOpen) {
      process.exit(0);
    }
  } catch (e) {
    console.error(chalk.bgRedBright('Uncaught error:'));
    console.error(e);
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
  .option('-p')
  .option('-t')
  .option('--force')
  .option('--to <workspace>')
  .option('--affected <rev1>..[rev2]')
  .description('start microlambda services')
  .action(
    async (cmd, options) =>
      await commandWrapper(async () => {
        run(cmd, options);
      }, true),
  );

(async (): Promise<unknown> => program.parseAsync(process.argv))();
