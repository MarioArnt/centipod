import chalk from 'chalk';

export const logger = {
  centipod: `${chalk.cyan.bold('>')} ${chalk.bgCyan.black.bold(' CENTIPOD ')}`,
  failed: chalk.bgRedBright.black.bold(' FAILED '),
  success: chalk.bgGreen.black.bold(' SUCCESS '),
  fromCache: chalk.bgCyanBright.bold.black(' FROM CACHE '),
  took: (ms: number) => chalk.magenta(`Took ${ms}ms`),
  info: (...args: unknown[]) => {
    console.info(args.map(a => chalk.grey(a)).join(' '));
  },
  log: (...args: unknown[]) => {
    console.log(args.join(' '));
  },
  error: (...args: unknown[]) => {
    console.error(args.map(a => chalk.red.bold(a)).join(' '));
    /*for (const arg of args) {
      if ((arg as Error)?.stack) {
        logger.lf();
        console.error(chalk.red(arg))
        console.error(chalk.red((arg as Error).stack))
      }
    }*/
  },
  seperator: () => {
    logger.info('———————————————————————————————————————————————');
  },
  lf: () => {
    process.stderr.write('\n');
  },
}
