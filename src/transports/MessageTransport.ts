import { MessageData } from '../interfaces';

export interface MessageTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(callback: (message: MessageData) => void): void;
}
