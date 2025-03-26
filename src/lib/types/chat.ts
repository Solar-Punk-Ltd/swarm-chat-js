import { Bees } from './bee';

export type ChainType = 'EVM' | 'SVM';

export interface ChatSettings {
  user: {
    privateKey: string;
    nickname: string;
  };
  infra: {
    bees: Bees;
    chain: {
      rpcUrl: string;
      contractAddress?: string;
      chainType: ChainType;
      swarmEmitterAddress: string;
    };
    gsoc: {
      gsocTopic: string;
      gsocResourceId: string;
      chatTopic: string;
      chatAddress: string;
    };
  };
  options: {
    fetchMessageIntervalTime: number;
    idleUserCleanupIntervalTime: number;
    readMessageTimeout: number;
  };
}
