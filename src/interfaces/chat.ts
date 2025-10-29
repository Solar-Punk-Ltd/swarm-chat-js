import { Bee } from '@ethersphere/bee-js';

export interface ChatSettings {
  user: {
    privateKey: string;
    nickname: string;
  };
  infra: {
    beeUrl: string;
    enveloped: boolean;
    stamp?: string;
    gsocTopic: string;
    gsocResourceId: string;
    chatTopic: string;
    chatAddress: string;
    enableFallbackPolling?: boolean;
    fallbackPollingInterval?: number;
  };
}

export interface ChatSettingsUser {
  privateKey: string;
  ownAddress: string;
  nickname: string;
  ownIndex: number;
}

export interface ChatSettingsSwarm {
  bee: Bee;
  beeUrl: string;
  stamp: string;
  enveloped: boolean;
  gsocTopic: string;
  gsocResourceId: string;
  chatTopic: string;
  chatAddress: string;
}
