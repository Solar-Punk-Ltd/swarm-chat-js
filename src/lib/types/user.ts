export interface User {
  username: string;
  address: string;
  timestamp: number;
  index: number;
  signature: string;
}

export interface ChatHistoryEntry {
  id: number;
  ref: string;
  updater: string;
  timestamp: number;
}

export interface ChatEvent {
  type: string;
  timestamp: number;
}

export interface MessageEntry {
  index: number;
  timestamp: number;
}

export interface UserHistory {
  events: ChatEvent[];
  messageEntries: MessageEntry[];
}

export type UserMessageEntry = {
  address: string;
  entry: MessageEntry;
};

export type UserMap = Record<string, User>;

export type UserHistoryMap = Record<string, UserHistory>;

export interface ChatHistory {
  allTimeUsers: UserHistoryMap;
}
