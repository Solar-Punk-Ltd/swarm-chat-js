import { ChatHistoryEntry, User } from './user';

export interface MessageData {
  id: string;
  message: string;
  username: string;
  address: string;
  timestamp: number;
  index: number;
  topic: string;
}

export interface ChatMessage {
  messageSender: User;
  historyEntry: ChatHistoryEntry;
}
