import type { WalletLink } from '../src/message';

/**
 * Wallet links made by the Swarm ID fork itself (solarpunk-id `lib` on its branch `feat/ens-wallet-link`, at 41d31a19d,
 * `buildWalletLinkMessage` and `countersignWalletLink` from its built entries, with the wallet's signature made by
 * viem's `signMessage` as a wallet's personal_sign makes it). The fork's own `verifyWalletLink` accepted each for its
 * account. The account is the fork's test account of `bindingVectors.ts`. Copied here as literals, since this library
 * never imports the fork.
 */

// Test only. The wallet's key, which nobody holds funds with.
export const LINK_WALLET_KEY = '33'.repeat(32);
export const LINK_WALLET = '0x5cbdd86a2fa8dc4bddd8a8f69dba48572eec07fb';

/** For FORK_ACCOUNT. Its wallet signature ends in v 28 and its account signature in v 27. */
export const WALLET_LINK: WalletLink = {
  msg: 'Swarm ID wallet link v1\nAccount: 0x1563915e194d8cfba1943570603f7606a3115508\nWallet: 0x5cbdd86a2fa8dc4bddd8a8f69dba48572eec07fb\nDate: 2026-10-15T12:00:00.000Z',
  wsig: '0x68c6dc5476b8f7253e73ba610f548c335469f27eb8beb91a271d14d47420887e1c76bf541c4b89d848940ac507e39895c3bf2383f1e12edbdc0066418bb7d9911c',
  asig: '0x059fd1d185a10eff432916329661aa406be00f19046787de0a4e31e1ae954c7744cb825729eecae51101371aff4ff18f9591ac7274d3cb45b1ec5d21feadaa881b',
};

/** For FORK_ACCOUNT two minutes later, kept because its v bytes are the other way round. */
export const WALLET_LINK_FLIPPED_V: WalletLink = {
  msg: 'Swarm ID wallet link v1\nAccount: 0x1563915e194d8cfba1943570603f7606a3115508\nWallet: 0x5cbdd86a2fa8dc4bddd8a8f69dba48572eec07fb\nDate: 2026-10-15T12:02:00.000Z',
  wsig: '0x97e6d81a9f8824062ee19a906f7b4fe3a37b1af45ec2d0ba43bf26cc4d023a56060eaef0173e165238c08d405fc47c6328e48543bb88760f76004e124fd4702c1b',
  asig: '0x6b5ede462eb4a33d9b09d926beb9f6e03cb4777de5817c317469b32816eb417e49acc62f9cc78cfa22507b2c12b166fae140589972202665e27fb7f05edf46591c',
};

// Test only. Another account's key, which nobody holds funds with.
export const OTHER_LINK_ACCOUNT_KEY = '44'.repeat(32);
export const OTHER_LINK_ACCOUNT = '0x7564105e977516c53be337314c7e53838967bdac';

/** The same wallet linked to OTHER_LINK_ACCOUNT, a valid link of another account. */
export const OTHER_ACCOUNT_WALLET_LINK: WalletLink = {
  msg: 'Swarm ID wallet link v1\nAccount: 0x7564105e977516c53be337314c7e53838967bdac\nWallet: 0x5cbdd86a2fa8dc4bddd8a8f69dba48572eec07fb\nDate: 2026-10-15T12:00:00.000Z',
  wsig: '0xaf4ead4624d47f04a820a5642967edca4509db0c3ac8de36833ccd1648a2b1ce585f4ce50e14ccbca0e4ed5a527635e06b693e831345e42bccafd64cf749a86f1b',
  asig: '0x604cc2bd2421d539a7326808d6c7f76db61c832b765ba330c4af36bfb92c1b9b4e0c9cd04772643f108e42d36af160c4db296618b927e40aec03951569a1ba421c',
};
