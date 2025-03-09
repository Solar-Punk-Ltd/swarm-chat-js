import { ChatHistoryEntry, User } from './user';

export interface MessageData {
  id: string;
  message: string;
  username: string;
  address: string;
  timestamp: number;
  index: number;
}

export interface GsocMessage {
  messageSender: User;
  historyEntry: ChatHistoryEntry;
}
