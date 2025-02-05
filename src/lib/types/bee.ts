import { BatchId, Bee } from '@ethersphere/bee-js';
import { HexString } from '@solarpunkltd/gsoc/dist/types';

import { ETH_ADDRESS_LENGTH } from '../constants';

export interface Bytes<Length extends number> extends Uint8Array {
  readonly length: Length;
}

export type EthAddress = HexString<typeof ETH_ADDRESS_LENGTH>;

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
