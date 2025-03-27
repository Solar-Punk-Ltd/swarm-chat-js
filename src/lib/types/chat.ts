import { Bee } from '@ethersphere/bee-js';

export type ChainType = 'EVM' | 'SVM';

export interface ChatSettings {
  user: {
    privateKey: string;
    nickname: string;
  };
  infra: {
    swarm: {
      rpcUrl: string;
      stamp: string;
      gsocTopic: string;
      gsocResourceId: string;
      chatTopic: string;
      chatAddress: string;
    };
    chain: {
      rpcUrl: string;
      contractAddress?: string;
      chainType: ChainType;
      swarmEmitterAddress: string;
    };
  };
  options?: {
    fetchMessageIntervalTime: number;
    idleUserCleanupIntervalTime: number;
    readMessageTimeout: number;
  };
}

export interface ChatSettingsChain {
  rpcUrl: string;
  contractAddress?: string;
  chainType: ChainType;
  swarmEmitterAddress: string;
}
export interface ChatOptions {
  fetchMessageTimer: NodeJS.Timeout | null;
  idleUserCleanupInterval: NodeJS.Timeout | null;
  FETCH_MESSAGE_INTERVAL_TIME: number;
  IDLE_USER_CLEANUP_INTERVAL_TIME: number;
  READ_MESSAGE_TIMEOUT: number;
}

export interface ChatSettingsUser {
  privateKey: string;
  ownAddress: string;
  nickname: string;
  ownIndex: number;
}

export interface ChatSettingsSwarm {
  bee: Bee;
  stamp: string;
  gsocTopic: string;
  gsocResourceId: string;
  chatTopic: string;
  chatAddress: string;
}
