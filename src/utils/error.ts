import { Logger } from './logger';

export class ErrorHandler {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  handleError(error: unknown, context?: string): void {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    const stackTrace = error instanceof Error ? error.stack : null;

    this.logger.error(`Error in ${context || 'unknown context'}: ${errorMessage}`, {
      stack: stackTrace,
    });
  }

  wrapSafe<T>(fn: () => T, context?: string): T | null {
    try {
      return fn();
    } catch (error) {
      this.handleError(error, context);
      return null;
    }
  }

  async wrapSafeAsync<T>(fn: () => Promise<T>, context?: string): Promise<T | null> {
    try {
      return await fn();
    } catch (error) {
      this.handleError(error, context);
      return null;
    }
  }
}
