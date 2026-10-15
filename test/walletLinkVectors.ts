import type { WalletLink } from '../src/message';

/**
 * Wallet links made by the Swarm ID fork itself (solarpunk-id `lib` on its branch `feat/ens-wallet-link`, at 995f7389e,
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
  msg: 'Swarm ID wallet link v1\nI link this wallet to the Swarm ID account below, so sites may show my ENS name beside its messages.\nAccount: 0x1563915e194d8cfba1943570603f7606a3115508\nWallet: 0x5cbdd86a2fa8dc4bddd8a8f69dba48572eec07fb\nDate: 2026-10-15T12:01:00.000Z',
  wsig: '0x8375ed13f2afa0b70f62f94f82012f52022028620fbdc90ea073990a1fbb23e03aa67b6d49b84651f4b1096c9106d25a971407dc02d3663ec1a1a65500a520ae1c',
  asig: '0x8b253d455123dfb0a00c4ad56e0e65fffbb99850efcbe3fea85e2583034b3d8605e83f895c80e29eda6ff9ef481f3ad9090fad20d37508a6b29462ad9e2562891b',
};

/** For FORK_ACCOUNT three minutes later, kept because its v bytes are the other way round. */
export const WALLET_LINK_FLIPPED_V: WalletLink = {
  msg: 'Swarm ID wallet link v1\nI link this wallet to the Swarm ID account below, so sites may show my ENS name beside its messages.\nAccount: 0x1563915e194d8cfba1943570603f7606a3115508\nWallet: 0x5cbdd86a2fa8dc4bddd8a8f69dba48572eec07fb\nDate: 2026-10-15T12:04:00.000Z',
  wsig: '0x7561cec0eab3008ad3e10a933bb65ecdc62b9ad9446e1c78ba022ec08ac4a2c75927000fe2d495f4bab1c09928f5723f9f8ee998005f2d6fcce89b7f6b8988fe1b',
  asig: '0xc0b0b6a48d41fe2033476a1cc46ead7b54f6bb85cde0108052b51c02d526c03a0dc71a8e12b4e396ce4bf4c927d3befa58cf048100f962bd48c86d927ac103a61c',
};

// Test only. Another account's key, which nobody holds funds with.
export const OTHER_LINK_ACCOUNT_KEY = '44'.repeat(32);
export const OTHER_LINK_ACCOUNT = '0x7564105e977516c53be337314c7e53838967bdac';

/** The same wallet linked to OTHER_LINK_ACCOUNT, a valid link of another account. */
export const OTHER_ACCOUNT_WALLET_LINK: WalletLink = {
  msg: 'Swarm ID wallet link v1\nI link this wallet to the Swarm ID account below, so sites may show my ENS name beside its messages.\nAccount: 0x7564105e977516c53be337314c7e53838967bdac\nWallet: 0x5cbdd86a2fa8dc4bddd8a8f69dba48572eec07fb\nDate: 2026-10-15T12:00:00.000Z',
  wsig: '0x630a8fb5315c0bd61bf7699390c981681c5b2a5754c015c28e5fc76d7f1c38d30041e06fa1567c9f730fc9864446385e1e023c1b3a2433f38bd4c14266aba6071b',
  asig: '0xdeec1f70d884d3906ad38cb8bdae39ef14603c0087433a556a80829ac76a82d50d9a6abcef8695a3a3238362e8526899985adf5debb3e2f0666762726d56db541b',
};
