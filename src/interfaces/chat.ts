import { Bee } from '@ethersphere/bee-js';
import type { LightNode } from '@waku/sdk';

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
    waku?: WakuOptions;
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
  waku?: WakuOptions;
}

export interface WakuOptions {
  enabled: boolean;
  node?: LightNode;
}
