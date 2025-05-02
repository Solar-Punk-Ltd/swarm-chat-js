import { AnchorProvider, Program } from '@coral-xyz/anchor';
import { Connection, Keypair } from '@solana/web3.js';
import { Contract, ethers, JsonRpcProvider, WebSocketProvider } from 'ethers';

import evmAbi from '../../ABI/SwarmEventEmitter.json';
import { SwarmEventEmitter as SvmTypes } from '../../IDL/SwarmEventEmitter';
import svmIdl from '../../IDL/SwarmEventEmitter.json';
import { remove0x } from '../utils/common';

import { ChatSettingsChain } from './types';

export class SwarmEventEmitterReader {
  private evm: {
    provider: JsonRpcProvider | WebSocketProvider;
    contract: Contract;
  } | null = null;

  private svm: {
    provider: Connection;
    program: Program<SvmTypes>;
    listenerId?: number;
  } | null = null;

  constructor(private settings: ChatSettingsChain) {
    this.init();
  }

  private init() {
    if (this.settings.chainType === 'EVM') {
      this.initEvm();
    } else if (this.settings.chainType === 'SVM') {
      this.initSvm();
    }
  }

  private initEvm() {
    const { rpcUrl, contractAddress } = this.settings;

    if (!contractAddress) {
      throw new Error('Contract address is required for EVM chain type');
    }

    const provider = rpcUrl.startsWith('ws')
      ? new ethers.WebSocketProvider(rpcUrl)
      : new ethers.JsonRpcProvider(rpcUrl);

    const contract = new ethers.Contract(contractAddress, evmAbi.abi, provider);
    this.evm = { provider, contract };
  }

  private initSvm() {
    const provider = new Connection(this.settings.rpcUrl, 'confirmed');
    const dummyKeypair = Keypair.generate();
    const wallet = {
      signTransaction: async (tx: any) => tx,
      signAllTransactions: async (txs: any[]) => txs,
      publicKey: dummyKeypair.publicKey,
    };
    const anchorProvider = new AnchorProvider(provider, wallet, {});
    const program = new Program<SvmTypes>(svmIdl, anchorProvider);

    this.svm = { provider, program };
  }

  public async onMessageFrom(topic: string, callback: (sender: string, message: string) => void) {
    if (this.settings.chainType === 'EVM') {
      this.listenToEvm(topic, callback);
    } else if (this.settings.chainType === 'SVM') {
      await this.listenToSvm(topic, callback);
    }
  }

  private listenToEvm(topic: string, callback: (sender: string, message: string) => void) {
    this.evm?.contract.on('MessageLogged', (sender: string, message: string) => {
      const [t, _index] = message.split('_');
      if (remove0x(sender.toLowerCase()) === remove0x(this.settings.swarmEmitterAddress.toLowerCase()) && t === topic) {
        callback(sender, message);
      }
    });
  }

  private async listenToSvm(topic: string, callback: (sender: string, message: string) => void) {
    const listenerId = this.svm?.program.addEventListener('messageLogged', (event) => {
      const { sender, message } = event;
      const [t, _index] = message.split('_');

      if (sender.toBase58() === this.settings.swarmEmitterAddress && t === topic) {
        callback(sender.toBase58(), message);
      }
    });

    if (this.svm && listenerId !== undefined) {
      this.svm.listenerId = listenerId;
    }
  }

  public async removeAllListeners() {
    if (this.settings.chainType === 'EVM') {
      this.evm?.contract.removeAllListeners('MessageLogged');
    }
    if (this.settings.chainType === 'SVM' && this.svm?.listenerId !== undefined) {
      await this.svm.program.removeEventListener(this.svm.listenerId);
      this.svm.listenerId = undefined;
    }
  }
}
