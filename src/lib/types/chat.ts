import { Bees, EthAddress } from './bee';

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
