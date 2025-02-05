import { Bytes } from './bee';

export interface GsocSubscription {
  ws: any; // TODO
  gsocAddress: Bytes<32>;
}
