import { EthAddress } from './bee';
import { ChatHistoryEntry, User } from './user';

export interface MessageData {
  id: string;
  message: string;
  username: string;
  address: EthAddress;
  timestamp: number;
}

export interface VisibleMessage extends MessageData {
  error: boolean;
  sent: boolean;
}

export interface GsocMessage {
  messageSender: User;
  historyEntry: ChatHistoryEntry;
}
