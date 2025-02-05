import { Signature } from 'ethers';

import { EthAddress } from './bee';

export interface User {
  username: string;
  address: EthAddress;
  timestamp: number;
  index: number;
  signature: Signature;
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
  address: EthAddress;
  entry: MessageEntry;
};

export type UserMap = Record<string, User>;

export type UserHistoryMap = Record<string, UserHistory>;

export interface ChatHistory {
  allTimeUsers: UserHistoryMap;
}
