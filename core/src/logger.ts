const print = (lvl: 'debug' | 'info' | 'warn' | 'error', ...args: unknown[]): void => {
  if (process.env.NODE_ENV !== 'test' || process.env.DEBUG_TESTS) {
    // eslint-disable-next-line no-console
    console[lvl](args);
  }
}

export const logger = {
  debug: (...args: unknown[]): void => print('debug', args),
  info: (...args: unknown[]): void => print('info', args),
  warn: (...args: unknown[]): void => print('warn', args),
  error: (...args: unknown[]): void => print('error', args),
}
