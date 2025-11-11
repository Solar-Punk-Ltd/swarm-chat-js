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
    pollingInterval?: number;
    enableFallbackPolling?: boolean;
    feedReadTimeout?: number;
    gsocWriteTimeout?: number;
    socReadTimeout?: number;
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
  feedReadTimeout: number;
  gsocWriteTimeout: number;
  socReadTimeout: number;
}
