import { BatchId, Bee } from '@ethersphere/bee-js';
import { HexString } from '@solarpunkltd/gsoc/dist/types';
import { Signature } from 'ethers';

import { ETH_ADDRESS_LENGTH } from './constants';

export interface Bytes<Length extends number> extends Uint8Array {
  readonly length: Length;
}

export interface GsocSubscribtion {
  close: () => void;
  gsocAddress: Bytes<32>;
}

export type EthAddress = HexString<typeof ETH_ADDRESS_LENGTH>;

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

export interface User {
  username: string;
  address: EthAddress;
  timestamp: number;
  index: number;
  signature: Signature;
}

export interface ValidationSchema {
  [key: string]: 'string' | 'number' | ValidationSchema | ValidationSchema[];
}

export interface ChatHistoryEntry {
  id: number;
  ref: string;
  updater: string;
  timestamp: number;
}

export interface GsocMessage {
  messageSender: User;
  historyEntry: ChatHistoryEntry;
}

// WIP
export interface ChatEvent {
  type: string;
  timestamp: any;
}

export interface MessageEntry {
  index: number;
  timestamp: number;
}

export interface UserHistory {
  events: ChatEvent[];
  messageEntries: MessageEntry[];
}

export type UserMap = Record<string, User>;

export type UserHistoryMap = Record<string, UserHistory>;

export interface ChatHistory {
  allTimeUsers: UserHistoryMap;
}

export enum BeeType {
  READER = 'reader',
  WRITER = 'writer',
  GSOC = 'gsoc',
}
export interface BeeSettings {
  url: string;
  stamp?: BatchId;
  main?: boolean;
}

export interface BeeSelectionSettings {
  singleBee?: BeeSettings;
  multiBees?: BeeSettings[];
}

export interface MultiBees {
  gsoc: BeeSelectionSettings;
  reader?: BeeSelectionSettings;
  writer?: BeeSelectionSettings;
}

export interface Bees {
  singleBee?: BeeSettings;
  multiBees?: MultiBees;
}
export interface InitializedBee {
  bee: Bee;
  stamp?: BatchId;
  main?: boolean;
}

export interface InitializedBees {
  single?: InitializedBee;
  gsoc?: InitializedBee | InitializedBee[];
  reader?: InitializedBee | InitializedBee[];
  writer?: InitializedBee | InitializedBee[];
}

export interface ChatSettings {
  ownAddress: EthAddress;
  privateKey: string;
  nickname: string;
  topic: string;
  gsocResourceId: string;
  bees: Bees;
  fetchMessageIntervalTime?: number;
  idleUserCleanupIntervalTime?: number;
  readMessageTimeout?: number;
}
