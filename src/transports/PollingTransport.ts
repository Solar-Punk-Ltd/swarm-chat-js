import { MessageData } from '../interfaces';
import { ErrorHandler } from '../utils/error';
import { Logger } from '../utils/logger';

import { MessageTransport } from './MessageTransport';

export interface PollingTransportConfig {
  fetchMessage: () => Promise<MessageData | null>;
  pollingInterval?: number;
}

export class PollingTransport implements MessageTransport {
  private logger = Logger.getInstance();
  private errorHandler = ErrorHandler.getInstance();

  private isRunning = false;
  private stopRequested = false;
  private messageCallback: ((message: MessageData) => void) | null = null;

  constructor(private config: PollingTransportConfig) {}

  onMessage(callback: (message: MessageData) => void): void {
    this.messageCallback = callback;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Polling transport already running');
      return;
    }

    this.isRunning = true;
    this.stopRequested = false;
    this.logger.info('Starting polling transport');

    await this.poll();
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping polling transport');
    this.stopRequested = true;
    this.isRunning = false;
  }

  private async poll(): Promise<void> {
    if (this.stopRequested) {
      this.isRunning = false;
      return;
    }

    try {
      const message = await this.config.fetchMessage();

      if (message && this.messageCallback) {
        this.messageCallback(message);
      }
    } catch (error) {
      this.errorHandler.handleError(error, 'PollingTransport.poll');
    }

    const interval = this.config.pollingInterval || 1000;
    setTimeout(() => this.poll(), interval);
  }
}
