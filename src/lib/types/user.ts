export interface User {
  username: string;
  address: string;
  timestamp: number;
  index: number;
  signature: string;
}

export interface ChatEvent {
  type: string;
  timestamp: number;
}

export interface MessageEntry {
  index: number;
  timestamp: number;
}

export type UserMessageEntry = {
  address: string;
  entry: MessageEntry;
};

export type UserMap = Record<string, User>;
