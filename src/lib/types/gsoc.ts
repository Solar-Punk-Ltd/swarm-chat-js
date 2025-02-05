import { Bytes } from './bee';

export interface GsocSubscription {
  close: () => void;
  gsocAddress: Bytes<32>;
}
