const print = (lvl: 'debug' | 'info' | 'warn' | 'error', ...args: unknown[]): void => {
  if (process.env.NODE_ENV !== 'test' || process.env.DEBUG_TESTS) {
    // eslint-disable-next-line no-console
    console[lvl](args);
  }
}

export const logger = {
  debug: (...args: unknown[]) => print('debug', args),
  info: (...args: unknown[]) => print('info', args),
  warn: (...args: unknown[]) => print('warn', args),
  error: (...args: unknown[]) => print('error', args),
}
