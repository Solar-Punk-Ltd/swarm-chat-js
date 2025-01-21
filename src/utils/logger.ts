export class Logger {
  private context: string;

  constructor(context?: string) {
    this.context = context || '';
  }

  private formatMessage(level: string, ...args: any[]): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level.toUpperCase()}] - ${this.context} ${args
      .map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : arg))
      .join(' ')}`;
  }

  log(...args: any[]): void {
    console.log(this.formatMessage('log', ...args));
  }

  info(...args: any[]): void {
    console.info(this.formatMessage('info', ...args));
  }

  warn(...args: any[]): void {
    console.warn(this.formatMessage('warn', ...args));
  }

  error(...args: any[]): void {
    console.error(this.formatMessage('error', ...args));
  }

  debug(...args: any[]): void {
    console.debug(this.formatMessage('debug', ...args));
  }

  /**
   * Allows creating a child logger with a specific context.
   */
  withContext(context: string): Logger {
    return new Logger(context);
  }
}
