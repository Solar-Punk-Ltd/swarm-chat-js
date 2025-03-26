import { Bees } from './bee';

export type ChainType = 'EVM' | 'SVM';

export interface ChatSettings {
  ownAddress: string;
  privateKey: string;
  nickname: string;
  gsocTopic: string;
  gsocResourceId: string;
  bees: Bees;
  rpcUrl: string;
  contractAddress: string;
  swarmEmitterAddress: string;
  chatTopic: string;
  chainType: ChainType;
  fetchMessageIntervalTime?: number;
  idleUserCleanupIntervalTime?: number;
  readMessageTimeout?: number;
}
